import { DOC_TYPES, type DocType } from "./statuses";

/** Human labels for portal/CRM DocType enums — used when migrating Config → CRM checklists. */
export const DOC_TYPE_LABELS: Record<DocType, string> = {
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

export function labelForDocType(docType: DocType): string {
  return DOC_TYPE_LABELS[docType];
}

export function labelsForDocTypes(docTypes: readonly DocType[]): string[] {
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  for (const docType of docTypes) {
    if (!DOC_TYPES.includes(docType)) continue;
    const label = labelForDocType(docType);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    labels.push(label);
  }
  return labels;
}
