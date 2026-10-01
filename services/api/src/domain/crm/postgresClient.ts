import type { AppContext } from "../../lib/context";
import type { SqlClient } from "../../lib/sql";

/** `CRM_STORE=postgres` is only valid with a SQL client; fail loudly, never fall back to Dynamo. */
export function postgresClientFor(context: AppContext): SqlClient {
  if (context.sql === undefined) {
    throw new Error("CRM_STORE=postgres requires context.sql");
  }
  return context.sql;
}

/**
 * The SQL client when this context stores CRM data in Postgres, else
 * `undefined`. Callers branch on it once: `const sql = crmPostgresOf(context)`.
 */
export function crmPostgresOf(context: AppContext): SqlClient | undefined {
  return context.crmStore === "postgres" ? postgresClientFor(context) : undefined;
}
