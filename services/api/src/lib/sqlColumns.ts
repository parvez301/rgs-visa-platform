/**
 * Small helpers shared by every Postgres-backed CRM store (cases, partners,
 * travellers, REF claims): rendering columns the way the domain schemas expect
 * them, and turning NULLs back into absent keys.
 */

/** UTC ISO-8601 with milliseconds, the shape `z.string().datetime()` accepts. */
export function isoTimestampSql(column: string): string {
  return `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export function isoDateSql(column: string): string {
  return `to_char(${column}, 'YYYY-MM-DD')`;
}

/** Optional domain fields become SQL NULL, never the string "undefined". */
export function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export type DbRow = Record<string, unknown>;

/** NULL columns become absent keys. */
export function candidateFromColumns(
  dbRow: DbRow,
  columns: ReadonlyArray<readonly [fieldName: string, columnName: string]>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};
  for (const [fieldName, columnName] of columns) {
    const value = dbRow[columnName];
    if (value !== null && value !== undefined) candidate[fieldName] = value;
  }
  return candidate;
}

/** SQLSTATE 23505: a unique index refused the write. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
