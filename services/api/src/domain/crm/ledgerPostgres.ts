import { createHash } from "node:crypto";
import { crm } from "@rgs/shared";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { isRealIsoDate } from "../../lib/isoDate";
import type { SqlClient } from "../../lib/sql";
import { collectReadableRecords, parseStoredRecord } from "../../lib/storedRecords";
import { MAX_LEDGER_PAGE_LIMIT, type LedgerPage } from "./ledger";

/**
 * The Ledger read model served from Postgres (`crm_cases` + `crm_partners`).
 *
 * One `LedgerPage` (see `ledger.ts`), the
 * same 400s for a cursor that cannot be read or was issued for another
 * filter, unreadable rows named rather than dropped -- but every filter is a
 * WHERE clause, so filters combine in one query.
 *
 * Order is `received_date DESC, case_id DESC`: a total order, so a keyset
 * cursor on that pair never skips or repeats a row between pages.
 */

export interface PostgresLedgerQuery {
  /** Empty = no status filter. */
  statuses: crm.CaseStatus[];
  partnerId?: string;
  destinationCountry?: string;
  caseType?: crm.CaseType;
  billingStatuses?: crm.BillingStatus[];
  /** YYYY-MM-DD */
  appointmentDateOn?: string;
  /** YYYY-MM-DD */
  expectedCollectionDateOn?: string;
  /** Substring match on case ref, search text, or partner name; case-insensitive. */
  search?: string;
  limit: number;
  cursor?: string;
}

export { isRealIsoDate };

const PostgresLedgerCursorSchema = z.object({
  v: z.literal(1),
  scopeKey: z.string().min(1),
  receivedDate: z.string().refine(isRealIsoDate),
  caseId: z.string().min(1),
});
type PostgresLedgerCursor = z.infer<typeof PostgresLedgerCursorSchema>;

/** Filters after canonicalization: what the WHERE clause and scopeKey are built from. */
interface NormalizedFilters {
  statuses: string[];
  partnerId?: string;
  destinationCountry?: string;
  caseType?: string;
  billingStatuses: string[];
  appointmentDateOn?: string;
  expectedCollectionDateOn?: string;
  search?: string;
}

function requireIsoDate(value: string, filterName: string): string {
  if (!isRealIsoDate(value)) {
    throw badRequest(`${filterName} must be a real YYYY-MM-DD date`);
  }
  return value;
}

function normalizeFilters(query: PostgresLedgerQuery): NormalizedFilters {
  const trimmedSearch = query.search?.trim().toLowerCase();
  return {
    statuses: [...new Set(query.statuses)].sort(),
    billingStatuses: [...new Set(query.billingStatuses ?? [])].sort(),
    ...(query.partnerId !== undefined ? { partnerId: query.partnerId } : {}),
    ...(query.destinationCountry !== undefined
      ? { destinationCountry: query.destinationCountry.trim().toUpperCase() }
      : {}),
    ...(query.caseType !== undefined ? { caseType: query.caseType } : {}),
    ...(query.appointmentDateOn !== undefined
      ? { appointmentDateOn: requireIsoDate(query.appointmentDateOn, "appointmentDateOn") }
      : {}),
    ...(query.expectedCollectionDateOn !== undefined
      ? {
          expectedCollectionDateOn: requireIsoDate(
            query.expectedCollectionDateOn,
            "expectedCollectionDateOn",
          ),
        }
      : {}),
    ...(trimmedSearch !== undefined && trimmedSearch.length > 0 ? { search: trimmedSearch } : {}),
  };
}

/**
 * A hash of the normalized filters, so a cursor can only resume the list it
 * was issued for. Keys are written in a fixed order, so the same filters in
 * any caller order hash identically.
 */
