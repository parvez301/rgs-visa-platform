import type {
  ApplicationStatus,
  DocType,
  PaymentStatus,
} from "@rgs/shared";

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  DOCS_VERIFIED: "Docs verified",
  SENT_TO_IMMIGRATION: "At immigration",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DELIVERED: "Delivered",
};

export const DOC_LABELS: Record<DocType, string> = {
  PASSPORT_BIO: "Passport bio page",
  PHOTO: "Passport-size photo",
  BANK_STATEMENT: "Bank statements",
  FLIGHT_ITINERARY: "Flight itinerary",
  HOTEL_BOOKING: "Hotel booking",
  YELLOW_FEVER_CERT: "Yellow fever cert",
  ITR: "ITR",
  EMPLOYMENT_PROOF: "Employment proof",
  COVER_LETTER: "Cover letter",
};

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  UNPAID: "Unpaid",
  REQUESTED: "Requested",
  PAID_OFFLINE: "Paid",
};

/** Who owes the next step — remappable in one place (handoff D5). */
export const STATUS_BUCKETS = [
  {
    key: "NEEDS_ACTION",
    label: "Needs your action",
    accent: "attention",
    statuses: ["SUBMITTED", "DOCS_VERIFIED", "APPROVED"] as const,
  },
  {
    key: "IN_PROGRESS",
    label: "In progress",
    accent: "neutral",
    statuses: ["DRAFT", "SENT_TO_IMMIGRATION"] as const,
  },
  {
    key: "DONE",
    label: "Done",
    accent: "positive",
    statuses: ["DELIVERED", "REJECTED"] as const,
  },
] as const;

export type StatusBucket = (typeof STATUS_BUCKETS)[number];
