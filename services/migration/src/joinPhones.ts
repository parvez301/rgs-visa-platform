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
 * `caseRef` is not guaranteed unique (task 9's problem, not this function's):
 * this join keys the result Map by `caseRef`, same as `caseRef` is used
 * throughout pass 1, and does not attempt to disambiguate duplicates.
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
    const contactDetails: JoinedContactDetails = {};

    const trimmedPhoneRaw = yearRow.phoneRaw.trim();
    if (trimmedPhoneRaw !== "") {
      if (isPlausibleIndianMobile(trimmedPhoneRaw)) {
        contactDetails.phone = trimmedPhoneRaw;
      } else {
        contactDetails.flaggedPhoneRaw = trimmedPhoneRaw;
      }
    }

    const trimmedTrackingNumber = yearRow.trackingNumber.trim();
    if (trimmedTrackingNumber !== "") {
      contactDetails.trackingNumber = trimmedTrackingNumber;
    }

    joinedContactDetailsByCaseRef.set(yearRow.caseRef, contactDetails);
  }

  return joinedContactDetailsByCaseRef;
}
