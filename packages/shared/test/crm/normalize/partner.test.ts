import { describe, expect, it } from "vitest";
import { normalizePartnerName } from "../../../src/crm/normalize/partner";

describe("normalizePartnerName", () => {
  it("passes an ordinary agency through as its own canonical key", () => {
    expect(normalizePartnerName("Ozzy Travels")).toEqual({
      canonicalKey: "OZZY TRAVELS",
      partnerType: "AGENCY",
      needsReview: false,
      rawValue: "Ozzy Travels",
    });
  });

  it("collapses the VWI branches onto one partner", () => {
    for (const rawValue of ["VWI", "VWI BOM", "VWI Mumbai", "VWI HYDERABAD"]) {
      const result = normalizePartnerName(rawValue);
      expect(result.canonicalKey).toBe("VWI");
      expect(result.needsReview).toBe(false);
    }
  });

  it("treats direct walk-in business as its own partner type", () => {
    const result = normalizePartnerName("Customer A/C");
    expect(result.canonicalKey).toBe("CUSTOMER A/C");
    expect(result.partnerType).toBe("DIRECT");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizePartnerName("  travefly holidays  ").canonicalKey).toBe("TRAVEFLY HOLIDAYS");
  });

  it("flags the ambiguous personal accounts for a human", () => {
    for (const rawValue of ["MEHUL MEHUL", "MEHUL MANOJ", "SAMMY A/C"]) {
      const result = normalizePartnerName(rawValue);
      expect(result.needsReview).toBe(true);
      expect(result.rawValue).toBe(rawValue);
    }
  });

  it("sends blank input to review", () => {
    expect(normalizePartnerName("").needsReview).toBe(true);
    expect(normalizePartnerName("   ").canonicalKey).toBeNull();
  });
});
