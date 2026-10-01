import type { SqlClient } from "../../lib/sql";
import { isoTimestampSql, type DbRow } from "../../lib/sqlColumns";
import type { RefClaim } from "./refClaims";

/**
 * Postgres storage for REF claims (`crm_ref_claims`, migration 002). The
 * primary key (tenant_id, ref_key) is the uniqueness rule: `insert ... on
 * conflict do nothing` is the conditional put, and it is atomic in the
 * database rather than check-then-write.
 */

/** `true` when this call created the claim, `false` when one already existed. */
export async function insertRefClaimIfAbsentPostgres(
  sql: SqlClient,
  refClaim: RefClaim,
): Promise<boolean> {
  const result = await sql.query(
    `insert into crm_ref_claims (tenant_id, ref_key, ref_value, case_id, claimed_at)
     values ($1, $2, $3, $4, $5::timestamptz)
     on conflict (tenant_id, ref_key) do nothing
     returning ref_key`,
    [refClaim.tenantId, refClaim.refKey, refClaim.refValue, refClaim.caseId, refClaim.claimedAt],
  );
  return result.rows.length > 0;
}

export async function readRefClaimPostgres(
  sql: SqlClient,
  tenantId: string,
  refKey: string,
): Promise<RefClaim | undefined> {
  const result = await sql.query<DbRow>(
    `select tenant_id, ref_key, ref_value, case_id,
            ${isoTimestampSql("claimed_at")} as claimed_at
       from crm_ref_claims
      where tenant_id = $1 and ref_key = $2`,
    [tenantId, refKey],
  );
  const claimRow = result.rows[0];
  if (claimRow === undefined) return undefined;
  return {
    tenantId: String(claimRow["tenant_id"]),
    refKey: String(claimRow["ref_key"]),
    refValue: String(claimRow["ref_value"]),
    caseId: String(claimRow["case_id"]),
    claimedAt: String(claimRow["claimed_at"]),
  };
}

/** Deletes the claim only while `caseId` still owns it. */
export async function deleteRefClaimPostgres(
  sql: SqlClient,
  tenantId: string,
  refKey: string,
  caseId: string,
): Promise<void> {
  await sql.query(
    `delete from crm_ref_claims where tenant_id = $1 and ref_key = $2 and case_id = $3`,
    [tenantId, refKey, caseId],
  );
}
