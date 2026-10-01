import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";
import { collectReadableRecords, parseStoredRecord } from "../../lib/storedRecords";

/**
 * Postgres storage for agent/desk memory (`crm_memories`, migration 004),
 * primary key `(tenant_id, scope, memory_key)`. Rows are parsed through the
 * same `crm.CrmMemorySchema` as the Dynamo path, so a row that breaks the
 * provenance refinement is a `CorruptRecordError` either way and a listing
 * names it in `unreadableMemoryKeys` instead of failing the recall.
 */

const MEMORY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["scope", "scope"],
  ["memoryKey", "memory_key"],
  ["text", "text"],
  ["sourceCaseId", "source_case_id"],
  ["createdBy", "created_by"],
  ["createdAt", "created_at"],
  ["createdByEmail", "created_by_email"],
];

const SELECT_MEMORY_SQL = `
select
  tenant_id, scope, memory_key, text, source_case_id, created_by,
  ${isoTimestampSql("created_at")} as created_at,
  created_by_email
from crm_memories
where tenant_id = $1 and scope = $2`;

function parseMemoryRow(dbRow: DbRow): crm.CrmMemory {
  return parseStoredRecord(
    crm.CrmMemorySchema,
    "CRM memory",
    String(dbRow["memory_key"]),
    candidateFromColumns(dbRow, MEMORY_COLUMNS),
  );
}

/**
 * An upsert on the primary key: re-remembering a key overwrites the row in
 * place, exactly as the Dynamo `put` does. The caller has already validated
 * the memory.
 */
export async function upsertMemoryPostgres(sql: SqlClient, memory: crm.CrmMemory): Promise<void> {
  await sql.query(
    `insert into crm_memories (
       tenant_id, scope, memory_key, text, source_case_id, created_by,
       created_at, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
     on conflict (tenant_id, scope, memory_key) do update set
       text = excluded.text,
       source_case_id = excluded.source_case_id,
       created_by = excluded.created_by,
       created_at = excluded.created_at,
       created_by_email = excluded.created_by_email`,
    [
      memory.tenantId,
      memory.scope,
      memory.memoryKey,
      memory.text,
      orNull(memory.sourceCaseId),
      memory.createdBy,
      memory.createdAt,
      orNull(memory.createdByEmail),
    ],
  );
}

/** `undefined` when absent; throws `CorruptRecordError` when the row will not parse. */
export async function getMemoryPostgres(
  sql: SqlClient,
  tenantId: string,
  scope: string,
  memoryKey: string,
): Promise<crm.CrmMemory | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_MEMORY_SQL} and memory_key = $3`, [
    tenantId,
    scope,
    memoryKey,
  ]);
  const memoryRow = result.rows[0];
  return memoryRow === undefined ? undefined : parseMemoryRow(memoryRow);
}

/** Whether a row exists, parseable or not -- deleting a corrupt row must not need it readable. */
export async function memoryRowExistsPostgres(
  sql: SqlClient,
  tenantId: string,
  scope: string,
  memoryKey: string,
): Promise<boolean> {
  const result = await sql.query<DbRow>(
    `select 1 as present from crm_memories
      where tenant_id = $1 and scope = $2 and memory_key = $3`,
    [tenantId, scope, memoryKey],
  );
  return result.rows.length > 0;
}

/** One scope, `memory_key` ascending (the order the Dynamo sort key gave), capped at `limit`. */
export async function listMemoriesByScopePostgres(
  sql: SqlClient,
  tenantId: string,
  scope: string,
  limit: number,
): Promise<{ memories: crm.CrmMemory[]; unreadableMemoryKeys: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_MEMORY_SQL} order by memory_key limit $3`,
    [tenantId, scope, limit],
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    parseMemoryRow,
    { entityDescription: "CRM memory", scopeDescription: `tenant ${tenantId} scope ${scope}` },
  );
  return { memories: records, unreadableMemoryKeys: unreadableRecordIds };
}

/** Whether a row was actually removed; a missing key is simply `false`. */
export async function deleteMemoryPostgres(
  sql: SqlClient,
  tenantId: string,
  scope: string,
  memoryKey: string,
): Promise<boolean> {
  const result = await sql.query(
    `delete from crm_memories where tenant_id = $1 and scope = $2 and memory_key = $3`,
    [tenantId, scope, memoryKey],
  );
  return result.rowCount > 0;
}
