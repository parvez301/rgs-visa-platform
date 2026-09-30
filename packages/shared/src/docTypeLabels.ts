import { DOC_TYPES, type DocType } from "./statuses";

/**
 * The one public-facing label per DocType. Client-visible everywhere: the
 * marketing country page, the portal docs step, and — via
 * `seedCountryChecklistsFromConfig` → `CountryChecklist.requiredDocuments` →
 * the merged `requiredDocumentLabels` on the public catalog — the copy a
 * fulfilled country's page shows once the seed has run. Terse variants of
 * these strings must not exist on that path: shortening one here changes what
 * a client is told they need to bring.
 */
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
