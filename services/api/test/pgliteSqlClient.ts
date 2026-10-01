import type { PGlite } from "@electric-sql/pglite";
import type { SqlClient, SqlQueryable } from "../src/lib/sql";

/** A real Postgres (PGlite) behind the `SqlClient` seam, transactions included. */
export function pgliteAsSqlClient(database: PGlite): SqlClient {
  function toQueryable(runner: Pick<PGlite, "query">): SqlQueryable {
    return {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        const result = await runner.query(text, [...values]);
        return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
      },
    };
  }
  return {
    ...toQueryable(database),
    async transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      return database.transaction(async (pgliteTransaction) => work(toQueryable(pgliteTransaction)));
    },
    async end() {
      await database.close();
    },
  };
}
