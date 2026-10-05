import type { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import type { CaseCountByField, CaseCountGroupByField, CaseRefListing } from "./cases";

/**
 * Reads of `crm_cases` through `crm_cases_tenant_status_updated` and `crm_cases_tenant_partner_received`.
 * `case_id` breaks ties so a page is deterministic.
 */

/** `CaseCountGroupByField` -> `crm_cases` column. A closed map: no caller string reaches the SQL. */
const COUNT_COLUMN_BY_FIELD: Record<CaseCountGroupByField, string> = {
  caseStatus: "case_status",
  destinationCountry: "destination_country",
  billingStatus: "billing_status",
  partnerId: "partner_id",
};

export async function listCaseIdsByStatusPostgres(
  sql: SqlClient,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  limit: number,
): Promise<string[]> {
  const result = await sql.query<{ case_id: string }>(
    `select case_id from crm_cases
      where tenant_id = $1 and case_status = $2
      order by updated_at desc, case_id desc
      limit $3::int`,
    [tenantId, caseStatus, limit],
  );
  return result.rows.map((row) => row.case_id);
}

export async function listCaseIdsByPartnerPostgres(
  sql: SqlClient,
  tenantId: string,
  partnerId: string,
  limit: number,
): Promise<string[]> {
  const result = await sql.query<{ case_id: string }>(
    `select case_id from crm_cases
      where tenant_id = $1 and partner_id = $2
      order by received_date desc, case_id desc
      limit $3::int`,
    [tenantId, partnerId, limit],
  );
  return result.rows.map((row) => row.case_id);
}

/**
 * Counts every case in the tenant by one column without reading a single
 * applicant. A row whose counted column is null or empty is named in
 * `uncountedCaseIds`, the same skip-and-name rule.
 */
export async function countCasesByFieldPostgres(
  sql: SqlClient,
  tenantId: string,
  groupByField: CaseCountGroupByField,
): Promise<CaseCountByField> {
  const column = COUNT_COLUMN_BY_FIELD[groupByField];
  const grouped = await sql.query<{ value: string; count: number }>(
    `select ${column} as value, count(*)::int as count from crm_cases
      where tenant_id = $1 and ${column} is not null and ${column} <> ''
      group by ${column}`,
    [tenantId],
  );
  const uncounted = await sql.query<{ case_id: string }>(
    `select case_id from crm_cases
      where tenant_id = $1 and (${column} is null or ${column} = '')
      order by case_id`,
    [tenantId],
  );
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of grouped.rows) {
    counts[row.value] = row.count;
    total += row.count;
  }
  return { counts, total, uncountedCaseIds: uncounted.rows.map((row) => row.case_id) };
}

/**
 * The `caseRef`s stored under one case status straight off `crm_cases` -- no
 * applicant join, so a case row with no applicant rows still reports its ref
 * (an importer must know it already has it). `limit` omitted drains the status.
 */
export async function listCaseRefsByStatusPostgres(
  sql: SqlClient,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  limit?: number,
): Promise<CaseRefListing> {
  const result = await sql.query<{ case_id: string; case_ref: string | null }>(
    `select case_id, case_ref from crm_cases
      where tenant_id = $1 and case_status = $2
      order by updated_at desc, case_id desc
      limit $3::int`,
    [tenantId, caseStatus, limit ?? null],
  );
  const storedCaseRefs: CaseRefListing["storedCaseRefs"] = [];
  const unreadableCaseIds: string[] = [];
  for (const row of result.rows) {
    if (typeof row.case_ref === "string" && row.case_ref.length > 0) {
      storedCaseRefs.push({ caseRef: row.case_ref, caseId: row.case_id });
      continue;
    }
    unreadableCaseIds.push(row.case_id);
    console.warn(`CRM case row in tenant ${tenantId} carries no usable caseRef: ${row.case_id}`);
  }
  return { storedCaseRefs, unreadableCaseIds };
}
