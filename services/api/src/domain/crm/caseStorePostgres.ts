import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoDateSql,
  isoTimestampSql,
  jsonOrNull,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";
import { badRequest, CorruptRecordError } from "../../lib/errors";
import { isRealIsoDate } from "../../lib/isoDate";
import { parseStoredRecord } from "../../lib/storedRecords";

/**
 * Postgres storage for a CRM case: one `crm_cases` row plus one
 * `crm_applicants` row per applicant. Same contract as the Dynamo path in
 * `caseStore.ts` -- the domain shape (`CrmCase`, applicants embedded) in and
 * out, `applicantSummary` and `searchText` computed here and never accepted
 * from a caller.
 */

/**
 * Resolves the Ledger `searchText` for a case about to be written. A caller
 * may supply its own; the default (what `caseStore.writeCase` uses under
 * `CRM_STORE=postgres`) reads names from `crm_travellers` and falls back to
 * the applicant's own passport number, mirroring `resolveLedgerSearchText`.
 */
export type SearchTextResolver = (
  applicants: readonly crm.CaseApplicant[],
  extraTerms: readonly string[],
) => Promise<string | undefined>;

export interface WriteCasePostgresOptions {
  searchTextResolver?: SearchTextResolver;
}

async function resolveSearchTextFromPostgres(
  sql: SqlClient,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
  extraTerms: readonly string[],
): Promise<string | undefined> {
  const travellerIds = [...new Set(applicants.map((applicant) => applicant.travellerId))];
  const travellerRows = await sql.query<{
    traveller_id: string;
    full_name: string;
    passport_number: string | null;
  }>(
    `select traveller_id, full_name, passport_number
       from crm_travellers
      where tenant_id = $1 and traveller_id = any($2::text[])`,
    [tenantId, travellerIds],
  );
  const travellersById = new Map(travellerRows.rows.map((row) => [row.traveller_id, row]));
  const searchParts = applicants.map((applicant) => {
    const traveller = travellersById.get(applicant.travellerId);
    if (traveller === undefined) return { passportNumber: applicant.passportNumber };
    return {
      fullName: traveller.full_name,
      passportNumber: traveller.passport_number ?? applicant.passportNumber,
    };
  });
  return crm.buildLedgerSearchText(searchParts, extraTerms);
}

const UPSERT_CASE_SQL = `
insert into crm_cases (
  tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
  visa_type, entry_type, processing, validity, group_name, case_status,
  billing_status, received_date, submission_date, appointment_date,
  appointment_reminder_sent_for, expected_collection_date, courier_date,
  remarks, client_email, line_items, total_inr, document_checklist,
  watchdog_overrides, muted_rules, snoozed_until, source_sheet, source_row,
  legacy_raw, created_at, updated_at, created_by_email, applicant_summary,
  search_text
) values (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11, $12,
  $13, $14::date, $15::date, $16::date,
  $17::date, $18::date, $19::date,
  $20, $21, $22::jsonb, $23, $24::jsonb,
  $25::jsonb, $26::jsonb, $27::timestamptz, $28, $29,
  $30::jsonb, $31::timestamptz, $32::timestamptz, $33, $34::jsonb,
  $35
)
on conflict (tenant_id, case_id) do update set
  case_ref = excluded.case_ref,
  partner_id = excluded.partner_id,
  destination_country = excluded.destination_country,
  case_type = excluded.case_type,
  visa_type = excluded.visa_type,
  entry_type = excluded.entry_type,
  processing = excluded.processing,
  validity = excluded.validity,
  group_name = excluded.group_name,
  case_status = excluded.case_status,
  billing_status = excluded.billing_status,
  received_date = excluded.received_date,
  submission_date = excluded.submission_date,
  appointment_date = excluded.appointment_date,
  appointment_reminder_sent_for = excluded.appointment_reminder_sent_for,
  expected_collection_date = excluded.expected_collection_date,
  courier_date = excluded.courier_date,
  remarks = excluded.remarks,
  client_email = excluded.client_email,
  line_items = excluded.line_items,
  total_inr = excluded.total_inr,
  document_checklist = excluded.document_checklist,
  watchdog_overrides = excluded.watchdog_overrides,
  muted_rules = excluded.muted_rules,
  snoozed_until = excluded.snoozed_until,
  source_sheet = excluded.source_sheet,
  source_row = excluded.source_row,
  legacy_raw = excluded.legacy_raw,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  created_by_email = excluded.created_by_email,
  applicant_summary = excluded.applicant_summary,
  search_text = excluded.search_text`;

