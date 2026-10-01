import type { crm } from "@rgs/shared";
import { badRequest } from "../../lib/errors";
import { isRealIsoDate } from "../../lib/isoDate";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoDateSql,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";

/**
 * Postgres storage for CRM travellers (`crm_travellers`, migration 002).
 *
 * Passport uniqueness is a partial unique index on (tenant_id, passport_number)
 * -- the database refuses a second holder, so two concurrent upserts of one
 * passport cannot both win the way two Dynamo `put`s could. Rows come back as
 * candidates for `crm.CrmTravellerSchema`; `travellers.ts` parses them.
 */

const TRAVELLER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["travellerId", "traveller_id"],
  ["fullName", "full_name"],
  ["normalizedName", "normalized_name"],
  ["dateOfBirth", "date_of_birth"],
  ["phone", "phone"],
  ["passportNumber", "passport_number"],
  ["createdAt", "created_at"],
];

const SELECT_TRAVELLER_SQL = `
select
  tenant_id, traveller_id, full_name, normalized_name,
  ${isoDateSql("date_of_birth")} as date_of_birth,
  phone, passport_number,
  ${isoTimestampSql("created_at")} as created_at
from crm_travellers
where tenant_id = $1`;

async function selectOneTraveller(
  sql: SqlClient,
  condition: string,
  values: readonly unknown[],
): Promise<Record<string, unknown> | undefined> {
  const result = await sql.query<DbRow>(
    `${SELECT_TRAVELLER_SQL} and ${condition} order by traveller_id limit 1`,
    values,
  );
  const travellerRow = result.rows[0];
  return travellerRow === undefined ? undefined : candidateFromColumns(travellerRow, TRAVELLER_COLUMNS);
}

export async function findTravellerByPassportPostgres(
  sql: SqlClient,
  tenantId: string,
  passportNumber: string,
): Promise<Record<string, unknown> | undefined> {
  return selectOneTraveller(sql, "passport_number = $2", [tenantId, passportNumber]);
}

/** Earliest match by traveller id, like GSI2's sort key. Names are not unique. */
export async function findTravellerByNamePostgres(
  sql: SqlClient,
  tenantId: string,
  normalizedName: string,
): Promise<Record<string, unknown> | undefined> {
  return selectOneTraveller(sql, "normalized_name = $2", [tenantId, normalizedName]);
}

export async function getTravellerPostgres(
  sql: SqlClient,
  tenantId: string,
  travellerId: string,
): Promise<Record<string, unknown> | undefined> {
  return selectOneTraveller(sql, "traveller_id = $2", [tenantId, travellerId]);
}

/** Several travellers in ONE round-trip (`traveller_id = any(...)`), keyed by id. */
export async function getTravellersByIdPostgres(
  sql: SqlClient,
  tenantId: string,
  travellerIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const travellersById = new Map<string, Record<string, unknown>>();
  if (travellerIds.length === 0) return travellersById;
  const result = await sql.query<DbRow>(
    `${SELECT_TRAVELLER_SQL} and traveller_id = any($2::text[])`,
    [tenantId, [...travellerIds]],
  );
  for (const travellerRow of result.rows) {
    travellersById.set(String(travellerRow["traveller_id"]), candidateFromColumns(travellerRow, TRAVELLER_COLUMNS));
  }
  return travellersById;
}

/**
 * `false` when the passport already belongs to another traveller (the unique
 * index refused it) -- the caller re-reads the winner. Never throws for that.
 */
export async function insertTravellerPostgres(
  sql: SqlClient,
  traveller: crm.CrmTraveller,
): Promise<boolean> {
  if (traveller.dateOfBirth !== undefined && !isRealIsoDate(traveller.dateOfBirth)) {
    throw badRequest(
      `Traveller ${traveller.travellerId}: dateOfBirth "${traveller.dateOfBirth}" is not a real calendar date (YYYY-MM-DD)`,
    );
  }
  const result = await sql.query(
    `insert into crm_travellers (
       tenant_id, traveller_id, full_name, normalized_name, date_of_birth,
       phone, passport_number, created_at
     ) values ($1, $2, $3, $4, $5::date, $6, $7, $8::timestamptz)
     on conflict (tenant_id, passport_number) where passport_number is not null
     do nothing
     returning traveller_id`,
    [
      traveller.tenantId,
      traveller.travellerId,
      traveller.fullName,
      traveller.normalizedName,
      orNull(traveller.dateOfBirth),
      orNull(traveller.phone),
      orNull(traveller.passportNumber),
      traveller.createdAt,
    ],
  );
  return result.rows.length > 0;
}

/**
 * Rewrites name and passport. A passport another traveller holds raises the
 * unique violation (SQLSTATE 23505); the caller turns it into a 409.
 */
export async function updateTravellerDetailsPostgres(
  sql: SqlClient,
  traveller: crm.CrmTraveller,
): Promise<void> {
  await sql.query(
    `update crm_travellers
        set full_name = $3, normalized_name = $4, passport_number = $5
      where tenant_id = $1 and traveller_id = $2`,
    [
      traveller.tenantId,
      traveller.travellerId,
      traveller.fullName,
      traveller.normalizedName,
      orNull(traveller.passportNumber),
    ],
  );
}
