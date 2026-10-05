import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import { candidateFromColumns, type DbRow } from "../../lib/sqlColumns";
import { parseStoredRecord } from "../../lib/storedRecords";

/**
 * Postgres storage for CRM user prefs (`crm_user_prefs`, migration 004),
 * primary key `(tenant_id, email)`. Rows are parsed through the same
 * `crm.CrmUserPrefsSchema` . `default_filters` is jsonb.
 */

const PREFS_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["email", "email"],
  ["trustLevel", "trust_level"],
  ["autoApplyOptIn", "auto_apply_opt_in"],
  ["defaultFilters", "default_filters"],
  ["confirmedWithoutEditCount", "confirmed_without_edit_count"],
];

/** `undefined` when the user has no row; throws `CorruptRecordError` when it will not parse. */
export async function readUserPrefsPostgres(
  sql: SqlClient,
  tenantId: string,
  email: string,
): Promise<crm.CrmUserPrefs | undefined> {
  const result = await sql.query<DbRow>(
    `select tenant_id, email, trust_level, auto_apply_opt_in, default_filters,
            confirmed_without_edit_count
       from crm_user_prefs
      where tenant_id = $1 and email = $2`,
    [tenantId, email],
  );
  const prefsRow = result.rows[0];
  if (prefsRow === undefined) return undefined;
  return parseStoredRecord(
    crm.CrmUserPrefsSchema,
    "CRM user prefs",
    String(prefsRow["email"]),
    candidateFromColumns(prefsRow, PREFS_COLUMNS),
  );
}

/** An upsert on the primary key. The caller has already validated the prefs. */
export async function writeUserPrefsPostgres(sql: SqlClient, prefs: crm.CrmUserPrefs): Promise<void> {
  await sql.query(
    `insert into crm_user_prefs (
       tenant_id, email, trust_level, auto_apply_opt_in, default_filters,
       confirmed_without_edit_count
     ) values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (tenant_id, email) do update set
       trust_level = excluded.trust_level,
       auto_apply_opt_in = excluded.auto_apply_opt_in,
       default_filters = excluded.default_filters,
       confirmed_without_edit_count = excluded.confirmed_without_edit_count`,
    [
      prefs.tenantId,
      prefs.email,
      prefs.trustLevel,
      prefs.autoApplyOptIn,
      JSON.stringify(prefs.defaultFilters),
      prefs.confirmedWithoutEditCount,
    ],
  );
}
