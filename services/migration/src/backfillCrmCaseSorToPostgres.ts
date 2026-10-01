import { applyMigrations } from "@rgs/api/src/db/migrate";
import { readCase } from "@rgs/api/src/domain/crm/caseStore";
import { writeCasePostgres } from "@rgs/api/src/domain/crm/caseStorePostgres";
import {
  EVENT_SORT_KEY_PREFIX,
  META_SORT_KEY,
  caseIdFromPartitionKey,
  caseStatusGsi1Pk,
  casePartitionKey,
  partnerListGsi1Pk,
  refClaimPartitionKey,
  travellerPartitionKey,
} from "@rgs/api/src/domain/crm/keys";
import { refKeysOfCase } from "@rgs/api/src/domain/crm/refClaims";
import type { AppContext } from "@rgs/api/src/lib/context";
import type { TableClient } from "@rgs/api/src/lib/db";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { isUniqueViolation, orNull } from "@rgs/api/src/lib/sqlColumns";
import {
  collectReadableRecords,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "@rgs/api/src/lib/storedRecords";
import { crm } from "@rgs/shared";
import { z } from "zod";
import { upsertPartnerRecord } from "./backfillCrmLedgerToPostgres";

export interface BackfillCrmCaseSorResult {
  partnersUpserted: number;
  travellersUpserted: number;
  casesUpserted: number;
  /** Events newly inserted; events already in Postgres are left alone. */
  eventsInserted: number;
  refClaimsUpserted: number;
  /** Partner META items that would not parse; named, never inserted. */
  unreadablePartnerIds: string[];
  /**
   * Cases not copied: META/applicants that would not reassemble, or a case
   * Postgres refuses (impossible date, overflowing total, a passport another
   * traveller already holds). Each is named with its reason in a warning.
   */
  unreadableCaseIds: string[];
  /** Travellers an applicant points at that are missing or would not parse. The case is still copied. */
  unreadableTravellerIds: string[];
  /** Event items that would not parse; named, never inserted. */
  unreadableEventIds: string[];
  /** Cases with a REF (or applicant REF NO) that has no claim item in Dynamo. */
  casesMissingRefClaims: string[];
}

export interface BackfillCrmCaseSorOptions {
  table: TableClient;
  sql: SqlClient;
  tenantId: string;
  /** Called once per copied case so a large run is not silent. */
  onProgress?: (casesUpserted: number) => void;
}

const UPSERT_TRAVELLER_SQL = `
insert into crm_travellers (
  tenant_id, traveller_id, full_name, normalized_name, date_of_birth,
  phone, passport_number, created_at
) values ($1, $2, $3, $4, $5::date, $6, $7, $8::timestamptz)
on conflict (tenant_id, traveller_id) do update set
  full_name = excluded.full_name,
  normalized_name = excluded.normalized_name,
  date_of_birth = excluded.date_of_birth,
  phone = excluded.phone,
  passport_number = excluded.passport_number,
  created_at = excluded.created_at
`;

const UPSERT_REF_CLAIM_SQL = `
insert into crm_ref_claims (tenant_id, ref_key, ref_value, case_id, claimed_at)
values ($1, $2, $3, $4, $5::timestamptz)
on conflict (tenant_id, ref_key) do update set
  ref_value = excluded.ref_value,
  case_id = excluded.case_id,
  claimed_at = excluded.claimed_at
`;

// Events are append-only history: a row already in Postgres is never rewritten,
// so a re-run after cutover cannot touch an event the live path recorded.
const INSERT_EVENT_SQL = `
insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
on conflict (tenant_id, event_id) do nothing
returning event_id
`;

const StoredEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  caseId: z.string().min(1),
  actorEmail: z.string(),
  meta: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  createdAt: z.string().datetime(),
});

const StoredRefClaimSchema = z.object({
  refValue: z.string().min(1),
  caseId: z.string().min(1),
  claimedAt: z.string().datetime(),
});

/**
 * SQLSTATE class 22 (data exception: impossible date, integer overflow) and
 * class 23 (integrity: a check or unique constraint). These are properties of
 * one record, so the case is named and the run goes on. Anything else -- a
 * dropped connection, a missing table -- is not about the record and aborts.
 */
function isRecordLevelDatabaseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlState = (error as { code?: unknown }).code;
  return typeof sqlState === "string" && (sqlState.startsWith("22") || sqlState.startsWith("23"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The context `readCase` needs to read the Dynamo item set. It only touches
 * `table` and `crmStore`; `crmStore` is pinned to "dynamo" so a `CRM_STORE`
 * left set to postgres in the operator's shell can never turn this into a
 * Postgres-to-Postgres no-op.
 */
function dynamoReadContext(table: TableClient): AppContext {
  return { table, crmStore: "dynamo" } as unknown as AppContext;
}

/** Case ids from the same per-status GSI1 partitions the Ledger backfill walks. */
async function listDynamoCaseIds(table: TableClient, tenantId: string): Promise<string[]> {
  const caseIds: string[] = [];
  for (const caseStatus of crm.CASE_STATUSES) {
    const caseItems = await table.queryGsi("GSI1", caseStatusGsi1Pk(tenantId, caseStatus), {
      projection: ["PK", "SK", "caseId"],
    });
    for (const caseItem of caseItems) {
      if (caseItem.SK !== META_SORT_KEY) continue;
      const caseIdFromBody = caseItem["caseId"];
      const caseId =
        typeof caseIdFromBody === "string" && caseIdFromBody.length > 0
          ? caseIdFromBody
          : caseIdFromPartitionKey(caseItem.PK);
      if (caseId !== undefined) caseIds.push(caseId);
    }
  }
  return caseIds;
}

/**
 * Copies the Dynamo CRM system of record into the Postgres tables
 * `CRM_STORE=postgres` reads: partners, then per case its travellers, the case
 * and applicants, its REF claims and its events.
 *
 * Serial by design: `createPgSqlClient` is a one-connection pool, and
 * `writeCasePostgres` wraps each case in BEGIN/COMMIT, so two cases in flight
 * would interleave their transactions on that connection.
 *
 * Re-runnable: partners, travellers, claims and cases are upserted on their
 * primary keys (a case's applicants are replaced with it); events are
 * insert-if-absent. A re-run therefore restores drift from Dynamo, and is only
 * safe before cutover -- afterwards Postgres holds newer partner/traveller/case
 * edits that a re-run would overwrite with Dynamo's stale copies.
 *
 * A record that cannot be copied is named in the result, never silently
 * dropped: cutover needs every `unreadable*` list empty.
 */
export async function backfillCrmCaseSorToPostgres(
  options: BackfillCrmCaseSorOptions,
): Promise<BackfillCrmCaseSorResult> {
  const { table, sql, tenantId } = options;
  const result: BackfillCrmCaseSorResult = {
    partnersUpserted: 0,
    travellersUpserted: 0,
    casesUpserted: 0,
    eventsInserted: 0,
    refClaimsUpserted: 0,
    unreadablePartnerIds: [],
    unreadableCaseIds: [],
    unreadableTravellerIds: [],
    unreadableEventIds: [],
    casesMissingRefClaims: [],
  };

  await applyMigrations(sql);

  await copyPartners(options, result);

  const dynamoContext = dynamoReadContext(table);
  // traveller id -> whether it is in Postgres. Resolved once per run.
  const travellerOutcomes = new Map<string, "copied" | "unreadable" | "passportClash">();

  for (const caseId of await listDynamoCaseIds(table, tenantId)) {
    let crmCase: crm.CrmCase | undefined;
    try {
      crmCase = await readCase(dynamoContext, tenantId, caseId);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      nameUnreadableCase(result, caseId, error.reason);
      continue;
    }
    if (crmCase === undefined) continue;

    const caseProblem = await copyCaseTravellers(options, result, travellerOutcomes, crmCase);
    if (caseProblem !== undefined) {
      nameUnreadableCase(result, caseId, caseProblem);
      continue;
    }

    try {
      // Travellers are in place, so the default searchText resolver (which
      // reads crm_travellers) sees every applicant's name.
      await writeCasePostgres(sql, crmCase);
    } catch (error) {
      if (!isRecordLevelDatabaseError(error)) throw error;
      nameUnreadableCase(result, caseId, `Postgres rejected it: ${describeError(error)}`);
      continue;
    }
    result.casesUpserted += 1;

    await copyRefClaims(options, result, crmCase);
    await copyEvents(options, result, caseId);
    options.onProgress?.(result.casesUpserted);
  }

  return result;
}

function nameUnreadableCase(result: BackfillCrmCaseSorResult, caseId: string, reason: string): void {
  result.unreadableCaseIds.push(caseId);
  console.warn(`Skipping CRM case ${caseId}: ${reason}`);
}

async function copyPartners(
  options: BackfillCrmCaseSorOptions,
  result: BackfillCrmCaseSorResult,
): Promise<void> {
  const { table, sql, tenantId } = options;
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
    await upsertPartnerRecord(sql, { ...partner, tenantId });
    result.partnersUpserted += 1;
  }
}

/**
 * Upserts every traveller the case's applicants point at. Returns a reason
 * when the case cannot be copied (a passport another traveller already holds
 * in Postgres), else `undefined`. A traveller that is missing or unparseable
 * in Dynamo is named but does not block the case: Dynamo has the same hole,
 * and copying it faithfully is what the cutover gate needs to see.
 */
async function copyCaseTravellers(
  options: BackfillCrmCaseSorOptions,
  result: BackfillCrmCaseSorResult,
  travellerOutcomes: Map<string, "copied" | "unreadable" | "passportClash">,
  crmCase: crm.CrmCase,
): Promise<string | undefined> {
  const { table, sql, tenantId } = options;
  for (const applicant of crmCase.applicants) {
    const { travellerId } = applicant;
    const knownOutcome = travellerOutcomes.get(travellerId);
    if (knownOutcome === "passportClash") {
      return `traveller ${travellerId}'s passport is held by another traveller in Postgres`;
    }
    if (knownOutcome !== undefined) continue;

    const travellerItem = await table.get(travellerPartitionKey(tenantId, travellerId), META_SORT_KEY, {
      consistentRead: true,
    });
    let traveller: crm.CrmTraveller;
    try {
      if (travellerItem === undefined) {
        throw new CorruptRecordError("Traveller", travellerId, "no traveller item exists");
      }
      traveller = parseStoredRecord(
        crm.CrmTravellerSchema,
        "Traveller",
        storedRecordId(travellerItem, "travellerId"),
        stripStorageKeys(travellerItem),
      );
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      travellerOutcomes.set(travellerId, "unreadable");
      result.unreadableTravellerIds.push(travellerId);
      console.warn(`Unreadable CRM traveller ${travellerId} (case ${crmCase.caseId}): ${error.reason}`);
      continue;
    }

    try {
      await sql.query(UPSERT_TRAVELLER_SQL, [
        tenantId,
        traveller.travellerId,
        traveller.fullName,
        traveller.normalizedName,
        orNull(traveller.dateOfBirth),
        orNull(traveller.phone),
        orNull(traveller.passportNumber),
        traveller.createdAt,
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Dynamo only ever checked passport uniqueness in the app, so legacy
        // data can hold one passport on two travellers. The partial unique
        // index refuses the second; a human has to merge or fix them.
        travellerOutcomes.set(travellerId, "passportClash");
        return `traveller ${travellerId}'s passport is held by another traveller in Postgres`;
      }
      if (!isRecordLevelDatabaseError(error)) throw error;
      travellerOutcomes.set(travellerId, "unreadable");
      result.unreadableTravellerIds.push(travellerId);
      console.warn(`Postgres rejected CRM traveller ${travellerId}: ${describeError(error)}`);
      continue;
    }
    travellerOutcomes.set(travellerId, "copied");
    result.travellersUpserted += 1;
  }
  return undefined;
}

/**
 * Copies the claim items Dynamo holds for this case's REF and applicant REF
 * NOs, exactly as they are -- including a claim another case holds (a legacy
 * duplicate), because that is who owns the REF today. Claims are not invented:
 * a REF with no claim item means `backfill:ref-claims` never swept this case,
 * and it is named so that gets run against Dynamo first.
 */
async function copyRefClaims(
  options: BackfillCrmCaseSorOptions,
  result: BackfillCrmCaseSorResult,
  crmCase: crm.CrmCase,
): Promise<void> {
  const { table, sql, tenantId } = options;
  let isMissingAClaim = false;
  for (const [refKey] of refKeysOfCase(crmCase)) {
    const claimItem = await table.get(refClaimPartitionKey(tenantId, refKey), META_SORT_KEY, {
      consistentRead: true,
    });
    const parsedClaim = StoredRefClaimSchema.safeParse(claimItem);
    if (!parsedClaim.success) {
      isMissingAClaim = true;
      continue;
    }
    await sql.query(UPSERT_REF_CLAIM_SQL, [
      tenantId,
      refKey,
      parsedClaim.data.refValue,
      parsedClaim.data.caseId,
      parsedClaim.data.claimedAt,
    ]);
    result.refClaimsUpserted += 1;
  }
  if (isMissingAClaim) result.casesMissingRefClaims.push(crmCase.caseId);
}

async function copyEvents(
  options: BackfillCrmCaseSorOptions,
  result: BackfillCrmCaseSorResult,
  caseId: string,
): Promise<void> {
  const { table, sql, tenantId } = options;
  const eventItems = await table.query(casePartitionKey(tenantId, caseId), {
    skPrefix: EVENT_SORT_KEY_PREFIX,
    consistentRead: true,
  });
  for (const eventItem of eventItems) {
    const parsedEvent = StoredEventSchema.safeParse(stripStorageKeys(eventItem));
    if (!parsedEvent.success) {
      const eventId = storedRecordId(eventItem, "eventId");
      result.unreadableEventIds.push(eventId);
      console.warn(`Unreadable CRM event ${eventId} (case ${caseId}): ${parsedEvent.error.issues[0]?.message}`);
      continue;
    }
    const { eventId, eventType, caseId: eventCaseId, actorEmail, meta, createdAt } = parsedEvent.data;
    const inserted = await sql.query(INSERT_EVENT_SQL, [
      tenantId,
      eventId,
      eventCaseId,
      eventType,
      actorEmail,
      JSON.stringify(meta),
      createdAt,
    ]);
    if (inserted.rows.length > 0) result.eventsInserted += 1;
  }
}
