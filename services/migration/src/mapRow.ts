import { crm } from "@rgs/shared";
import type { RawMiniCrmRow } from "./readWorkbook";

export interface PendingReviewItem {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  proposedValue?: string;
  detail?: string;
}

export interface MappedCaseDraft {
  caseType: crm.CaseType;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  validity?: string;
  caseStatus: crm.CaseStatus;
  custody: crm.CustodyStatus;
  outcome: crm.ApplicantOutcome;
  courierMode?: crm.CourierMode;
  /**
   * From the sheet's own "payment status" column. Absent means the column
   * said nothing, which is the overwhelming majority of rows — the importer
   * turns that into `UNKNOWN`.
   */
  billingStatus?: crm.BillingStatus;
  receivedDate?: string;
  courierDate?: string;
  submissionDate?: string;
  expectedCollectionDate?: string;
  note?: string;
}

export interface MappedRow {
  caseRef: string;
  sourceSheet: string;
  sourceRow: number;
  partnerName: string;
  travellerFullName: string;
  passportNumber?: string;
  /** "Mini CRM" c19. The `2025 YEAR` join is the fallback, not the source. */
  trackingNumber?: string;
  applicantCount: number;
  caseDraft: MappedCaseDraft;
  reviewItems: PendingReviewItem[];
  legacyRaw: Record<string, string>;
}

const MINI_CRM_SHEET_NAME = "Mini CRM";

function isBlank(rawValue: string): boolean {
  return rawValue.trim() === "";
}

/**
 * Task-7 review round 1, Minor 5 — measured across all 115 present-but-
 * unparseable cells in the three date columns of the real workbook: 13
 * contain no digit at all ("aposttile", "REJECT", "DUPLICATE", "Passport",
 * "N/A", the row-3001 email address, ...) and the remaining 102 all contain
 * a digit (typo'd or out-of-window dates like "22-012024", "31-01-2028").
 * A cell with zero digits is not a mistyped date attempt at all — it is
 * foreign content sitting in a date column, i.e. exactly what
 * `COLUMN_SHIFT_JUNK` names. A cell with a digit stays `UNPARSEABLE_DATE`.
 */
function looksLikeColumnShiftJunk(rawValue: string): boolean {
  return !/\d/.test(rawValue);
}

/**
 * Spec §6: a blank cell means the sheet did not record the value. It is not
 * a defect and must never become a review item — treating blanks as review
 * items turns 64.9% of rows into queue entries instead of 14.2%.
 *
 * `crm.normalizeExcelDate` owns all of the date parsing: both the sheet's
 * day-first "dd-mm-yyyy" / "dd/mm/yyyy" text AND the "YYYY-MM-DD" shape the
 * reader emits for a `Date` cell (task-7 ruling: the reader converts at the
 * boundary, in ISO — this function must not re-parse or short-circuit either
 * shape itself, only translate the normalizer's `needsReview` into a
 * PendingReviewItem).
 *
 * When the value is present but cannot be parsed as any date, its text must
 * not simply vanish: it survives on the review item's `rawValue` AND is
 * copied into `legacyRaw` — see `looksLikeColumnShiftJunk` above for which
 * `ReviewReason` it gets.
 */
function mapDateField(
  rawValue: string,
  fieldName: string,
  reviewItems: PendingReviewItem[],
  legacyRaw: Record<string, string>,
): string | undefined {
  if (isBlank(rawValue)) {
    return undefined;
  }
  const normalizedDate = crm.normalizeExcelDate(rawValue);
  if (normalizedDate.isoDate === null) {
    const reason: crm.ReviewReason = looksLikeColumnShiftJunk(rawValue)
      ? "COLUMN_SHIFT_JUNK"
      : "UNPARSEABLE_DATE";
    reviewItems.push({ reason, fieldName, rawValue });
    legacyRaw[fieldName] = rawValue;
    return undefined;
  }
  return normalizedDate.isoDate;
}

/**
 * The sheet's "payment status" column, which the importer used to ignore
 * entirely — along with the claim, in a comment beside `billingStatus:
 * "UNKNOWN"`, that "migrated rows carry no billing evidence". 34 rows carry
 * exactly that evidence.
 *
 * Only the unambiguous spellings are mapped. Measured on the real workbook:
 * "Bill Sent" x18, "Recived In Cash/UPI" x7, "Payment Receive" x7 — each of
 * which states plainly whether the bill went out or the money came in.
 *
 * Two values are deliberately NOT here. "In Cash" (x1) names a payment
 * METHOD and does not say whether the cash was received or is merely
 * expected; and one cell is a {text, hyperlink} object holding
 * "MYANMAR - SALIL KUMAR SRIVASTAVA" plus a Drive link — a name, not a
 * payment status. Both raise a review item instead. Guessing either would
 * put a fabricated billing state on a real case.
 */
