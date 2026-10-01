import type { SqlClient } from "../lib/sql.js";
import {
  MIGRATION_FILENAME as CRM_LEDGER_FILENAME,
  MIGRATION_SQL as CRM_LEDGER_SQL,
} from "./migrations/001_crm_ledger.js";
import {
  MIGRATION_FILENAME as CRM_CASE_SOR_FILENAME,
  MIGRATION_SQL as CRM_CASE_SOR_SQL,
} from "./migrations/002_crm_case_sor.js";
import {
  MIGRATION_FILENAME as CRM_PARTNERS_SOR_FILENAME,
  MIGRATION_SQL as CRM_PARTNERS_SOR_SQL,
} from "./migrations/003_crm_partners_sor.js";

const MIGRATIONS: ReadonlyArray<{ filename: string; sql: string }> = [
  { filename: CRM_LEDGER_FILENAME, sql: CRM_LEDGER_SQL },
  { filename: CRM_CASE_SOR_FILENAME, sql: CRM_CASE_SOR_SQL },
  { filename: CRM_PARTNERS_SOR_FILENAME, sql: CRM_PARTNERS_SOR_SQL },
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
  await sql.transaction(async (tx) => {
    for (const statement of splitSqlStatements(migrationSql)) {
      await tx.query(statement);
    }
    await tx.query(`insert into schema_migrations (filename) values ($1)`, [filename]);
  });
}

export async function applyMigrations(sql: SqlClient): Promise<void> {
  for (const migration of MIGRATIONS) {
    if (await isMigrationApplied(sql, migration.filename)) {
      continue;
    }
    await applyOneMigration(sql, migration.filename, migration.sql);
  }
}