const INSERT_APPLICANT_SQL = `
insert into crm_applicants (
  tenant_id, case_id, applicant_index, applicant_ref, ref_no, traveller_id,
  passport_number, custody, custody_since, outcome, courier_mode,
  tracking_number, visa_result_key
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12, $13)`;

/** Every date column `writeCasePostgres` casts through `::date`. */
const CASE_DATE_FIELDS = [
  "receivedDate",
  "submissionDate",
  "appointmentDate",
  "appointmentReminderSentFor",
  "expectedCollectionDate",
  "courierDate",
] as const;

/**
 * The calendar-day check the Dynamo path never needed (it stores strings):
 * `2026-02-30` matches the schema's pattern but Postgres' `::date` refuses it
 * with SQLSTATE 22008, which would surface as a bare 500. A 400 that names the
 * case and field is what the caller (or the backfill's report) can act on.
 */
function assertRealCaseDates(crmCase: crm.CrmCase): void {
  for (const fieldName of CASE_DATE_FIELDS) {
    const value = crmCase[fieldName];
    if (value !== undefined && !isRealIsoDate(value)) {
      throw badRequest(
        `Case ${crmCase.caseId}: ${fieldName} "${value}" is not a real calendar date (YYYY-MM-DD)`,
      );
    }
  }
}

export async function writeCasePostgres(
  sql: SqlClient,
  crmCase: crm.CrmCase,
  options: WriteCasePostgresOptions = {},
): Promise<void> {
  const { applicants } = crmCase;
  assertRealCaseDates(crmCase);
  const extraTerms = crmCase.groupName === undefined ? [] : [crmCase.groupName];
  // Resolved before BEGIN: nothing but writes should sit inside the transaction.
  const searchText =
    options.searchTextResolver !== undefined
      ? await options.searchTextResolver(applicants, extraTerms)
      : await resolveSearchTextFromPostgres(sql, crmCase.tenantId, applicants, extraTerms);

  // One dedicated connection for BEGIN..COMMIT: see SqlClient.transaction.
  await sql.transaction(async (tx) => {
    await tx.query(UPSERT_CASE_SQL, [
      crmCase.tenantId,
      crmCase.caseId,
      crmCase.caseRef,
      crmCase.partnerId,
      crmCase.destinationCountry,
      crmCase.caseType,
      orNull(crmCase.visaType),
      orNull(crmCase.entryType),
      orNull(crmCase.processing),
      orNull(crmCase.validity),
      orNull(crmCase.groupName),
      crmCase.caseStatus,
      crmCase.billingStatus,
      crmCase.receivedDate,
      orNull(crmCase.submissionDate),
      orNull(crmCase.appointmentDate),
      orNull(crmCase.appointmentReminderSentFor),
      orNull(crmCase.expectedCollectionDate),
      orNull(crmCase.courierDate),
      orNull(crmCase.remarks),
      orNull(crmCase.clientEmail),
      JSON.stringify(crmCase.lineItems),
      crmCase.totalInr,
      JSON.stringify(crmCase.documentChecklist),
      JSON.stringify(crmCase.watchdogOverrides),
      JSON.stringify(crmCase.mutedRules),
      orNull(crmCase.snoozedUntil),
      orNull(crmCase.sourceSheet),
      orNull(crmCase.sourceRow),
      jsonOrNull(crmCase.legacyRaw),
      crmCase.createdAt,
      crmCase.updatedAt,
      orNull(crmCase.createdByEmail),
      // Computed here and nowhere else, like the Dynamo path: a caller-built
      // case can never persist a roll-up that disagrees with its applicants.
      JSON.stringify(crm.summariseApplicants(applicants)),
      orNull(searchText),
    ]);

    // Replace the applicant set rather than upserting by index. The
    // (case_id, applicant_ref) unique key is checked row by row, so an upsert
    // that shifts refs between indexes (an applicant removed from the middle)
    // collides with a row it has not yet rewritten. Delete-then-insert inside
    // the transaction also drops ghost applicants beyond the new count.
    await tx.query(`delete from crm_applicants where tenant_id = $1 and case_id = $2`, [
      crmCase.tenantId,
      crmCase.caseId,
    ]);
    for (const [applicantIndex, applicant] of applicants.entries()) {
      await tx.query(INSERT_APPLICANT_SQL, [
        crmCase.tenantId,
        crmCase.caseId,
        applicantIndex,
        applicant.applicantRef,
        orNull(applicant.refNo),
        applicant.travellerId,
        orNull(applicant.passportNumber),
        applicant.custody,
        orNull(applicant.custodySince),
        applicant.outcome,
        orNull(applicant.courierMode),
        orNull(applicant.trackingNumber),
        orNull(applicant.visaResultKey),
      ]);
    }
  });
}

