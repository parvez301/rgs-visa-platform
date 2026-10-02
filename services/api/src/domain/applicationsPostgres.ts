import { ApplicationSchema, type Application } from "@rgs/shared";
import { corruptRecord } from "../lib/errors";
import type { SqlClient } from "../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  jsonOrNull,
  orNull,
  type DbRow,
} from "../lib/sqlColumns";
import { collectReadableRecords, describeFirstZodIssue } from "../lib/storedRecords";

/**
 * Postgres storage for portal visa applications (`portal_applications`,
 * migration 006). Rows parse through the same `ApplicationSchema` as the
 * Dynamo path, and a row that will not parse is a `CorruptRecordError` that
 * listings skip and name, exactly as the Dynamo listings do.
 */

const APPLICATION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["applicationId", "application_id"],
  ["userId", "user_id"],
  ["countryCode", "country_code"],
  ["productCode", "product_code"],
  ["status", "status"],
  ["stepReached", "step_reached"],
  ["travellers", "travellers"],
  ["essentials", "essentials"],
  ["amounts", "amounts"],
  ["paymentStatus", "payment_status"],
  ["internalNotes", "internal_notes"],
  ["visaResultKey", "visa_result_key"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
];

const SELECT_APPLICATION_SQL = `select application_id, user_id, country_code, product_code,
            status, step_reached, travellers, essentials, amounts, payment_status,
            internal_notes, visa_result_key,
            ${isoTimestampSql("created_at")} as created_at,
            ${isoTimestampSql("updated_at")} as updated_at
       from portal_applications`;

function rowToApplication(applicationRow: DbRow): Application {
  const parsed = ApplicationSchema.safeParse(
    candidateFromColumns(applicationRow, APPLICATION_COLUMNS),
  );
  if (parsed.success) return parsed.data;
  throw corruptRecord(
    "Application",
    String(applicationRow["application_id"] ?? "an unidentifiable row"),
    describeFirstZodIssue(parsed.error),
  );
}

export interface ApplicationPostgresListing {
  applications: Application[];
  unreadableApplicationIds: string[];
}

async function readListing(
  sql: SqlClient,
  whereClause: string,
  values: unknown[],
  limit?: number,
): Promise<ApplicationPostgresListing> {
  const limitClause = limit === undefined ? "" : ` limit ${Math.max(0, Math.floor(limit))}`;
  const result = await sql.query<DbRow>(
    `${SELECT_APPLICATION_SQL}
      where ${whereClause}
      order by updated_at desc, application_id desc${limitClause}`,
    values,
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    rowToApplication,
    { entityDescription: "application" },
  );
  return { applications: records, unreadableApplicationIds: unreadableRecordIds };
}

/** An upsert on the primary key. The caller has already validated the application. */
export async function upsertApplicationPostgres(
  sql: SqlClient,
  application: Application,
): Promise<void> {
  await sql.query(
    `insert into portal_applications (
       application_id, user_id, country_code, product_code, status, step_reached,
       travellers, essentials, amounts, payment_status, internal_notes,
       visa_result_key, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
               $11::jsonb, $12, $13::timestamptz, $14::timestamptz)
     on conflict (application_id) do update set
       user_id = excluded.user_id,
       country_code = excluded.country_code,
       product_code = excluded.product_code,
       status = excluded.status,
       step_reached = excluded.step_reached,
       travellers = excluded.travellers,
       essentials = excluded.essentials,
       amounts = excluded.amounts,
       payment_status = excluded.payment_status,
       internal_notes = excluded.internal_notes,
       visa_result_key = excluded.visa_result_key,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      application.applicationId,
      application.userId,
      application.countryCode,
      application.productCode,
      application.status,
      application.stepReached,
      JSON.stringify(application.travellers),
      jsonOrNull(application.essentials),
      JSON.stringify(application.amounts),
      application.paymentStatus,
      JSON.stringify(application.internalNotes),
      orNull(application.visaResultKey),
      application.createdAt,
      application.updatedAt,
    ],
  );
}

export async function getApplicationPostgres(
  sql: SqlClient,
  applicationId: string,
): Promise<Application | undefined> {
  const result = await sql.query<DbRow>(
    `${SELECT_APPLICATION_SQL} where application_id = $1`,
    [applicationId],
  );
  const applicationRow = result.rows[0];
  return applicationRow === undefined ? undefined : rowToApplication(applicationRow);
}

/** The applicant's own applications, newest first; unreadable rows are named. */
export function listApplicationsByUserPostgres(
  sql: SqlClient,
  userId: string,
): Promise<ApplicationPostgresListing> {
  return readListing(sql, "user_id = $1", [userId]);
}

/** The ops work queue for one status, newest `updated_at` first. */
export function listApplicationsByStatusPostgres(
  sql: SqlClient,
  status: string,
  limit?: number,
): Promise<ApplicationPostgresListing> {
  return readListing(sql, "status = $1", [status], limit);
}
