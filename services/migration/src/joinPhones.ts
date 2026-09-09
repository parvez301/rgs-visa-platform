import type { MappedRow } from "./mapRow";
import type { RawYearRow } from "./readWorkbook";

export interface JoinedContactDetails {
  phone?: string;
  trackingNumber?: string;
  /**
   * Ruling (task-8): present only when `2025 YEAR`'s phone column held a
   * present, non-blank value that is not a plausible Indian mobile. Kept
   * verbatim and flagged for review -- never dropped, never coerced.
   *
   * The pinned case: `2025 YEAR` row 1844, column 10 holds the string
   * "Mukesh Kumar" -- a name shifted into the phone column by a bad paste.
   * Losing that string silently is exactly what this field prevents.
   */
  flaggedPhoneRaw?: string;
  /**
   * Values a LATER `2025 YEAR` row carried for the same REF NO. that
   * disagree with the ones kept above. Present only when the sheet really
   * contradicts itself, so an empty case costs nothing.
   */
  conflictingValues?: string[];
}

/** An Indian mobile is 10 digits starting 6-9. The sheet stores phones as
 *  floats, so a leading zero may already be lost -- anything else is kept
 *  on `flaggedPhoneRaw` rather than stored as a number nobody can call. */
function isPlausibleIndianMobile(phoneDigits: string): boolean {
  return /^[6-9]\d{9}$/.test(phoneDigits);
}

/**
 * Spec §9: phone numbers are recovered from `2025 YEAR` by REF NO join,
 * since `Mini CRM` dropped that column. Joins only against REF NOs already
 * known from pass 1 -- a `2025 YEAR` row with no matching case has nothing
 * to attach a phone to.
 *
 * `caseRef` is not guaranteed unique on EITHER sheet. `2025 YEAR` duplicates
 * 18 refs of its own, and this used to build a fresh object per row and
 * `set` it unconditionally -- so a later row with a blank phone or blank
 * tracking number overwrote an earlier row that had one. Measured, 4 refs
 * lost real data that way, including ref 31140's tracking number
 * 25DEL3G0001287 (row 61, overwritten by row 105's blank).
 *
 * So each field is filled once, by the first row that has it, and a later row
 * that disagrees is recorded on `conflictingValues` rather than silently
 * winning or silently losing. Which case a ref's details belong to when
 * `Mini CRM` also duplicates it is not decided here -- `importRun` owns that,
 * because only it knows which claimant keeps the bare ref.
 */
export function joinPhones(
  mappedRows: MappedRow[],
  yearRows: RawYearRow[],
): Map<string, JoinedContactDetails> {
  const knownCaseRefs = new Set(mappedRows.map((mappedRow) => mappedRow.caseRef));
  const joinedContactDetailsByCaseRef = new Map<string, JoinedContactDetails>();

  for (const yearRow of yearRows) {
    if (!knownCaseRefs.has(yearRow.caseRef)) {
      continue;
    }
    let contactDetails = joinedContactDetailsByCaseRef.get(yearRow.caseRef);
    if (contactDetails === undefined) {
      contactDetails = {};
      joinedContactDetailsByCaseRef.set(yearRow.caseRef, contactDetails);
    }

    const trimmedPhoneRaw = yearRow.phoneRaw.trim();
    if (trimmedPhoneRaw !== "") {
      const phoneField = isPlausibleIndianMobile(trimmedPhoneRaw) ? "phone" : "flaggedPhoneRaw";
      keepFirstValue(contactDetails, phoneField, "Phone", trimmedPhoneRaw, yearRow.sourceRow);
    }

    const trimmedTrackingNumber = yearRow.trackingNumber.trim();
    if (trimmedTrackingNumber !== "") {
      keepFirstValue(
        contactDetails,
        "trackingNumber",
        "TRACKING NO.",
        trimmedTrackingNumber,
        yearRow.sourceRow,
      );
    }
  }

  return joinedContactDetailsByCaseRef;
}

/**
 * First non-blank value wins; a different one from a later row is kept as a
 * conflict rather than dropped. Two rows agreeing is not a conflict.
 */
function keepFirstValue(
  contactDetails: JoinedContactDetails,
  fieldName: "phone" | "trackingNumber" | "flaggedPhoneRaw",
  columnLabel: string,
  value: string,
  sourceRow: number,
): void {
  const existingValue = contactDetails[fieldName];
  if (existingValue === undefined) {
    contactDetails[fieldName] = value;
    return;
  }
  if (existingValue === value) {
    return;
  }
  contactDetails.conflictingValues = [
    ...(contactDetails.conflictingValues ?? []),
    `${columnLabel} ${value} ("2025 YEAR" row ${sourceRow})`,
  ];
}
