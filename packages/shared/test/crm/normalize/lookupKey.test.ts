import { describe, expect, it } from "vitest";
import { buildLookupKey } from "../../../src/crm/normalize/lookupKey";

describe("buildLookupKey", () => {
  it("uppercases and trims", () => {
    expect(buildLookupKey("  ozzy travels  ")).toBe("OZZY TRAVELS");
  });

  it("collapses internal whitespace", () => {
    expect(buildLookupKey("Ozzy   Travels")).toBe("OZZY TRAVELS");
  });

  it("folds a curly apostrophe to a straight one", () => {
    expect(buildLookupKey("Ravi’s Travels")).toBe("RAVI'S TRAVELS");
    expect(buildLookupKey("Ravi's Travels")).toBe("RAVI'S TRAVELS");
  });

  it("makes the curly- and straight-apostrophe partner spellings collapse onto one key", () => {
    expect(buildLookupKey("Ravi’s Travels")).toBe(buildLookupKey("Ravi's Travels"));
  });
});
