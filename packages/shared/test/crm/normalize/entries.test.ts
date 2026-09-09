import { describe, expect, it } from "vitest";
import { normalizeEntries } from "../../../src/crm/normalize/entries";

describe("normalizeEntries", () => {
  it("reads a plain entry count and defaults the speed to normal", () => {
    expect(normalizeEntries("Single")).toEqual({
      entryType: "SINGLE",
      processing: "NORMAL",
      validity: null,
      needsReview: false,
      rawValue: "Single",
    });
  });

  it("accepts every spelling of a plain single entry", () => {
    for (const rawValue of ["Single", "single", "Single entry", "X1"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("NORMAL");
      expect(result.needsReview).toBe(false);
    }
  });

  it("splits the express abbreviations", () => {
    for (const rawValue of ["Single Exp", "SINGLE/EXPRESS"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("EXPRESS");
    }
  });

  it("accepts every misspelling of single normal", () => {
    for (const rawValue of ["Single Nrml", "Single Normal", "Single Nrmal", "SINGLE/NORMAL"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("NORMAL");
      expect(result.needsReview).toBe(false);
    }
  });

  it("reads PL as premium lounge", () => {
    expect(normalizeEntries("Single PL").processing).toBe("PREMIUM_LOUNGE");
    expect(normalizeEntries("Double PL").processing).toBe("PREMIUM_LOUNGE");
    expect(normalizeEntries("Multiple PL").processing).toBe("PREMIUM_LOUNGE");
  });

  it("reads the double-entry family", () => {
    for (const rawValue of ["Double", "Double entry", "Double Nrml"]) {
      expect(normalizeEntries(rawValue).entryType).toBe("DOUBLE");
    }
    for (const rawValue of ["Double Exp", "DOUBLE EXPRESS", "DOUBLE/EXPRESS"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("DOUBLE");
      expect(result.processing).toBe("EXPRESS");
    }
  });

  it("pulls validity out of the multiple-entry variants", () => {
    expect(normalizeEntries("Multiple 10 Yr")).toEqual({
      entryType: "MULTIPLE",
      processing: "NORMAL",
      validity: "10Y",
      needsReview: false,
      rawValue: "Multiple 10 Yr",
    });
    expect(normalizeEntries("Multiple 10 Yr/").validity).toBe("10Y");
    expect(normalizeEntries("Multiple 1 Yr").validity).toBe("1Y");
    expect(normalizeEntries("Multiple 6 Months").validity).toBe("6M");
    expect(normalizeEntries("5 YR MULT").validity).toBe("5Y");
  });

  it("reads validity and express together", () => {
    expect(normalizeEntries("Multiple 1 Yr/E")).toEqual({
      entryType: "MULTIPLE",
      processing: "EXPRESS",
      validity: "1Y",
      needsReview: false,
      rawValue: "Multiple 1 Yr/E",
    });
  });

  it("reads the urgent three-month single", () => {
    expect(normalizeEntries("3 MONTHS SINGLE URGENT")).toEqual({
      entryType: "SINGLE",
      processing: "EXPRESS",
      validity: "3M",
      needsReview: false,
      rawValue: "3 MONTHS SINGLE URGENT",
    });
  });

  it("flags values that name a speed but no entry count", () => {
    const oneYearExpress = normalizeEntries("1 Yr Exp");
    expect(oneYearExpress.entryType).toBeNull();
    expect(oneYearExpress.processing).toBe("EXPRESS");
    expect(oneYearExpress.validity).toBe("1Y");
    expect(oneYearExpress.needsReview).toBe(true);

    const sixMonthExpress = normalizeEntries("6M Exp");
    expect(sixMonthExpress.validity).toBe("6M");
    expect(sixMonthExpress.needsReview).toBe(true);
  });

  it("sends column-shift junk to review", () => {
    for (const rawValue of ["Business", "Entries", "", "   "]) {
      const result = normalizeEntries(rawValue);
      expect(result.needsReview).toBe(true);
      expect(result.entryType).toBeNull();
    }
  });

  it("never throws on a non-string cell, routing it to review instead", () => {
    expect(() => normalizeEntries(undefined)).not.toThrow();
    expect(normalizeEntries(undefined).needsReview).toBe(true);
    expect(normalizeEntries(undefined).rawValue).toBe("");

    expect(() => normalizeEntries(null)).not.toThrow();
    expect(normalizeEntries(null).needsReview).toBe(true);
    expect(normalizeEntries(null).rawValue).toBe("");

    expect(() => normalizeEntries(45658)).not.toThrow();
    const numericResult = normalizeEntries(45658);
    expect(numericResult.needsReview).toBe(true);
    expect(numericResult.rawValue).toBe("45658");
  });
});
