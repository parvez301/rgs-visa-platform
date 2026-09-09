import type { EntryType, ProcessingSpeed } from "../statuses";

export interface EntriesNormalizationResult {
  entryType: EntryType | null;
  processing: ProcessingSpeed | null;
  validity: string | null;
  needsReview: boolean;
  rawValue: string;
}

/** Uppercased, punctuation flattened to single spaces. "Multiple 1 Yr/E" -> "MULTIPLE 1 YR E". */
function buildTokenString(rawValue: string): string {
  return rawValue.trim().toUpperCase().replace(/[/\-,]+/g, " ").replace(/\s+/g, " ").trim();
}

function detectEntryType(tokenString: string): EntryType | null {
  if (/\bMULT/.test(tokenString)) return "MULTIPLE";
  if (/\bDOUBLE\b/.test(tokenString)) return "DOUBLE";
  if (/\bSINGLE\b/.test(tokenString) || tokenString === "X1") return "SINGLE";
  return null;
}

function detectProcessing(tokenString: string): ProcessingSpeed | null {
  if (/\bPL\b/.test(tokenString)) return "PREMIUM_LOUNGE";
  if (/\bEXP(RESS)?\b/.test(tokenString) || /\bURGENT\b/.test(tokenString) || /\bE\b/.test(tokenString)) {
    return "EXPRESS";
  }
  if (/\bN(O)?RM(A)?L\b/.test(tokenString) || /\bNRMAL\b/.test(tokenString)) return "NORMAL";
  return null;
}

/** "10 YR" -> "10Y", "6 MONTHS" -> "6M", "3 MONTHS" -> "3M". */
function detectValidity(tokenString: string): string | null {
  const yearMatch = tokenString.match(/\b(\d+)\s*(?:YR|YEAR|YEARS)\b/);
  if (yearMatch !== null) return `${yearMatch[1]}Y`;
  const monthMatch = tokenString.match(/\b(\d+)\s*(?:M|MONTH|MONTHS)\b/);
  if (monthMatch !== null) return `${monthMatch[1]}M`;
  return null;
}

/** Values that appear in the Entries column but are not entry descriptions at all. */
const COLUMN_SHIFT_JUNK = new Set(["BUSINESS", "ENTRIES"]);

export function normalizeEntries(rawValue: unknown): EntriesNormalizationResult {
  if (typeof rawValue !== "string") {
    return {
      entryType: null,
      processing: null,
      validity: null,
      needsReview: true,
      rawValue: rawValue == null ? "" : String(rawValue),
    };
  }
  const tokenString = buildTokenString(rawValue);
  if (tokenString.length === 0 || COLUMN_SHIFT_JUNK.has(tokenString)) {
    return { entryType: null, processing: null, validity: null, needsReview: true, rawValue };
  }

  const entryType = detectEntryType(tokenString);
  const detectedProcessing = detectProcessing(tokenString);
  const validity = detectValidity(tokenString);

  if (entryType === null) {
    // A speed or validity with no entry count is partial information, not a guess.
    return {
      entryType: null,
      processing: detectedProcessing,
      validity,
      needsReview: true,
      rawValue,
    };
  }

  return {
    entryType,
    processing: detectedProcessing ?? "NORMAL",
    validity,
    needsReview: false,
    rawValue,
  };
}