const BILLING_STATUS_BY_PAYMENT_STATUS_KEY: Record<string, crm.BillingStatus> = {
  "BILL SENT": "BILL_SENT",
  "RECIVED IN CASH/UPI": "PAID",
  "PAYMENT RECEIVE": "PAID",
};

export function mapRow(rawRow: RawMiniCrmRow): MappedRow {
  const reviewItems: PendingReviewItem[] = [];
  const legacyRaw: Record<string, string> = {};

  const countryResult = crm.normalizeCountry(rawRow.country);
  if (!isBlank(rawRow.country) && countryResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_COUNTRY", fieldName: "Country", rawValue: rawRow.country });
  }

  const visaTypeResult = crm.normalizeVisaType(rawRow.visaType);
  if (!isBlank(rawRow.visaType) && visaTypeResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_VISA_TYPE", fieldName: "Visa Type", rawValue: rawRow.visaType });
  }

  const entriesResult = crm.normalizeEntries(rawRow.entries);
  if (!isBlank(rawRow.entries) && entriesResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_ENTRIES", fieldName: "Entries", rawValue: rawRow.entries });
  }

  const statusResult = crm.normalizeStatus(rawRow.status);
  if (!isBlank(rawRow.status) && statusResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: rawRow.status });
  }

  const partnerResult = crm.normalizePartnerName(rawRow.partnerName);
  if (!isBlank(rawRow.partnerName) && partnerResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: rawRow.partnerName });
  }

  // A caseType named in the Status column describes what the case IS and
  // beats the Visa Type column, which often contradicts it (task-7 brief).
  //
  // Task-7 review round 1, Major 1: crm.normalizeCountry returns a
  // visaTypeHint (e.g. Country "Sri Lanka ETA" -> countryCode "LK" +
  // visaTypeHint "E_VISA") that names a specific visa product implied by the
  // COUNTRY text alone. It is a fallback, never an override: when the Visa
  // Type column already yielded a caseType/visaType, the explicit column
  // wins and the hint is dropped silently (it is derived from Country, not
  // itself source data, so dropping it is not a "nothing is discarded"
  // violation). It only fills in when the column yielded nothing at all —
  // measured on the real workbook, that is 39 of the 113 "Sri Lanka ETA"
  // rows, which otherwise land on caseType "OTHER" with no visaType, no
  // review item, and no legacyRaw trace of the ETA signal.
  const caseTypeFromColumns = statusResult.caseTypeHint ?? visaTypeResult.caseType;
  const visaTypeHintApplies = caseTypeFromColumns === null && countryResult.visaTypeHint !== null;
  const caseType: crm.CaseType = caseTypeFromColumns ?? (visaTypeHintApplies ? "VISA" : null) ?? "OTHER";
  const visaType: crm.VisaType | null =
    visaTypeResult.visaType ?? (visaTypeHintApplies ? countryResult.visaTypeHint : null);

  if (!isBlank(rawRow.additionalItems)) {
    legacyRaw["Additional Items"] = rawRow.additionalItems;
  }
  if (statusResult.lineItemHint !== null) {
    legacyRaw["Status line item"] = statusResult.lineItemHint;
  }
  if (!isBlank(rawRow.dateOfBirthRaw)) {
    legacyRaw["DOB"] = rawRow.dateOfBirthRaw;
  }
  // The four columns the reader used to stop short of. Each keeps a verbatim
  // copy here even where it also lands on a structured field, because the
  // structured field holds a NORMALIZED value (an ISO date, a billing enum)
  // and this is the only record of what the cell actually said.
  if (!isBlank(rawRow.remarks)) {
    legacyRaw["Remarks"] = rawRow.remarks;
  }
  if (!isBlank(rawRow.courierDateRaw)) {
    legacyRaw["COURIER DATE"] = rawRow.courierDateRaw;
  }
  if (!isBlank(rawRow.paymentStatus)) {
    legacyRaw["payment status"] = rawRow.paymentStatus;
  }
  if (!isBlank(rawRow.trackingNumber)) {
    legacyRaw["TRACKING NO."] = rawRow.trackingNumber;
  }

  const billingStatus =
    BILLING_STATUS_BY_PAYMENT_STATUS_KEY[crm.buildLookupKey(rawRow.paymentStatus)];
  if (!isBlank(rawRow.paymentStatus) && billingStatus === undefined) {
    reviewItems.push({
      reason: "UNMAPPED_STATUS",
      fieldName: "payment status",
      rawValue: rawRow.paymentStatus,
      detail:
        "The payment status column holds a value that does not state whether the bill was sent or the money received, so billing was left UNKNOWN rather than guessed.",
    });
  }

  const parsedApplicantCount = Number(rawRow.applicantCount);
  const applicantCount =
    Number.isFinite(parsedApplicantCount) && parsedApplicantCount >= 1
      ? Math.trunc(parsedApplicantCount)
      : 1;

  const caseDraft: MappedCaseDraft = {
    caseType,
    destinationCountry: countryResult.countryCode ?? "",
    ...(visaType !== null ? { visaType } : {}),
    ...(entriesResult.entryType !== null ? { entryType: entriesResult.entryType } : {}),
    ...(entriesResult.processing !== null ? { processing: entriesResult.processing } : {}),
    ...(entriesResult.validity !== null ? { validity: entriesResult.validity } : {}),
    // Status is the axis-splitter (task-7 brief): one Excel column yields
    // caseStatus/custody/outcome. When it says nothing, these are the
    // schema defaults, meaning "the sheet did not say" — not DECIDED, and
    // never guessed from the presence of other fields.
    caseStatus: statusResult.caseStatus ?? "NEW",
    custody: statusResult.custody ?? "NOT_HELD",
    outcome: statusResult.outcome ?? "PENDING",
    ...(statusResult.courierMode !== null ? { courierMode: statusResult.courierMode } : {}),
    ...(statusResult.note !== null ? { note: statusResult.note } : {}),
    ...(billingStatus !== undefined ? { billingStatus } : {}),
  };

  const receivedDate = mapDateField(rawRow.receivedDateRaw, "C", reviewItems, legacyRaw);
  if (receivedDate !== undefined) caseDraft.receivedDate = receivedDate;
  const submissionDate = mapDateField(rawRow.subDateRaw, "Sub Date", reviewItems, legacyRaw);
  if (submissionDate !== undefined) caseDraft.submissionDate = submissionDate;
  const collectionDate = mapDateField(rawRow.collectionRaw, "Collection", reviewItems, legacyRaw);
  if (collectionDate !== undefined) caseDraft.expectedCollectionDate = collectionDate;
  // `CrmCaseSchema` carries a `courierDate` field of exactly this name, so a
  // cell that IS a date goes there rather than only into legacyRaw.
  //
  // But this column is NOT the same shape as "C" / "Sub Date" / "Collection",
  // and it deliberately does not use `mapDateField`. Measured over its 256
  // populated cells: only 76 are a date. The other 180 are courier notes that
  // happen to contain one — "20778883086 - 24/2/2025" (a consignment number
  // and a date), "COURIER 09/07", "porter 31/08/2026", "PP CURRENT & OLD
  // DISPACHED TO VARNI TRAVEL 02/09 BLUE DART". Those are not malformed
  // dates, so calling them UNPARSEABLE_DATE would tell a reviewer that 70% of
  // a working column is broken, and would put 180 items into a queue whose
  // whole design premise (spec §6) is that it stays small enough to work
  // through. Every one of them is already preserved verbatim in legacyRaw
  // above, so nothing is discarded by not flagging them. Splitting the
  // composites into number + date is real recovery, but it is guesswork about
  // a format nobody documented -- Plan 5's job, with the raw text in hand.
  if (!isBlank(rawRow.courierDateRaw)) {
    const courierDate = crm.normalizeExcelDate(rawRow.courierDateRaw).isoDate;
    if (courierDate !== null) caseDraft.courierDate = courierDate;
  }

  return {
    caseRef: rawRow.caseRef,
    sourceSheet: MINI_CRM_SHEET_NAME,
    sourceRow: rawRow.sourceRow,
    partnerName: rawRow.partnerName,
    travellerFullName: rawRow.applicantsName,
    ...(isBlank(rawRow.passportNumber) ? {} : { passportNumber: rawRow.passportNumber }),
    ...(isBlank(rawRow.trackingNumber) ? {} : { trackingNumber: rawRow.trackingNumber }),
    applicantCount,
    caseDraft,
    reviewItems,
    legacyRaw,
  };
}
