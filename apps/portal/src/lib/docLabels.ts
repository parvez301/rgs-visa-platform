import type { DocType } from "@rgs/shared";

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  PASSPORT_BIO: "Passport bio page",
  PHOTO: "Passport-size photo",
  BANK_STATEMENT: "Bank statements (last 3–6 months)",
  FLIGHT_ITINERARY: "Return flight itinerary",
  HOTEL_BOOKING: "Hotel booking or stay proof",
  YELLOW_FEVER_CERT: "Yellow fever vaccination certificate",
  ITR: "Income tax returns (last 2 years)",
  EMPLOYMENT_PROOF: "Employment proof / business registration",
  COVER_LETTER: "Cover letter (we help you draft it)",
};
