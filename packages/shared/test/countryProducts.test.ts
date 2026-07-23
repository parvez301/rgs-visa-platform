import { describe, expect, it } from "vitest";
import {
  COUNTRY_PRODUCTS,
  UnknownCountryProductError,
  getCountryProduct,
  getDocsChecklist,
  listActiveProducts,
} from "../src/countryProducts";

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
      expect(countryProduct.docsRequired.length, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.docsRequired, countryProduct.countryCode).toContain("PASSPORT_BIO");
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
