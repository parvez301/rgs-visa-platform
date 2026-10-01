import pg from "pg";

export interface SqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  end(): Promise<void>;
}

export type LedgerStore = "dynamo" | "postgres";

export function ledgerStoreFromEnvironment(environment: NodeJS.ProcessEnv): LedgerStore {
  const rawStore = environment["LEDGER_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "dynamo";
  if (rawStore === "dynamo" || rawStore === "postgres") return rawStore;
  throw new Error(`LEDGER_STORE must be dynamo or postgres, got ${rawStore}`);
}

export function databaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const rawUrl = environment["DATABASE_URL"];
  if (rawUrl === undefined) return undefined;
  const trimmedUrl = rawUrl.trim();
  return trimmedUrl.length > 0 ? trimmedUrl : undefined;
}

export function createPgSqlClient(databaseUrl: string): SqlClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Transaction pooler: keep low; many concurrent Lambdas share Supabase pool.
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async end() {
      await pool.end();
    },
  };
}
