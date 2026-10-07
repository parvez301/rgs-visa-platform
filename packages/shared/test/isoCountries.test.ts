import { describe, expect, it } from "vitest";
import { ISO_COUNTRIES, isoCountryName } from "../src/isoCountries";

describe("ISO_COUNTRIES", () => {
  it("has unique ISO-3166 alpha-2 codes and English names", () => {
    expect(ISO_COUNTRIES.length).toBeGreaterThanOrEqual(240);
    const codes = ISO_COUNTRIES.map((country) => country.countryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const country of ISO_COUNTRIES) {
      expect(country.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(country.countryName.length).toBeGreaterThan(1);
    }
  });

  it("looks up common CRM destinations by code", () => {
    expect(isoCountryName("AE")).toBe("United Arab Emirates");
    expect(isoCountryName("AU")).toBe("Australia");
    expect(isoCountryName("GB")).toBe("United Kingdom");
    expect(isoCountryName("XX")).toBeUndefined();
  });
});
