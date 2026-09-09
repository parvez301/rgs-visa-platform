export interface DateNormalizationResult {
  isoDate: string | null;
  needsReview: boolean;
  rawValue: string;
}

/**
 * The workbook's real business window. Rows outside it (one lands in 2006,
 * several in 2028-2030) are data-entry slips, not history.
 */
const EARLIEST_PLAUSIBLE_YEAR = 2020;
const LATEST_PLAUSIBLE_YEAR = 2027;

function toIsoDate(year: number, month: number, day: number): string {
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return `${year}-${paddedMonth}-${paddedDay}`;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function isPlausibleYear(year: number): boolean {
  return year >= EARLIEST_PLAUSIBLE_YEAR && year <= LATEST_PLAUSIBLE_YEAR;
}

/**
 * Accepts what a spreadsheet reader may hand us. NOTE: a raw numeric Excel
 * serial date is NOT parsed — it falls through to needsReview. If the reader
 * used by the migration emits serials rather than Date objects, convert them
 * at the reader boundary or add a branch here with the correct epoch
 * (1900 vs 1904); do not guess the epoch.
 *
 * The reader boundary (`services/migration/src/readWorkbook.ts`) converts a
 * `Date` cell to `"YYYY-MM-DD"` (UTC, deliberately) rather than handing this
 * function a `Date` object, so a string in that exact shape is a second
 * accepted input format, matched before the day-first `dd-mm-yyyy` format
 * below. It still runs through `isRealCalendarDate` and `isPlausibleYear` —
 * an ISO-shaped string is not automatically trustworthy.
 */
export function normalizeExcelDate(
  rawInput: string | Date | number | null | undefined,
): DateNormalizationResult {
  if (rawInput === null || rawInput === undefined) {
    return { isoDate: null, needsReview: true, rawValue: "" };
  }

  if (rawInput instanceof Date) {
    if (Number.isNaN(rawInput.getTime())) {
      return { isoDate: null, needsReview: true, rawValue: "Invalid Date" };
    }
    const rawValue = rawInput.toISOString();
    if (!isPlausibleYear(rawInput.getUTCFullYear())) {
      return { isoDate: null, needsReview: true, rawValue };
    }
    return {
      isoDate: toIsoDate(
        rawInput.getUTCFullYear(),
        rawInput.getUTCMonth() + 1,
        rawInput.getUTCDate(),
      ),
      needsReview: false,
      rawValue,
    };
  }

  const rawValue = String(rawInput);
  // Strip the stray spaces the sheet contains ("01 /09/2026") before matching.
  const compactValue = rawValue.trim().replace(/\s+/g, "");

  const isoPartsMatch = compactValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoPartsMatch !== null) {
    const isoYear = Number(isoPartsMatch[1]);
    const isoMonth = Number(isoPartsMatch[2]);
    const isoDay = Number(isoPartsMatch[3]);
    if (isPlausibleYear(isoYear) && isRealCalendarDate(isoYear, isoMonth, isoDay)) {
      return { isoDate: toIsoDate(isoYear, isoMonth, isoDay), needsReview: false, rawValue };
    }
    return { isoDate: null, needsReview: true, rawValue };
  }

  const partsMatch = compactValue.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (partsMatch === null) {
    return { isoDate: null, needsReview: true, rawValue };
  }

  const firstNumber = Number(partsMatch[1]);
  const secondNumber = Number(partsMatch[2]);
  const year = Number(partsMatch[3]);

  if (!isPlausibleYear(year)) {
    return { isoDate: null, needsReview: true, rawValue };
  }

  // Day-first is the sheet's convention; month-first is the fallback only when
  // the day-first reading is not a real date.
  if (isRealCalendarDate(year, secondNumber, firstNumber)) {
    return { isoDate: toIsoDate(year, secondNumber, firstNumber), needsReview: false, rawValue };
  }
  if (isRealCalendarDate(year, firstNumber, secondNumber)) {
    return { isoDate: toIsoDate(year, firstNumber, secondNumber), needsReview: false, rawValue };
  }
  return { isoDate: null, needsReview: true, rawValue };
}
