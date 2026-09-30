import { describe, expect, it } from "vitest";
import {
  DOC_TYPES,
  DOC_TYPE_LABELS as sharedDocTypeLabels,
  labelsForDocTypes,
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
  docsRequired: ["PASSPORT_BIO", "PHOTO"],
  active: true,
};

describe("documentLabelsForMarketing", () => {
  it("prefers CRM checklist labels when present", () => {
    const labels = documentLabelsForMarketing({
      ...baseProduct,
      requiredDocumentLabels: ["Emirates ID copy", "Photo"],
    });
    expect(labels).toEqual(["Emirates ID copy", "Photo"]);
  });

  it("falls back to DocType labels when labels are absent", () => {
    expect(documentLabelsForMarketing(baseProduct)).toEqual([
      "Passport bio page",
      "Passport-size photo",
    ]);
  });

  it("falls back to DocType labels when labels are empty", () => {
    expect(
      documentLabelsForMarketing({ ...baseProduct, requiredDocumentLabels: [] }),
    ).toEqual(["Passport bio page", "Passport-size photo"]);
  });
});

/**
 * The seed maps Config `docsRequired` through shared's `labelsForDocTypes` and
 * writes the result into the CRM checklist, which then *wins* over this
 * fallback on the public page. If the two maps ever diverge, running the seed
 * rewrites client-facing copy with no diff to review — so pin that they agree.
 */
describe("public document copy has exactly one source", () => {
  it("uses the shared map rather than a marketing-local copy", () => {
    expect(DOC_TYPE_LABELS).toBe(sharedDocTypeLabels);
  });

  it("renders the same strings whether they come from the seed or the fallback", () => {
    const everyDocType = [...DOC_TYPES];
    expect(labelsForDocTypes(everyDocType)).toEqual(
      documentLabelsForMarketing({ ...baseProduct, docsRequired: everyDocType }),
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
