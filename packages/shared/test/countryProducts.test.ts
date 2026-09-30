import { describe, expect, it } from "vitest";
import {
  COUNTRY_PRODUCTS,
  UnknownCountryProductError,
  getCountryProduct,
  CountryProductSchema,
  documentLabelsFromProduct,
  getDocsChecklist,
  listActiveProducts,
  portalDocTypesFromProduct,
  requiredDocumentsFromLegacyDocTypes,
} from "../src/countryProducts";
import { DOC_TYPE_LABELS, docTypeForLabel } from "../src/docTypeLabels";

const V1_COUNTRY_CODES = ["AE", "AU", "CA", "NZ", "TZ", "UG", "NG", "ZM"] as const;

describe("country product catalog", () => {
  it("the 8 launch countries are the only active products", () => {
    const activeCodes = listActiveProducts()
      .map((countryProduct) => countryProduct.countryCode)
      .sort();
    expect(activeCodes).toEqual([...V1_COUNTRY_CODES].sort());
  });

  it("research-batch countries are seeded inactive and info-only until owner review", () => {
    const researchProducts = COUNTRY_PRODUCTS.filter(
      (countryProduct) => countryProduct.tier === "INFO_ONLY",
    );
    expect(researchProducts.length).toBeGreaterThanOrEqual(26);
    for (const researchProduct of researchProducts) {
      expect(researchProduct.active, researchProduct.countryCode).toBe(false);
      expect(researchProduct.officialUrl, researchProduct.countryCode).toBeTruthy();
    }
  });

  it("every fulfilled product carries positive fees, processing days, and a docs checklist", () => {
    for (const countryProduct of COUNTRY_PRODUCTS) {
      if (countryProduct.tier !== "FULFILLED") continue;
      expect(countryProduct.governmentFeeInr, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.serviceFeeInr, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.processingDays, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.requiredDocuments.length, countryProduct.countryCode).toBeGreaterThan(0);
      expect(portalDocTypesFromProduct(countryProduct), countryProduct.countryCode).toContain(
        "PASSPORT_BIO",
      );
    }
  });

  it("UAE is an e-visa product; Australia, Canada, New Zealand are assisted", () => {
    expect(getCountryProduct("AE").visaType).toBe("E_VISA");
    for (const assistedCountryCode of ["AU", "CA", "NZ"]) {
      expect(getCountryProduct(assistedCountryCode).visaType).toBe("ASSISTED");
    }
  });

  it("getCountryProduct resolves by country alone and by explicit product code", () => {
    const uaeProduct = getCountryProduct("AE");
    expect(uaeProduct.productCode).toBe("AE_TOURIST_30D_SINGLE");
    expect(getCountryProduct("AE", "AE_TOURIST_30D_SINGLE")).toEqual(uaeProduct);
  });

  it("throws a typed error for unknown lookups", () => {
    expect(() => getCountryProduct("XX")).toThrow(UnknownCountryProductError);
    expect(() => getCountryProduct("AE", "AE_WORK_VISA")).toThrow(UnknownCountryProductError);
    expect(() => getDocsChecklist("XX")).toThrow(UnknownCountryProductError);
  });

  it("docs checklist matches the country product", () => {
    expect(getDocsChecklist("AE")).toEqual(["PASSPORT_BIO", "PHOTO"]);
    expect(getDocsChecklist("AU")).toContain("BANK_STATEMENT");
  });
});

const baseCountryProduct = {
  countryCode: "AE",
  productCode: "AE_TOURIST",
  countryName: "UAE",
  visaType: "E_VISA",
  region: "MIDDLE_EAST",
  tier: "FULFILLED",
  validityDays: 30,
  stayDays: 30,
  entry: "SINGLE",
  governmentFeeInr: 0,
  serviceFeeInr: 0,
  processingDays: 3,
  active: true,
} as const;

describe("requiredDocuments schema", () => {
  it("accepts requiredDocuments and rejects duplicate portalDocType", () => {
    expect(
      CountryProductSchema.safeParse({
        ...baseCountryProduct,
        requiredDocuments: [
          { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
          { label: "Photo", portalDocType: "PASSPORT_BIO" },
        ],
      }).success,
    ).toBe(false);
    expect(
      CountryProductSchema.safeParse({
        ...baseCountryProduct,
        requiredDocuments: [
          { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
          { label: "Invitation letter" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate labels ignoring case and whitespace", () => {
    expect(
      CountryProductSchema.safeParse({
        ...baseCountryProduct,
        requiredDocuments: [{ label: "Invitation letter" }, { label: " invitation LETTER " }],
      }).success,
    ).toBe(false);
  });

  it("requires a non-empty checklist for fulfilled countries only", () => {
    expect(
      CountryProductSchema.safeParse({ ...baseCountryProduct, requiredDocuments: [] }).success,
    ).toBe(false);
    expect(
      CountryProductSchema.safeParse({
        ...baseCountryProduct,
        tier: "INFO_ONLY",
        requiredDocuments: [],
      }).success,
    ).toBe(true);
  });
});

describe("requiredDocuments helpers", () => {
  it("maps DOC_TYPE_LABELS back to DocType case-insensitively", () => {
    expect(docTypeForLabel("passport bio page")).toBe("PASSPORT_BIO");
    expect(docTypeForLabel("not a type")).toBeUndefined();
  });

  it("builds requiredDocuments from legacy DocTypes", () => {
    expect(requiredDocumentsFromLegacyDocTypes(["PASSPORT_BIO", "PHOTO"])).toEqual([
      { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
      { label: DOC_TYPE_LABELS.PHOTO, portalDocType: "PHOTO" },
    ]);
  });

  it("derives labels and portal DocTypes, skipping free-text rows for the latter", () => {
    const countryProduct = {
      ...baseCountryProduct,
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Invitation letter" },
      ],
    } as const;
    expect(documentLabelsFromProduct(countryProduct)).toEqual([
      "Passport bio page",
      "Invitation letter",
    ]);
    expect(portalDocTypesFromProduct(countryProduct)).toEqual(["PASSPORT_BIO"]);
  });
});
