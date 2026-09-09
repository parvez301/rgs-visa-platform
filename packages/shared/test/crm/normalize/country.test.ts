import { describe, expect, it } from "vitest";
import { normalizeCountry } from "../../../src/crm/normalize/country";

describe("normalizeCountry", () => {
  it("matches a clean name", () => {
    expect(normalizeCountry("China")).toEqual({
      countryCode: "CN",
      visaTypeHint: null,
      needsReview: false,
      rawValue: "China",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeCountry("  SOUTH AFRICA ").countryCode).toBe("ZA");
    expect(normalizeCountry("japan").countryCode).toBe("JP");
  });

  it("resolves the workbook's misspellings", () => {
    expect(normalizeCountry("SWISS").countryCode).toBe("CH");
    expect(normalizeCountry("SWIZTERLAND").countryCode).toBe("CH");
    expect(normalizeCountry("VEITNAM").countryCode).toBe("VN");
    expect(normalizeCountry("CROTIA").countryCode).toBe("HR");
    expect(normalizeCountry("ETHOPIA").countryCode).toBe("ET");
    expect(normalizeCountry("NETHERLAND").countryCode).toBe("NL");
    expect(normalizeCountry("NETHERLANDS").countryCode).toBe("NL");
    expect(normalizeCountry("SRILANKA").countryCode).toBe("LK");
  });

  it("resolves both Korea spellings to the South", () => {
    expect(normalizeCountry("KOREA").countryCode).toBe("KR");
    expect(normalizeCountry("SOUTH KOREA").countryCode).toBe("KR");
  });

  it("handles the apostrophe in Cote d'Ivoire", () => {
    expect(normalizeCountry("Cote d’Ivoire (Ivory Coast)").countryCode).toBe("CI");
    expect(normalizeCountry("Cote d'Ivoire (Ivory Coast)").countryCode).toBe("CI");
    expect("Cote d’Ivoire (Ivory Coast)").not.toBe("Cote d'Ivoire (Ivory Coast)");
  });

  it("carries the product hint out of 'Sri Lanka ETA'", () => {
    expect(normalizeCountry("Sri Lanka ETA")).toEqual({
      countryCode: "LK",
      visaTypeHint: "E_VISA",
      needsReview: false,
      rawValue: "Sri Lanka ETA",
    });
  });

  it("sends an unknown value to review instead of guessing", () => {
    const result = normalizeCountry("Wakanda");
    expect(result.countryCode).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(result.rawValue).toBe("Wakanda");
  });

  it("sends blank input to review", () => {
    expect(normalizeCountry("").needsReview).toBe(true);
    expect(normalizeCountry("   ").needsReview).toBe(true);
  });

  it("never throws on a non-string cell, routing it to review instead", () => {
    expect(() => normalizeCountry(undefined)).not.toThrow();
    expect(normalizeCountry(undefined).needsReview).toBe(true);
    expect(normalizeCountry(undefined).rawValue).toBe("");

    expect(() => normalizeCountry(null)).not.toThrow();
    expect(normalizeCountry(null).needsReview).toBe(true);
    expect(normalizeCountry(null).rawValue).toBe("");

    expect(() => normalizeCountry(45658)).not.toThrow();
    const numericResult = normalizeCountry(45658);
    expect(numericResult.needsReview).toBe(true);
    expect(numericResult.rawValue).toBe("45658");
  });

  it("maps the three destinations found missing in the real workbook", () => {
    // 91 rows across the workbook resolved to null before these were added.
    expect(normalizeCountry("CZECH REPUBLIC").countryCode).toBe("CZ");
    expect(normalizeCountry("Czech Republic").countryCode).toBe("CZ");
    expect(normalizeCountry("CZECH GROUP").countryCode).toBe("CZ");
    expect(normalizeCountry("ALGERIA").countryCode).toBe("DZ");
    // Dubai is a city; RGS books it as the UAE.
    expect(normalizeCountry("DUBAI").countryCode).toBe("AE");
  });

  it("still refuses to guess at a service line sitting in the country column", () => {
    // "TRAVEL INSURANCE" (21 rows) and "PASSPORT NEW" (34) are not destinations.
    expect(normalizeCountry("TRAVEL INSURANCE").countryCode).toBeNull();
    expect(normalizeCountry("TRAVEL INSURANCE").needsReview).toBe(true);
    expect(normalizeCountry("PASSPORT NEW").countryCode).toBeNull();
  });
});
