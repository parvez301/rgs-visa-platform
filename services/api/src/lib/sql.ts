import pg from "pg";

export interface SqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** Anything that can run a statement: the pool-backed client, or one open transaction. */
export interface SqlQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
}

export interface SqlClient extends SqlQueryable {
  /**
   * Runs `work` inside BEGIN..COMMIT on ONE dedicated connection. The callback
   * receives a queryable bound to that connection, so every statement shares
   * the transaction: the pool cannot idle-time it out between statements, and
   * a concurrent caller's statements cannot interleave into it. Resolves with
   * the callback's value after COMMIT; ROLLBACK and rethrow the callback's
   * own error if it throws.
   */
  transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export type LedgerStore = "dynamo" | "postgres";

export function ledgerStoreFromEnvironment(environment: NodeJS.ProcessEnv): LedgerStore {
  const rawStore = environment["LEDGER_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "dynamo";
  if (rawStore === "dynamo" || rawStore === "postgres") return rawStore;
  throw new Error(`LEDGER_STORE must be dynamo or postgres, got ${rawStore}`);
}

export type CrmStore = "dynamo" | "postgres";

export function crmStoreFromEnvironment(environment: NodeJS.ProcessEnv): CrmStore {
  const rawStore = environment["CRM_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "dynamo";
  if (rawStore === "dynamo" || rawStore === "postgres") return rawStore;
  throw new Error(`CRM_STORE must be dynamo or postgres, got ${rawStore}`);
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
    async transaction<T>(work: (tx: SqlQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const tx: SqlQueryable = {
        async query<R extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values: readonly unknown[] = [],
        ) {
          const result = await client.query(text, [...values]);
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        },
      };
      try {
        await client.query("BEGIN");
        const value = await work(tx);
        await client.query("COMMIT");
        client.release();
        return value;
      } catch (error) {
        // A failed ROLLBACK (the connection itself died) must not replace the
        // real cause. Releasing with an error destroys the connection rather
        // than returning a possibly mid-transaction one to the pool.
        let connectionBroken = false;
        try {
          await client.query("ROLLBACK");
        } catch {
          connectionBroken = true;
        }
        client.release(connectionBroken ? true : undefined);
        throw error;
      }
    },
    async end() {
      await pool.end();
    },
  };
}