const CASE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["caseId", "case_id"],
  ["caseRef", "case_ref"],
  ["partnerId", "partner_id"],
  ["destinationCountry", "destination_country"],
  ["caseType", "case_type"],
  ["visaType", "visa_type"],
  ["entryType", "entry_type"],
  ["processing", "processing"],
  ["validity", "validity"],
  ["groupName", "group_name"],
  ["caseStatus", "case_status"],
  ["billingStatus", "billing_status"],
  ["receivedDate", "received_date"],
  ["submissionDate", "submission_date"],
  ["appointmentDate", "appointment_date"],
  ["appointmentReminderSentFor", "appointment_reminder_sent_for"],
  ["expectedCollectionDate", "expected_collection_date"],
  ["courierDate", "courier_date"],
  ["remarks", "remarks"],
  ["clientEmail", "client_email"],
  ["lineItems", "line_items"],
  ["totalInr", "total_inr"],
  ["documentChecklist", "document_checklist"],
  ["watchdogOverrides", "watchdog_overrides"],
  ["mutedRules", "muted_rules"],
  ["snoozedUntil", "snoozed_until"],
  ["sourceSheet", "source_sheet"],
  ["sourceRow", "source_row"],
  ["legacyRaw", "legacy_raw"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
  ["createdByEmail", "created_by_email"],
];

const APPLICANT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["applicantRef", "applicant_ref"],
  ["refNo", "ref_no"],
  ["travellerId", "traveller_id"],
  ["passportNumber", "passport_number"],
  ["custody", "custody"],
  ["custodySince", "custody_since"],
  ["outcome", "outcome"],
  ["courierMode", "courier_mode"],
  ["trackingNumber", "tracking_number"],
  ["visaResultKey", "visa_result_key"],
];

const SELECT_CASE_SQL = `
select
  tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
  visa_type, entry_type, processing, validity, group_name, case_status,
  billing_status,
  ${isoDateSql("received_date")} as received_date,
  ${isoDateSql("submission_date")} as submission_date,
  ${isoDateSql("appointment_date")} as appointment_date,
  ${isoDateSql("appointment_reminder_sent_for")} as appointment_reminder_sent_for,
  ${isoDateSql("expected_collection_date")} as expected_collection_date,
  ${isoDateSql("courier_date")} as courier_date,
  remarks, client_email, line_items, total_inr, document_checklist,
  watchdog_overrides, muted_rules,
  ${isoTimestampSql("snoozed_until")} as snoozed_until,
  source_sheet, source_row, legacy_raw,
  -- Phase A rows (migration 001 only) have no created_at: fall back to updated_at.
  ${isoTimestampSql("coalesce(created_at, updated_at)")} as created_at,
  ${isoTimestampSql("updated_at")} as updated_at,
  created_by_email
from crm_cases
where tenant_id = $1 and case_id = $2`;

const SELECT_APPLICANTS_SQL = `
select
  applicant_ref, ref_no, traveller_id, passport_number, custody,
  ${isoTimestampSql("custody_since")} as custody_since,
  outcome, courier_mode, tracking_number, visa_result_key
from crm_applicants
where tenant_id = $1 and case_id = $2
order by applicant_index`;

