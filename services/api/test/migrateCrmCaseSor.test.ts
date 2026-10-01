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

async function columnNames(sql: SqlClient, table: string): Promise<string[]> {
  const result = await sql.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

const INSERT_CASE = `insert into crm_cases
  (tenant_id, case_id, case_ref, partner_id, destination_country, case_type, case_status,
   billing_status, received_date, total_inr, updated_at)
  values ('rgs', $1, 'R-1', 'p1', 'AE', 'VISA', 'RECEIVED', 'UNBILLED', '2026-10-01', 0, now())`;

describe("applyMigrations 002_crm_case_sor", () => {
  it("creates the case system-of-record tables", async () => {
    const sql = await migratedClient();
    const tables = await sql.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'
       and tablename in ('crm_applicants','crm_events','crm_travellers','crm_ref_claims')
       order by tablename`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "crm_applicants",
      "crm_events",
      "crm_ref_claims",
      "crm_travellers",
    ]);
    await sql.end();
  });

  it("widens crm_cases with the full case META columns", async () => {
    const sql = await migratedClient();
    const columns = await columnNames(sql, "crm_cases");
    expect(columns).toEqual(
      expect.arrayContaining([
        "line_items",
        "client_email",
        "remarks",
        "submission_date",
        "entry_type",
        "processing",
        "validity",
        "document_checklist",
        "watchdog_overrides",
        "muted_rules",
        "snoozed_until",
        "appointment_reminder_sent_for",
        "courier_date",
        "source_sheet",
        "source_row",
        "legacy_raw",
        "created_at",
        "created_by_email",
      ]),
    );
    await sql.end();
  });

  it("keeps Phase A case rows valid and defaults the new jsonb columns", async () => {
    const sql = await migratedClient();
    await sql.query(INSERT_CASE, ["c1"]);
    const row = await sql.query<{ line_items: unknown; document_checklist: unknown; muted_rules: unknown; watchdog_overrides: unknown }>(
      `select line_items, document_checklist, muted_rules, watchdog_overrides
       from crm_cases where case_id = 'c1'`,
    );
    expect(row.rows[0]).toEqual({
      line_items: [],
      document_checklist: [],
      muted_rules: [],
      watchdog_overrides: {},
    });
    await sql.end();
  });

  it("has the applicant columns needed to round-trip CaseApplicant", async () => {
    const sql = await migratedClient();
    expect(await columnNames(sql, "crm_applicants")).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "case_id",
        "applicant_index",
        "applicant_ref",
        "ref_no",
        "traveller_id",
        "passport_number",
        "custody",
        "custody_since",
        "outcome",
        "courier_mode",
        "tracking_number",
        "visa_result_key",
      ]),
    );
    await sql.end();
  });

  it("rejects two applicants at the same index on one case", async () => {
    const sql = await migratedClient();
    await sql.query(INSERT_CASE, ["c1"]);
    const insertApplicant = `insert into crm_applicants
      (tenant_id, case_id, applicant_index, applicant_ref, traveller_id)
      values ('rgs', 'c1', $1, $2, 't1')`;
    await sql.query(insertApplicant, [0, "a0"]);
    await expect(sql.query(insertApplicant, [0, "a1"])).rejects.toThrow();
    await sql.end();
  });

  it("deletes applicants with their case", async () => {
    const sql = await migratedClient();
    await sql.query(INSERT_CASE, ["c1"]);
    await sql.query(
      `insert into crm_applicants (tenant_id, case_id, applicant_index, applicant_ref, traveller_id)
       values ('rgs', 'c1', 0, 'a0', 't1')`,
    );
    await sql.query(`delete from crm_cases where tenant_id = 'rgs' and case_id = 'c1'`);
    const left = await sql.query(`select 1 from crm_applicants`);
    expect(left.rows).toHaveLength(0);
    await sql.end();
  });

  it("enforces one passport per tenant on travellers but allows many without a passport", async () => {
    const sql = await migratedClient();
    const insertTraveller = `insert into crm_travellers
      (tenant_id, traveller_id, full_name, normalized_name, passport_number, created_at)
      values ($1, $2, 'A B', 'a b', $3, now())`;
    await sql.query(insertTraveller, ["rgs", "t1", "P123"]);
    await expect(sql.query(insertTraveller, ["rgs", "t2", "P123"])).rejects.toThrow();
    await sql.query(insertTraveller, ["other", "t3", "P123"]);
    await sql.query(insertTraveller, ["rgs", "t4", null]);
    await sql.query(insertTraveller, ["rgs", "t5", null]);
    await sql.end();
  });

  it("enforces one claim per ref key per tenant", async () => {
    const sql = await migratedClient();
    const insertClaim = `insert into crm_ref_claims
      (tenant_id, ref_key, ref_value, case_id, claimed_at)
      values ($1, 'R-1', 'r-1', $2, now())`;
    await sql.query(insertClaim, ["rgs", "c1"]);
    await expect(sql.query(insertClaim, ["rgs", "c2"])).rejects.toThrow();
    await sql.query(insertClaim, ["other", "c2"]);
    await sql.end();
  });

  it("stores case events with jsonb meta", async () => {
    const sql = await migratedClient();
    await sql.query(
      `insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
       values ('rgs', 'e1', 'c1', 'CASE_CREATED', 'a@b.co', $1::jsonb, now())`,
      [JSON.stringify({ from: "x", count: 2 })],
    );
    const row = await sql.query<{ meta: Record<string, unknown> }>(
      `select meta from crm_events where event_id = 'e1'`,
    );
    expect(row.rows[0]?.meta).toEqual({ from: "x", count: 2 });
    await sql.end();
  });

  it("records 002 once and is idempotent on re-apply", async () => {
    const sql = await migratedClient();
    await applyMigrations(sql);
    const applied = await sql.query<{ filename: string }>(
      `select filename from schema_migrations order by filename`,
    );
    expect(applied.rows.map((row) => row.filename)).toEqual([
      "001_crm_ledger.sql",
      "002_crm_case_sor.sql",
      "003_crm_partners_sor.sql",
    ]);
    await sql.end();
  });
});
