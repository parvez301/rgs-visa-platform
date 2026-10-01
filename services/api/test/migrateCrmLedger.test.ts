import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import type { SqlClient } from "../src/lib/sql";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

describe("applyMigrations 001_crm_ledger", () => {
  it("creates crm_cases and crm_partners", async () => {
    const database = new PGlite();
    const sql = pgliteAsSqlClient(database);
    await applyMigrations(sql);
    const tables = await sql.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename in ('crm_cases','crm_partners') order by tablename`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual(["crm_cases", "crm_partners"]);
    await sql.end();
  });
});