export async function readCasePostgres(
  sql: SqlClient,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase | undefined> {
  const caseResult = await sql.query<DbRow>(SELECT_CASE_SQL, [tenantId, caseId]);
  const caseRow = caseResult.rows[0];
  if (caseRow === undefined) return undefined;

  const applicantResult = await sql.query<DbRow>(SELECT_APPLICANTS_SQL, [tenantId, caseId]);

  // A case row with no applicant rows parses as CorruptRecordError (the schema
  // demands at least one applicant), exactly as a META-only Dynamo partition.
  return parseStoredRecord(crm.CrmCaseSchema, "Case", caseId, {
    ...candidateFromColumns(caseRow, CASE_COLUMNS),
    applicants: applicantResult.rows.map((applicantRow) =>
      candidateFromColumns(applicantRow, APPLICANT_COLUMNS),
    ),
  });
}

/** Largest id list one batched statement carries (the export cap is 500). */
const READ_CASES_BATCH_SIZE = 500;

const SELECT_CASES_BATCH_SQL = SELECT_CASE_SQL.replace(
  "where tenant_id = $1 and case_id = $2",
  "where tenant_id = $1 and case_id = any($2::text[])",
);

const SELECT_APPLICANTS_BATCH_SQL = `
select
  case_id, applicant_ref, ref_no, traveller_id, passport_number, custody,
  ${isoTimestampSql("custody_since")} as custody_since,
  outcome, courier_mode, tracking_number, visa_result_key
from crm_applicants
where tenant_id = $1 and case_id = any($2::text[])
order by case_id, applicant_index`;

export interface ReadCasesPostgresResult {
  /** Readable cases by id. An id that is absent here is either missing or in `unreadableCaseIds`. */
  cases: Map<string, crm.CrmCase>;
  /** Rows that exist but fail `CrmCaseSchema` (or have no applicants), like `CorruptRecordError` on the single read. */
  unreadableCaseIds: string[];
}

/**
 * Many cases in a constant number of round-trips: one `crm_cases` query and one
 * `crm_applicants` query per batch of up to 500 ids, assembled in memory.
 * `readCasePostgres` costs two queries per case, which on the one-connection
 * pool makes a 500-case export ~1,000 sequential round-trips.
 *
 * Same contract as `readCasePostgres` per case; unlike it, a corrupt row does
 * not throw -- it is named in `unreadableCaseIds` so one bad row cannot sink a
 * batch.
 */
export async function readCasesPostgres(
  sql: SqlClient,
  tenantId: string,
  caseIds: readonly string[],
): Promise<ReadCasesPostgresResult> {
  const cases = new Map<string, crm.CrmCase>();
  const unreadableCaseIds: string[] = [];
  const distinctCaseIds = [...new Set(caseIds)];
  for (let batchStart = 0; batchStart < distinctCaseIds.length; batchStart += READ_CASES_BATCH_SIZE) {
    const batchIds = distinctCaseIds.slice(batchStart, batchStart + READ_CASES_BATCH_SIZE);
    const caseResult = await sql.query<DbRow>(SELECT_CASES_BATCH_SQL, [tenantId, batchIds]);
    if (caseResult.rows.length === 0) continue;
    const applicantResult = await sql.query<DbRow>(SELECT_APPLICANTS_BATCH_SQL, [tenantId, batchIds]);
    const applicantsByCaseId = new Map<string, Record<string, unknown>[]>();
    for (const applicantRow of applicantResult.rows) {
      const caseId = String(applicantRow["case_id"]);
      const caseApplicants = applicantsByCaseId.get(caseId) ?? [];
      caseApplicants.push(candidateFromColumns(applicantRow, APPLICANT_COLUMNS));
      applicantsByCaseId.set(caseId, caseApplicants);
    }
    for (const caseRow of caseResult.rows) {
      const caseId = String(caseRow["case_id"]);
      try {
        cases.set(
          caseId,
          parseStoredRecord(crm.CrmCaseSchema, "Case", caseId, {
            ...candidateFromColumns(caseRow, CASE_COLUMNS),
            applicants: applicantsByCaseId.get(caseId) ?? [],
          }),
        );
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        unreadableCaseIds.push(caseId);
      }
    }
  }
  return { cases, unreadableCaseIds };
}
