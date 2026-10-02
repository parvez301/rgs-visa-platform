import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { MIGRATION_SQL } from "../src/db/migrations/006_portal_sor";
import type { SqlClient } from "../src/lib/sql";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

async function migratedClient(): Promise<SqlClient> {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  return sql;
}

describe("applyMigrations 006_portal_sor", () => {
  it("has no semicolons inside comments", () => {
    const commentLines = MIGRATION_SQL.split("\n").filter((line) => line.trim().startsWith("--"));
    for (const line of commentLines) {
      expect(line).not.toContain(";");
    }
  });

  it("creates the four portal tables", async () => {
    const sql = await migratedClient();
    const tables = await sql.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('portal_applications', 'portal_application_documents',
                            'portal_user_profiles', 'activity_events')
       order by table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "activity_events",
      "portal_application_documents",
      "portal_applications",
      "portal_user_profiles",
    ]);
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
        "portal_applications_user_updated",
        "portal_applications_status_updated",
        "portal_application_documents_app",
        "activity_events_created",
        "activity_events_user_created",
      ]),
    );
    await sql.end();
  });

  it("keys documents on application, traveller index and doc type", async () => {
    const sql = await migratedClient();
    const pk = await sql.query<{ column_name: string }>(
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       where tc.table_schema = 'public' and tc.table_name = 'portal_application_documents'
         and tc.constraint_type = 'PRIMARY KEY'
       order by kcu.ordinal_position`,
    );
    expect(pk.rows.map((r) => r.column_name)).toEqual(["application_id", "traveller_index", "doc_type"]);
    await sql.end();
  });

  it("rejects negative traveller_index and defaults jsonb columns", async () => {
    const sql = await migratedClient();
    await expect(
      sql.query(
        `insert into portal_application_documents
           (application_id, traveller_index, doc_type, s3_key, review_status, uploaded_at)
         values ('a1', -1, 'passport', 'k', 'pending', now())`,
      ),
    ).rejects.toThrow();
    await sql.query(
      `insert into portal_applications
         (application_id, user_id, country_code, product_code, status, step_reached,
          travellers, amounts, payment_status, created_at, updated_at)
       values ('a1', 'u1', 'AE', 'P', 'draft', 'start', '[]'::jsonb, '{}'::jsonb, 'unpaid', now(), now())`,
    );
    await sql.query(
      `insert into activity_events (event_id, event_type, user_id, created_at)
       values ('e1', 'login', 'u1', now())`,
    );
    const app = await sql.query<{ internal_notes: unknown }>(
      `select internal_notes from portal_applications where application_id = 'a1'`,
    );
    expect(app.rows[0]?.internal_notes).toEqual([]);
    const ev = await sql.query<{ meta: unknown }>(`select meta from activity_events where event_id = 'e1'`);
    expect(ev.rows[0]?.meta).toEqual({});
    await sql.end();
  });

  it("records 006 once and is idempotent on re-apply", async () => {
    const sql = await migratedClient();
    await applyMigrations(sql);
    const applied = await sql.query<{ filename: string }>(
      `select filename from schema_migrations where filename = '006_portal_sor.sql'`,
    );
    expect(applied.rows).toHaveLength(1);
    // Force a re-run of the SQL itself to prove every statement is idempotent.
    await sql.query(`delete from schema_migrations where filename = '006_portal_sor.sql'`);
    await applyMigrations(sql);
    const again = await sql.query<{ filename: string }>(
      `select filename from schema_migrations where filename = '006_portal_sor.sql'`,
    );
    expect(again.rows).toHaveLength(1);
    await sql.end();
  });
});
