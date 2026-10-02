import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { MIGRATION_SQL } from "../src/db/migrations/007_portal_leads_notices";
import type { SqlClient } from "../src/lib/sql";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

async function migratedClient(): Promise<SqlClient> {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  return sql;
}

describe("applyMigrations 007_portal_leads_notices", () => {
  it("has no semicolons inside comments", () => {
    const commentLines = MIGRATION_SQL.split("\n").filter((line) => line.trim().startsWith("--"));
    for (const line of commentLines) {
      expect(line).not.toContain(";");
    }
  });

  it("creates portal_leads and portal_notices", async () => {
    const sql = await migratedClient();
    const tables = await sql.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('portal_leads', 'portal_notices')
       order by table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(["portal_leads", "portal_notices"]);
    await sql.end();
  });

  it("creates the key indexes", async () => {
    const sql = await migratedClient();
    const indexes = await sql.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "portal_leads_created",
        "portal_notices_created",
        "portal_notices_status_pinned_published",
      ]),
    );
    await sql.end();
  });

  it("is idempotent when applied twice", async () => {
    const sql = await migratedClient();
    await applyMigrations(sql);
    const applied = await sql.query<{ filename: string }>(
      `select filename from schema_migrations where filename = '007_portal_leads_notices.sql'`,
    );
    expect(applied.rows).toHaveLength(1);
    await sql.end();
  });
});
