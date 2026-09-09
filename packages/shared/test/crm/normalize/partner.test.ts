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
      expect(result.canonicalKey).toBe(rawValue.toUpperCase());
    }
  });

  it("sends blank input to review", () => {
    expect(normalizePartnerName("").needsReview).toBe(true);
    expect(normalizePartnerName("   ").canonicalKey).toBeNull();
  });

  it("folds a curly apostrophe so it does not split one partner into two records", () => {
    expect(normalizePartnerName("Ravi’s Travels").canonicalKey).toBe(
      normalizePartnerName("Ravi's Travels").canonicalKey,
    );
    expect(normalizePartnerName("Ravi’s Travels").canonicalKey).toBe("RAVI'S TRAVELS");
  });

  it("never throws on a non-string cell, routing it to review instead", () => {
    expect(() => normalizePartnerName(undefined)).not.toThrow();
    expect(normalizePartnerName(undefined).needsReview).toBe(true);
    expect(normalizePartnerName(undefined).rawValue).toBe("");

    expect(() => normalizePartnerName(null)).not.toThrow();
    expect(normalizePartnerName(null).needsReview).toBe(true);
    expect(normalizePartnerName(null).rawValue).toBe("");

    expect(() => normalizePartnerName(45658)).not.toThrow();
    const numericResult = normalizePartnerName(45658);
    expect(numericResult.needsReview).toBe(true);
    expect(numericResult.rawValue).toBe("45658");
  });
});
