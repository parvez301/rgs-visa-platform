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
  receivedDate?: string;
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
 * copied into `legacyRaw`. Measured against the real workbook, 85 of the
 * three date columns' cells are present-but-unparseable, and one of them
 * (Mini CRM row 3001, column "C") is not a malformed date attempt at all —
 * it is an email address left behind by a column-shift paste. Since the
 * reader has already flattened every cell to text by the time this function
 * sees it, the two cases are indistinguishable by shape; copying every
 * unparseable date's text into `legacyRaw` (in addition to the review item)
 * is what keeps that one row's data from being dropped, without guessing
 * which of the 85 rows are "really" column-shift junk.
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
    reviewItems.push({ reason: "UNPARSEABLE_DATE", fieldName, rawValue });
    legacyRaw[fieldName] = rawValue;
    return undefined;
  }
  return normalizedDate.isoDate;
}

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
  const caseType: crm.CaseType = statusResult.caseTypeHint ?? visaTypeResult.caseType ?? "OTHER";

  if (!isBlank(rawRow.additionalItems)) {
    legacyRaw["Additional Items"] = rawRow.additionalItems;
  }
  if (statusResult.lineItemHint !== null) {
    legacyRaw["Status line item"] = statusResult.lineItemHint;
  }
  if (!isBlank(rawRow.dateOfBirthRaw)) {
    legacyRaw["DOB"] = rawRow.dateOfBirthRaw;
  }

  const parsedApplicantCount = Number(rawRow.applicantCount);
  const applicantCount =
    Number.isFinite(parsedApplicantCount) && parsedApplicantCount >= 1
      ? Math.trunc(parsedApplicantCount)
      : 1;

  const caseDraft: MappedCaseDraft = {
    caseType,
    destinationCountry: countryResult.countryCode ?? "",
    ...(visaTypeResult.visaType !== null ? { visaType: visaTypeResult.visaType } : {}),
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
  };

  const receivedDate = mapDateField(rawRow.receivedDateRaw, "C", reviewItems, legacyRaw);
  if (receivedDate !== undefined) caseDraft.receivedDate = receivedDate;
  const submissionDate = mapDateField(rawRow.subDateRaw, "Sub Date", reviewItems, legacyRaw);
  if (submissionDate !== undefined) caseDraft.submissionDate = submissionDate;
  const collectionDate = mapDateField(rawRow.collectionRaw, "Collection", reviewItems, legacyRaw);
  if (collectionDate !== undefined) caseDraft.expectedCollectionDate = collectionDate;

  return {
    caseRef: rawRow.caseRef,
    sourceSheet: MINI_CRM_SHEET_NAME,
    sourceRow: rawRow.sourceRow,
    partnerName: rawRow.partnerName,
    travellerFullName: rawRow.applicantsName,
    ...(isBlank(rawRow.passportNumber) ? {} : { passportNumber: rawRow.passportNumber }),
    applicantCount,
    caseDraft,
    reviewItems,
    legacyRaw,
  };
}
