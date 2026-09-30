import { describe, expect, it } from "vitest";
import type { CountryProduct } from "@rgs/shared";
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
