export const CASE_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "APPOINTMENT_SET",
  "SUBMITTED",
  "DECIDED",
  "CLOSED",
  "NOT_SUBMITTED",
  "WITHDRAWN",
  "DUPLICATE",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses a case can still move out of. */
export const LIVE_CASE_STATUSES: readonly CaseStatus[] = [
  "NEW",
  "IN_PROGRESS",
  "APPOINTMENT_SET",
  "SUBMITTED",
];

/** Statuses that end a case. Nothing transitions out of these. */
export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = [
  "CLOSED",
  "NOT_SUBMITTED",
  "WITHDRAWN",
  "DUPLICATE",
];

export const CUSTODY_STATUSES = [
  "NOT_HELD",
  "WITH_RGS",
  "AT_EMBASSY",
  "IN_TRANSIT",
  "RETURNED",
] as const;
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number];

export const APPLICANT_OUTCOMES = ["PENDING", "APPROVED", "REJECTED", "SENT_BACK"] as const;
export type ApplicantOutcome = (typeof APPLICANT_OUTCOMES)[number];

export const BILLING_STATUSES = [
  "UNBILLED",
  "BILL_SENT",
  "PAID",
  "PART_PAID",
  "WRITTEN_OFF",
  "UNKNOWN",
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const CASE_TYPES = ["VISA", "ATTESTATION", "APOSTILLE", "PASSPORT", "OTHER"] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const VISA_TYPES = [
  "TOURIST",
  "BUSINESS",
  "EVISA_TOURIST",
  "B1_B2",
  "FAMILY_VISIT",
  "DEPENDENT",
  "STUDY",
  "WORK",
  "SEAMAN",
  "RELATIVE",
  "TRADE_FAIR",
  "SPORTS",
  "TRANSIT",
  "MDAC",
  "STP",
  "STR",
  "F_VISA",
  "VEVO",
  "E_VISA",
  "OTHER",
] as const;
export type VisaType = (typeof VISA_TYPES)[number];

export const ENTRY_TYPES = ["SINGLE", "DOUBLE", "MULTIPLE"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const PROCESSING_SPEEDS = ["NORMAL", "EXPRESS", "PREMIUM_LOUNGE"] as const;
export type ProcessingSpeed = (typeof PROCESSING_SPEEDS)[number];

export const COURIER_MODES = [
  "DTDC",
  "SPEEDPOST",
  "BLUEDART",
  "PORTER",
  "HANDOVER",
  "PICKUP",
] as const;
export type CourierMode = (typeof COURIER_MODES)[number];

export const PARTNER_TYPES = ["AGENCY", "CORPORATE", "DIRECT"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const LINE_ITEM_KINDS = ["SERVICE", "GOVT_FEE", "ADDON"] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];