function scopeKeyFor(filters: NormalizedFilters): string {
  const canonical = JSON.stringify([
    filters.statuses,
    filters.partnerId ?? null,
    filters.destinationCountry ?? null,
    filters.caseType ?? null,
    filters.billingStatuses,
    filters.appointmentDateOn ?? null,
    filters.expectedCollectionDateOn ?? null,
    filters.search ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function encodeCursor(cursor: PostgresLedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Same refusal as `ledger.ts`: a bad cursor is a 400, never a restart from row one. */
function decodeCursor(rawCursor: string, expectedScopeKey: string): PostgresLedgerCursor {
  let parsedCursor: PostgresLedgerCursor;
  try {
    parsedCursor = PostgresLedgerCursorSchema.parse(
      JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")),
    );
  } catch {
    throw badRequest("This ledger cursor could not be read");
  }
  if (parsedCursor.scopeKey !== expectedScopeKey) {
    throw badRequest(
      "This ledger cursor was issued for a different filter; start again from the first page",
    );
  }
  return parsedCursor;
}

/** Escapes LIKE metacharacters so a search for "50%" matches "50%" literally. */
function likePatternContaining(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

interface BuiltQuery {
  text: string;
  values: unknown[];
}

function buildQuery(
  tenantId: string,
  filters: NormalizedFilters,
  resumeFrom: PostgresLedgerCursor | undefined,
  fetchCount: number,
): BuiltQuery {
  const values: unknown[] = [tenantId];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions: string[] = ["c.tenant_id = $1"];

  if (filters.statuses.length > 0) {
    conditions.push(`c.case_status = any(${addValue(filters.statuses)}::text[])`);
  }
  if (filters.partnerId !== undefined) {
    conditions.push(`c.partner_id = ${addValue(filters.partnerId)}`);
  }
  if (filters.destinationCountry !== undefined) {
    conditions.push(`c.destination_country = ${addValue(filters.destinationCountry)}`);
  }
  if (filters.caseType !== undefined) {
    conditions.push(`c.case_type = ${addValue(filters.caseType)}`);
  }
  if (filters.billingStatuses.length > 0) {
    conditions.push(`c.billing_status = any(${addValue(filters.billingStatuses)}::text[])`);
  }
  if (filters.appointmentDateOn !== undefined) {
    conditions.push(`c.appointment_date = ${addValue(filters.appointmentDateOn)}::date`);
  }
  if (filters.expectedCollectionDateOn !== undefined) {
    conditions.push(
      `c.expected_collection_date = ${addValue(filters.expectedCollectionDateOn)}::date`,
    );
  }
  if (filters.search !== undefined) {
    const pattern = addValue(likePatternContaining(filters.search));
    conditions.push(
      `(c.case_ref ilike ${pattern} or c.search_text ilike ${pattern} or p.canonical_name ilike ${pattern})`,
    );
  }
  if (resumeFrom !== undefined) {
    const receivedDate = addValue(resumeFrom.receivedDate);
    const caseId = addValue(resumeFrom.caseId);
    conditions.push(`(c.received_date, c.case_id) < (${receivedDate}::date, ${caseId})`);
  }
  const limitPlaceholder = addValue(fetchCount);

  const text = `
select
  c.case_id,
  c.case_ref,
  c.partner_id,
  c.destination_country,
  c.case_type,
  c.visa_type,
  c.group_name,
  c.case_status,
  c.billing_status,
  to_char(c.received_date, 'YYYY-MM-DD') as received_date,
  to_char(c.appointment_date, 'YYYY-MM-DD') as appointment_date,
  to_char(c.expected_collection_date, 'YYYY-MM-DD') as expected_collection_date,
  c.total_inr,
  to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at,
  c.applicant_summary,
  c.search_text
from crm_cases c
left join crm_partners p
  on p.tenant_id = c.tenant_id and p.partner_id = c.partner_id
where ${conditions.join("\n  and ")}
order by c.received_date desc, c.case_id desc
limit ${limitPlaceholder}`;
  return { text, values };
}

type LedgerDbRow = Record<string, unknown>;

/** NULL columns become absent keys. */
function ledgerRowFromDb(dbRow: LedgerDbRow): crm.LedgerRow {
  const caseId = String(dbRow["case_id"]);
  const present = (value: unknown): value is NonNullable<unknown> =>
    value !== null && value !== undefined;
  const candidate: Record<string, unknown> = {
    caseId,
    caseRef: dbRow["case_ref"],
    partnerId: dbRow["partner_id"],
    destinationCountry: dbRow["destination_country"],
    caseType: dbRow["case_type"],
    caseStatus: dbRow["case_status"],
    billingStatus: dbRow["billing_status"],
    receivedDate: dbRow["received_date"],
    totalInr: dbRow["total_inr"],
    updatedAt: dbRow["updated_at"],
  };
  const optionalColumns: ReadonlyArray<readonly [string, string]> = [
    ["visaType", "visa_type"],
    ["groupName", "group_name"],
    ["appointmentDate", "appointment_date"],
    ["expectedCollectionDate", "expected_collection_date"],
    ["applicantSummary", "applicant_summary"],
    ["searchText", "search_text"],
  ];
  for (const [fieldName, columnName] of optionalColumns) {
    const columnValue = dbRow[columnName];
    if (present(columnValue)) candidate[fieldName] = columnValue;
  }
  return parseStoredRecord(crm.LedgerRowSchema, "Ledger row", caseId, candidate);
}

export async function listLedgerRowsFromPostgres(
  sql: SqlClient,
  tenantId: string,
  query: PostgresLedgerQuery,
): Promise<LedgerPage> {
  if (!Number.isInteger(query.limit) || query.limit < 1) {
    throw badRequest("limit must be a positive integer");
  }
  const pageLimit = Math.min(query.limit, MAX_LEDGER_PAGE_LIMIT);

  const filters = normalizeFilters(query);
  const scopeKey = scopeKeyFor(filters);
  const resumeFrom = query.cursor === undefined ? undefined : decodeCursor(query.cursor, scopeKey);

  // One extra row says whether another page exists, so the last page carries
  // no cursor and a client never makes an empty trailing request.
  const built = buildQuery(tenantId, filters, resumeFrom, pageLimit + 1);
  const result = await sql.query<LedgerDbRow>(built.text, built.values);

  const hasMore = result.rows.length > pageLimit;
  const pageRows = hasMore ? result.rows.slice(0, pageLimit) : result.rows;

  const { records, unreadableRecordIds } = await collectReadableRecords(pageRows, ledgerRowFromDb, {
    entityDescription: "CRM ledger row",
    scopeDescription: `tenant ${tenantId}`,
  });

  // The cursor is the last row the database returned, readable or not: an
  // unreadable last row must not make the next page repeat it.
  const lastDbRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastDbRow !== undefined
      ? encodeCursor({
          v: 1,
          scopeKey,
          receivedDate: String(lastDbRow["received_date"]),
          caseId: String(lastDbRow["case_id"]),
        })
      : undefined;

  return {
    rows: records,
    unreadableCaseIds: unreadableRecordIds,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}
