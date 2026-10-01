import type { SqlClient } from "../lib/sql.js";
import { MIGRATION_FILENAME, MIGRATION_SQL } from "./migrations/001_crm_ledger.js";

const MIGRATIONS: ReadonlyArray<{ filename: string; sql: string }> = [
  { filename: MIGRATION_FILENAME, sql: MIGRATION_SQL },
];

async function isMigrationApplied(sql: SqlClient, filename: string): Promise<boolean> {
  const tableExists = await sql.query<{ exists: boolean }>(
    `select exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'schema_migrations'
    ) as "exists"`,
  );
  if (!tableExists.rows[0]?.exists) {
    return false;
  }
  const applied = await sql.query<{ filename: string }>(
    `select filename from schema_migrations where filename = $1`,
    [filename],
  );
  return applied.rows.length > 0;
}

function splitSqlStatements(migrationSql: string): string[] {
  return migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applyOneMigration(
  sql: SqlClient,
  filename: string,
  migrationSql: string,
): Promise<void> {
  await sql.query("BEGIN");
  try {
    for (const statement of splitSqlStatements(migrationSql)) {
      await sql.query(statement);
    }
    await sql.query(`insert into schema_migrations (filename) values ($1)`, [filename]);
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }
}

export async function applyMigrations(sql: SqlClient): Promise<void> {
  for (const migration of MIGRATIONS) {
    if (await isMigrationApplied(sql, migration.filename)) {
      continue;
    }
    await applyOneMigration(sql, migration.filename, migration.sql);
  }
}
