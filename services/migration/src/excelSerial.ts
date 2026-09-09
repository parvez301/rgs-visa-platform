/**
 * Excel's 1900 date system, expressed as the day-zero anchor: serial 1 is
 * 1900-01-01, and the system's phantom 1900-02-29 makes 1899-12-30 the
 * arithmetic base.
 *
 * DETERMINED EMPIRICALLY, NOT ASSUMED. REF NO 31376 appears on both sheets:
 * "2025 YEAR" stores Sub Date as the serial 45657, "Mini CRM" stores it as
 * the text "12/31/2024". 1899-12-30 + 45657 days = 2024-12-31, which agrees.
 * The 1904 system gives 2029-01-01, which does not. Do not change this
 * without re-running that cross-sheet check.
 */
export const EXCEL_EPOCH_UTC = new Date(Date.UTC(1899, 11, 30));

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
/** Matches normalizeExcelDate's window so both paths agree on what is plausible. */
const EARLIEST_PLAUSIBLE_YEAR = 2020;
const LATEST_PLAUSIBLE_YEAR = 2027;

export function isExcelSerialCandidate(rawValue: unknown): rawValue is number {
  return typeof rawValue === "number" && Number.isFinite(rawValue);
}

export function excelSerialToIsoDate(serialValue: number): string | null {
  if (!Number.isFinite(serialValue)) {
    return null;
  }
  const wholeDays = Math.trunc(serialValue);
  const converted = new Date(EXCEL_EPOCH_UTC.getTime() + wholeDays * MILLISECONDS_PER_DAY);
  const year = converted.getUTCFullYear();
  if (year < EARLIEST_PLAUSIBLE_YEAR || year > LATEST_PLAUSIBLE_YEAR) {
    return null;
  }
  const month = String(converted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(converted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
