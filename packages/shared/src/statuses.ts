export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOCS_VERIFIED",
  "SENT_TO_IMMIGRATION",
  "APPROVED",
  "REJECTED",
  "DELIVERED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const PAYMENT_STATUSES = ["UNPAID", "REQUESTED", "PAID_OFFLINE"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const WIZARD_STEPS = ["travellers", "docs", "essentials", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const DOC_TYPES = [
  "PASSPORT_BIO",
  "PHOTO",
  "BANK_STATEMENT",
  "FLIGHT_ITINERARY",
  "HOTEL_BOOKING",
  "YELLOW_FEVER_CERT",
  "ITR",
  "EMPLOYMENT_PROOF",
  "COVER_LETTER",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type DocReviewStatus = (typeof DOC_REVIEW_STATUSES)[number];

export const ACTIVITY_EVENT_TYPES = [
  "SIGNED_UP",
  "APPLICATION_STARTED",
  "STEP_COMPLETED",
  "DOC_UPLOADED",
  "DOC_REVIEWED",
  "SUBMITTED",
  "STATUS_CHANGED",
  "PAYMENT_REQUESTED",
  "PAYMENT_MARKED_PAID",
  "LEAD_CREATED",
  "CONFIG_CHANGED",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
