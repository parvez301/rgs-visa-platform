import { LEDGER_PROJECTED_ATTRIBUTES, parseLedgerRow } from "@rgs/api/src/domain/crm/ledger";
import { isRealIsoDate } from "@rgs/api/src/domain/crm/ledgerPostgres";
import { META_SORT_KEY, caseStatusGsi1Pk, partnerListGsi1Pk } from "@rgs/api/src/domain/crm/keys";
import type { TableClient } from "@rgs/api/src/lib/db";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import {
  collectReadableRecords,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "@rgs/api/src/lib/storedRecords";
import { crm } from "@rgs/shared";

export interface BackfillCrmLedgerResult {
  partnersUpserted: number;
  casesUpserted: number;
  unreadableCaseIds: string[];
  /** Partner META items that would not parse; named, never inserted. */
  unreadablePartnerIds: string[];
}

export interface BackfillCrmLedgerOptions {
  table: TableClient;
  sql: SqlClient;
  tenantId: string;
  /** Called once per upserted case so a large run is not silent. */
  onProgress?: (casesUpserted: number) => void;
}

const UPSERT_PARTNER_SQL = `
insert into crm_partners (
  tenant_id, partner_id, canonical_name, canonical_key, partner_type, aliases,
  contact_phone, contact_email, contact_whatsapp, notes, created_at,
  created_by_email, updated_at
) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::timestamptz, $12, $11::timestamptz)
on conflict (tenant_id, partner_id) do update set
  canonical_name = excluded.canonical_name,
  canonical_key = excluded.canonical_key,
  partner_type = excluded.partner_type,
  aliases = excluded.aliases,
  contact_phone = excluded.contact_phone,
  contact_email = excluded.contact_email,
  contact_whatsapp = excluded.contact_whatsapp,
  notes = excluded.notes,
  created_at = excluded.created_at,
  created_by_email = excluded.created_by_email,
  updated_at = excluded.updated_at
`;

const UPSERT_CASE_SQL = `
insert into crm_cases (
  tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
  visa_type, group_name, case_status, billing_status, received_date,
  appointment_date, expected_collection_date, total_inr, updated_at,
  applicant_summary, search_text
) values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
)
on conflict (tenant_id, case_id) do update set
  case_ref = excluded.case_ref,
  partner_id = excluded.partner_id,
  destination_country = excluded.destination_country,
  case_type = excluded.case_type,
  visa_type = excluded.visa_type,
  group_name = excluded.group_name,
  case_status = excluded.case_status,
  billing_status = excluded.billing_status,
  received_date = excluded.received_date,
  appointment_date = excluded.appointment_date,
  expected_collection_date = excluded.expected_collection_date,
  total_inr = excluded.total_inr,
  updated_at = excluded.updated_at,
  applicant_summary = excluded.applicant_summary,
  search_text = excluded.search_text
`;

/** Postgres `integer` ceiling; `crm_cases.total_inr` is `integer`. */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/**
 * `LedgerRowSchema` only regex-checks dates and bounds `totalInr` below by
 * zero, so a row can parse and still be unwritable: "2026-02-30" fails the
 * `date` cast and a huge total overflows `integer`. Either would abort the
 * whole run with a raw Postgres error against a half-populated table, so they
 * are caught here and the case is named instead.
 */
function describeUnwritableCase(row: crm.LedgerRow): string | undefined {
  const dateFields: Array<[string, string | undefined]> = [
    ["receivedDate", row.receivedDate],
    ["appointmentDate", row.appointmentDate],
    ["expectedCollectionDate", row.expectedCollectionDate],
  ];
  for (const [fieldName, value] of dateFields) {
    if (value !== undefined && !isRealIsoDate(value)) {
      return `${fieldName} "${value}" is not a real calendar date`;
    }
  }
  if (row.totalInr > POSTGRES_INTEGER_MAX) {
    return `totalInr ${row.totalInr} exceeds the Postgres integer column`;
  }
  return undefined;
}

/**
 * Copies the Dynamo CRM ledger projections (partner META items and case META
 * items) into Postgres. Re-runnable: both upserts are keyed on the table's
 * primary key and overwrite every projected column, so a second run neither
 * duplicates nor leaves a stale row behind.
 *
 * Cases are read exactly as the Ledger read model reads them -- one GSI1
 * partition per status, projected META attributes only, parsed through the
 * same `parseLedgerRow` -- so a row the Ledger could not show is a row this
 * names in `unreadableCaseIds` rather than inserts.
 */
export async function backfillCrmLedgerToPostgres(
  options: BackfillCrmLedgerOptions,
): Promise<BackfillCrmLedgerResult> {
  const { table, sql, tenantId } = options;
  const result: BackfillCrmLedgerResult = {
    partnersUpserted: 0,
    casesUpserted: 0,
    unreadableCaseIds: [],
    unreadablePartnerIds: [],
  };

  const partnerItems = await table.queryGsi("GSI1", partnerListGsi1Pk(tenantId));
  const partnerCollection = await collectReadableRecords(
    partnerItems.filter((item) => item.SK === META_SORT_KEY),
    (partnerItem) =>
      parseStoredRecord(
        crm.PartnerSchema,
        "Partner",
        storedRecordId(partnerItem, "partnerId"),
        stripStorageKeys(partnerItem),
      ),
    { entityDescription: "CRM partner", scopeDescription: `tenant ${tenantId}` },
  );
  result.unreadablePartnerIds.push(...partnerCollection.unreadableRecordIds);
  for (const partner of partnerCollection.records) {
    await sql.query(UPSERT_PARTNER_SQL, [
      tenantId,
      partner.partnerId,
      partner.canonicalName,
      crm.normalizePartnerName(partner.canonicalName).canonicalKey,
      partner.partnerType,
      JSON.stringify(partner.aliases),
      partner.contactPhone ?? null,
      partner.contactEmail ?? null,
      partner.contactWhatsapp ?? null,
      partner.notes ?? null,
      partner.createdAt,
      partner.createdByEmail ?? null,
    ]);
    result.partnersUpserted += 1;
  }

  for (const caseStatus of crm.CASE_STATUSES) {
    const caseItems = await table.queryGsi("GSI1", caseStatusGsi1Pk(tenantId, caseStatus), {
      projection: LEDGER_PROJECTED_ATTRIBUTES,
    });
    const caseCollection = await collectReadableRecords(
      caseItems.filter((item) => item.SK === META_SORT_KEY),
      parseLedgerRow,
      { entityDescription: "CRM ledger row", scopeDescription: `tenant ${tenantId}` },
    );
    result.unreadableCaseIds.push(...caseCollection.unreadableRecordIds);
    for (const ledgerRow of caseCollection.records) {
      const unwritableReason = describeUnwritableCase(ledgerRow);
      if (unwritableReason !== undefined) {
        console.warn(
          `Skipping CRM case ${ledgerRow.caseId} in tenant ${tenantId}: ${unwritableReason}`,
        );
        result.unreadableCaseIds.push(ledgerRow.caseId);
        continue;
      }
      await sql.query(UPSERT_CASE_SQL, [
        tenantId,
        ledgerRow.caseId,
        ledgerRow.caseRef,
        ledgerRow.partnerId,
        ledgerRow.destinationCountry,
        ledgerRow.caseType,
        ledgerRow.visaType ?? null,
        ledgerRow.groupName ?? null,
        ledgerRow.caseStatus,
        ledgerRow.billingStatus,
        ledgerRow.receivedDate,
        ledgerRow.appointmentDate ?? null,
        ledgerRow.expectedCollectionDate ?? null,
        ledgerRow.totalInr,
        ledgerRow.updatedAt,
        ledgerRow.applicantSummary === undefined
          ? null
          : JSON.stringify(ledgerRow.applicantSummary),
        ledgerRow.searchText ?? null,
      ]);
      result.casesUpserted += 1;
      options.onProgress?.(result.casesUpserted);
    }
  }

  return result;
}
