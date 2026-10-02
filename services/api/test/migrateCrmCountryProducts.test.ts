import { PGlite } from "@electric-sql/pglite";
import { COUNTRY_PRODUCTS } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { MIGRATION_SQL } from "../src/db/migrations/005_crm_country_products";
import type { SqlClient } from "../src/lib/sql";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

async function migratedClient(): Promise<SqlClient> {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  return sql;
}

async function countRows(sql: SqlClient): Promise<number> {
  const result = await sql.query<{ n: string }>(`select count(*)::text as n from crm_country_products`);
  return Number(result.rows[0]?.n);
}

describe("applyMigrations 005_crm_country_products", () => {
  it("creates the table keyed on country plus product", async () => {
    const sql = await migratedClient();
    const pk = await sql.query<{ column_name: string }>(
      `select kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       where tc.table_schema = 'public' and tc.table_name = 'crm_country_products'
         and tc.constraint_type = 'PRIMARY KEY'
       order by kcu.ordinal_position`,
    );
    expect(pk.rows.map((r) => r.column_name)).toEqual(["country_code", "product_code"]);
  });

  it("seeds one row per COUNTRY_PRODUCTS entry", async () => {
    const sql = await migratedClient();
    expect(await countRows(sql)).toBe(COUNTRY_PRODUCTS.length);
    const ae = await sql.query<{ government_fee_inr: number; required_documents: unknown; active: boolean }>(
      `select government_fee_inr, required_documents, active
       from crm_country_products where product_code = 'AE_TOURIST_30D_SINGLE'`,
    );
    const expected = COUNTRY_PRODUCTS.find((p) => p.productCode === "AE_TOURIST_30D_SINGLE")!;
    expect(ae.rows[0]?.government_fee_inr).toBe(expected.governmentFeeInr);
    expect(ae.rows[0]?.required_documents).toEqual(JSON.parse(JSON.stringify(expected.requiredDocuments)));
    expect(ae.rows[0]?.active).toBe(expected.active);
  });

  it("does not re-seed when migrations are applied again", async () => {
    const sql = await migratedClient();
    await applyMigrations(sql);
    expect(await countRows(sql)).toBe(COUNTRY_PRODUCTS.length);
  });

  it("keeps desk edits and never re-seeds a non-empty table", async () => {
    const sql = await migratedClient();
    await sql.query(
      `insert into crm_country_products
        (country_code, product_code, country_name, visa_type, region, tier, validity_days, stay_days,
         entry, government_fee_inr, service_fee_inr, processing_days, active)
       values ('ZZ', 'ZZ_DESK', 'Desk Land', 'E_VISA', 'ASIA', 'FULFILLED', 30, 30, 'SINGLE', 0, 0, 1, true)`,
    );
    await sql.query(`delete from crm_country_products where product_code = 'AE_TOURIST_30D_SINGLE'`);
    await sql.query(`delete from schema_migrations where filename = '005_crm_country_products.sql'`);
    await applyMigrations(sql);
    const rows = await sql.query<{ product_code: string }>(
      `select product_code from crm_country_products where product_code in ('ZZ_DESK', 'AE_TOURIST_30D_SINGLE')`,
    );
    expect(rows.rows.map((r) => r.product_code)).toEqual(["ZZ_DESK"]);
    expect(await countRows(sql)).toBe(COUNTRY_PRODUCTS.length);
  });

  it("emits no semicolon inside seed literals", () => {
    const statements = MIGRATION_SQL.split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(3);
  });
});
