const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A YYYY-MM-DD string that names a real calendar day. The pattern alone lets
 * "2026-13-45" through to Postgres, whose `::date` cast throws -- a 500 for
 * what is a caller mistake. Round-tripping through Date rejects month 13 and
 * day 45, and also 2026-02-30 (which Date would silently roll to March 2).
 */
export function isRealIsoDate(value: string): boolean {
  // Postgres has no year 0000 either; Date would accept it.
  if (!ISO_DATE_PATTERN.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
