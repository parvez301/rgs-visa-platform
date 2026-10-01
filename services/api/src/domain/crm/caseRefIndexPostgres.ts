import type { SqlClient } from "../../lib/sql";
import { isoTimestampSql, type DbRow } from "../../lib/sqlColumns";
import type { CaseRefReservation } from "./caseRefIndex";

/**
 * Postgres storage for case ref reservations (`crm_case_ref_reservations`,
 * migration 004), distinct from `crm_ref_claims`. Keyed on (tenant_id,
 * case_ref). A Postgres read is always strongly consistent, so the Dynamo
 * `ConsistentRead` concern does not apply. The reserve-before-write /
 * complete-after contract is unchanged: `writeCaseRefReservationPostgres`
 * is called once to reserve (no `completedAt`) and again to complete.
 */

export async function readCaseRefReservationPostgres(
  sql: SqlClient,
  tenantId: string,
  caseRef: string,
): Promise<CaseRefReservation | undefined> {
  const result = await sql.query<DbRow>(
    `select tenant_id, case_ref, case_id,
            ${isoTimestampSql("reserved_at")} as reserved_at,
            ${isoTimestampSql("completed_at")} as completed_at
       from crm_case_ref_reservations
      where tenant_id = $1 and case_ref = $2`,
    [tenantId, caseRef],
  );
  const reservationRow = result.rows[0];
  if (reservationRow === undefined) return undefined;
  const completedAt = reservationRow["completed_at"];
  return {
    tenantId: String(reservationRow["tenant_id"]),
    caseRef: String(reservationRow["case_ref"]),
    caseId: String(reservationRow["case_id"]),
    reservedAt: String(reservationRow["reserved_at"]),
    ...(completedAt === null || completedAt === undefined ? {} : { completedAt: String(completedAt) }),
  };
}

export async function writeCaseRefReservationPostgres(
  sql: SqlClient,
  reservation: CaseRefReservation,
): Promise<void> {
  await sql.query(
    `insert into crm_case_ref_reservations (tenant_id, case_ref, case_id, reserved_at, completed_at)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz)
     on conflict (tenant_id, case_ref) do update
       set case_id = excluded.case_id,
           reserved_at = excluded.reserved_at,
           completed_at = excluded.completed_at`,
    [
      reservation.tenantId,
      reservation.caseRef,
      reservation.caseId,
      reservation.reservedAt,
      reservation.completedAt ?? null,
    ],
  );
}
