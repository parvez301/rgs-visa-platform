import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import type { SqlClient } from "../src/lib/sql";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

async function migratedClient(): Promise<SqlClient> {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  return sql;
}

async function primaryKeyColumns(sql: SqlClient, table: string): Promise<string[]> {
  const result = await sql.query<{ column_name: string }>(
    `select kcu.column_name
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'
     order by kcu.ordinal_position`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

describe("applyMigrations 004_crm_remaining_sor", () => {
  it("creates remaining CRM SoR tables", async () => {
    const sql = await migratedClient();
    const tables = await sql.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname='public' and tablename like 'crm_%' order by 1`,
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining([
        "crm_case_ref_reservations",
        "crm_review_items",
        "crm_proposals",
        "crm_memories",
        "crm_user_prefs",
        "crm_status_email_templates",
      ]),
    );
  });

  it("keys each table on tenant plus its natural id", async () => {
    const sql = await migratedClient();
    expect(await primaryKeyColumns(sql, "crm_case_ref_reservations")).toEqual(["tenant_id", "case_ref"]);
    expect(await primaryKeyColumns(sql, "crm_review_items")).toEqual(["tenant_id", "review_item_id"]);
    expect(await primaryKeyColumns(sql, "crm_proposals")).toEqual(["tenant_id", "proposal_id"]);
    expect(await primaryKeyColumns(sql, "crm_memories")).toEqual(["tenant_id", "scope", "memory_key"]);
    expect(await primaryKeyColumns(sql, "crm_user_prefs")).toEqual(["tenant_id", "email"]);
    expect(await primaryKeyColumns(sql, "crm_status_email_templates")).toEqual(["tenant_id", "case_status"]);
  });

  it("creates the tenant-scoped lookup indexes", async () => {
    const sql = await migratedClient();
    const indexes = await sql.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename in
       ('crm_review_items','crm_proposals','crm_memories')`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "crm_review_items_tenant_status",
        "crm_proposals_tenant_status",
        "crm_memories_tenant_scope",
      ]),
    );
  });

  it("round-trips a reservation with a null completed_at", async () => {
    const sql = await migratedClient();
    await sql.query(
      `insert into crm_case_ref_reservations (tenant_id, case_ref, case_id, reserved_at)
       values ('rgs', 'R-1', 'c1', now())`,
    );
    const rows = await sql.query<{ completed_at: string | null }>(
      `select completed_at from crm_case_ref_reservations where tenant_id = 'rgs' and case_ref = 'R-1'`,
    );
    expect(rows.rows[0]?.completed_at).toBeNull();
  });

  it("is idempotent when applied twice", async () => {
    const sql = await migratedClient();
    await expect(applyMigrations(sql)).resolves.toBeUndefined();
  });
});
