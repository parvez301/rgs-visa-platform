import type { AppContext } from "../../lib/context";
import type { SqlClient } from "../../lib/sql";

/** The SQL client every domain function runs on; fail loudly when it is missing. */
export function requireSql(context: AppContext): SqlClient {
  if (context.sql === undefined) {
    throw new Error("AppContext.sql is required");
  }
  return context.sql;
}
