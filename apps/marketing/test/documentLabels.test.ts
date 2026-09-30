import { describe, expect, it } from "vitest";
import {
  DOC_TYPES,
  DOC_TYPE_LABELS as sharedDocTypeLabels,
  labelsForDocTypes,
  requiredDocumentsFromLegacyDocTypes,
  type CountryProduct,
} from "@rgs/shared";
import { DOC_TYPE_LABELS } from "../src/lib/countryContent";
import { documentLabelsForMarketing } from "../src/lib/documentLabels";

const baseProduct: CountryProduct = {
  countryCode: "AE",
  productCode: "AE_E_VISA",
  countryName: "United Arab Emirates",
  visaType: "E_VISA",
  region: "MIDDLE_EAST",
  tier: "FULFILLED",
  validityDays: 60,
  stayDays: 30,
  entry: "SINGLE",
  governmentFeeInr: 1000,
  serviceFeeInr: 500,
  processingDays: 3,
  requiredDocuments: requiredDocumentsFromLegacyDocTypes(["PASSPORT_BIO", "PHOTO"]),
  active: true,
};

describe("documentLabelsForMarketing", () => {
  it("returns requiredDocuments labels in order, mapped or not", () => {
    expect(
      documentLabelsForMarketing({
        ...baseProduct,
        requiredDocuments: [
          { label: "Emirates ID copy" },
          { label: "Photo", portalDocType: "PHOTO" },
        ],
      }),
    ).toEqual(["Emirates ID copy", "Photo"]);
  });

  it("uses the checklist labels of a legacy-converted product", () => {
    expect(documentLabelsForMarketing(baseProduct)).toEqual([
      "Passport bio page",
      "Passport-size photo",
    ]);
  });

  it("returns an empty list when there are no documents", () => {
    expect(documentLabelsForMarketing({ ...baseProduct, requiredDocuments: [] })).toEqual([]);
  });
});

/**
 * Seeds and the migration build `requiredDocuments` from DocTypes via shared's
 * `requiredDocumentsFromLegacyDocTypes`, so the public page shows shared's
 * DocType copy. Pin that the marketing map and those labels agree.
 */
describe("public document copy has exactly one source", () => {
  it("uses the shared map rather than a marketing-local copy", () => {
    expect(DOC_TYPE_LABELS).toBe(sharedDocTypeLabels);
  });

  it("renders the same strings as shared DocType labels", () => {
    const everyDocType = [...DOC_TYPES];
    expect(labelsForDocTypes(everyDocType)).toEqual(
      documentLabelsForMarketing({
        ...baseProduct,
        requiredDocuments: requiredDocumentsFromLegacyDocTypes(everyDocType),
      }),
    );
  });

  it("keeps the qualifying detail clients need to act on", () => {
    expect(DOC_TYPE_LABELS).toMatchObject({
      BANK_STATEMENT: "Bank statements (last 3–6 months)",
      FLIGHT_ITINERARY: "Return flight itinerary",
      HOTEL_BOOKING: "Hotel booking or stay proof",
      YELLOW_FEVER_CERT: "Yellow fever vaccination certificate",
      ITR: "Income tax returns (last 2 years)",
      EMPLOYMENT_PROOF: "Employment proof / business registration",
      COVER_LETTER: "Cover letter (we help you draft it)",
    });
  });
});
