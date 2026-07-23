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
  it("contains exactly the 8 v1 countries, all active", () => {
    const countryCodes = COUNTRY_PRODUCTS.map((countryProduct) => countryProduct.countryCode).sort();
    expect(countryCodes).toEqual([...V1_COUNTRY_CODES].sort());
    expect(listActiveProducts()).toHaveLength(8);
  });

  it("every product carries positive fees, processing days, and a docs checklist", () => {
    for (const countryProduct of COUNTRY_PRODUCTS) {
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
    expect(() => getCountryProduct("FR")).toThrow(UnknownCountryProductError);
    expect(() => getCountryProduct("AE", "AE_WORK_VISA")).toThrow(UnknownCountryProductError);
    expect(() => getDocsChecklist("FR")).toThrow(UnknownCountryProductError);
  });

  it("docs checklist matches the country product", () => {
    expect(getDocsChecklist("AE")).toEqual(["PASSPORT_BIO", "PHOTO"]);
    expect(getDocsChecklist("AU")).toContain("BANK_STATEMENT");
  });
});
