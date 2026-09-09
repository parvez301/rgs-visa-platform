import type {
  ApplicantOutcome,
  CaseStatus,
  CaseType,
  CourierMode,
  CustodyStatus,
} from "../statuses";

export interface StatusNormalizationResult {
  caseStatus: CaseStatus | null;
  custody: CustodyStatus | null;
  outcome: ApplicantOutcome | null;
  courierMode: CourierMode | null;
  caseTypeHint: CaseType | null;
  lineItemHint: string | null;
  note: string | null;
  needsReview: boolean;
  rawValue: string;
}

type StatusMapping = Omit<StatusNormalizationResult, "needsReview" | "rawValue">;

const EMPTY_MAPPING: StatusMapping = {
  caseStatus: null,
  custody: null,
  outcome: null,
  courierMode: null,
  caseTypeHint: null,
  lineItemHint: null,
  note: null,
};

function mapping(overrides: Partial<StatusMapping>): StatusMapping {
  return { ...EMPTY_MAPPING, ...overrides };
}

/** Spec §6. Keys are uppercased and whitespace-collapsed. */
const MAPPING_BY_STATUS: Record<string, StatusMapping> = {
  "WORKING ON IT": mapping({ caseStatus: "IN_PROGRESS" }),
  "IN PROGRESS": mapping({ caseStatus: "IN_PROGRESS" }),
  "APPOINMENT SCHEDULED": mapping({ caseStatus: "APPOINTMENT_SET" }),
  "APPOINTMENT SCHEDULED": mapping({ caseStatus: "APPOINTMENT_SET" }),
  SUBMITTED: mapping({ caseStatus: "SUBMITTED", custody: "AT_EMBASSY" }),
  "ONLINE SUBMITTED": mapping({ caseStatus: "SUBMITTED", custody: "AT_EMBASSY" }),
  APPROVED: mapping({ caseStatus: "DECIDED", outcome: "APPROVED" }),
  REJECTED: mapping({ caseStatus: "DECIDED", outcome: "REJECTED" }),
  "SENT BACK": mapping({ caseStatus: "DECIDED", outcome: "SENT_BACK" }),

  "SENT ON COURIER": mapping({ custody: "IN_TRANSIT" }),
  DTDC: mapping({ custody: "IN_TRANSIT", courierMode: "DTDC" }),
  "SPEED POST": mapping({ custody: "IN_TRANSIT", courierMode: "SPEEDPOST" }),

  HANDOVER: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "HANDOVER" }),
  PICKUP: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "PICKUP" }),
  PORTER: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "PORTER" }),
  DELIVERED: mapping({ caseStatus: "CLOSED", custody: "RETURNED" }),

  "PASSPORT COLLECTION": mapping({ custody: "WITH_RGS" }),
  "PASSPORT ONLY": mapping({ custody: "WITH_RGS" }),

  "NOT SUBMITTED": mapping({ caseStatus: "NOT_SUBMITTED" }),
  "NOT PROCESSED": mapping({ caseStatus: "NOT_SUBMITTED" }),
  WITHDRAWAL: mapping({ caseStatus: "WITHDRAWN" }),
  "DUPLICATE ENTRY": mapping({ caseStatus: "DUPLICATE" }),

  "PAYMENT ONLY": mapping({ caseTypeHint: "OTHER" }),
  "DOCUMENTS ATTESTATION": mapping({ caseTypeHint: "ATTESTATION" }),
  "TICKET BOOKED": mapping({ lineItemHint: "TICKET_BOOKING" }),
  "REC: BIO LETTER": mapping({
    caseStatus: "IN_PROGRESS",
    note: "Biometrics letter received",
  }),
};

export function normalizeStatus(rawValue: string): StatusNormalizationResult {
  const lookupKey = rawValue.trim().toUpperCase().replace(/\s+/g, " ");
  if (lookupKey.length === 0) {
    return { ...EMPTY_MAPPING, needsReview: true, rawValue };
  }
  const matchedMapping = MAPPING_BY_STATUS[lookupKey];
  if (matchedMapping === undefined) {
    return { ...EMPTY_MAPPING, needsReview: true, rawValue };
  }
  return { ...matchedMapping, needsReview: false, rawValue };
}
