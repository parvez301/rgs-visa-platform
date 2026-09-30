import { describe, expect, it } from "vitest";
import { DOC_TYPE_LABELS, labelForDocType, labelsForDocTypes } from "../src/docTypeLabels";

describe("docTypeLabels", () => {
  it("maps every DocType to a non-empty human label", () => {
    expect(labelForDocType("PASSPORT_BIO")).toBe("Passport bio page");
    expect(Object.values(DOC_TYPE_LABELS).every((label) => label.length > 0)).toBe(true);
  });

  it("keeps the public-facing qualifiers the client needs, not terse ops shorthand", () => {
    expect(labelForDocType("BANK_STATEMENT")).toBe("Bank statements (last 3–6 months)");
    expect(labelForDocType("YELLOW_FEVER_CERT")).toBe("Yellow fever vaccination certificate");
    expect(labelForDocType("ITR")).toBe("Income tax returns (last 2 years)");
  });

  it("dedupes labels when mapping a list of DocTypes", () => {
    expect(labelsForDocTypes(["PASSPORT_BIO", "PHOTO", "PASSPORT_BIO"])).toEqual([
      "Passport bio page",
      "Passport-size photo",
    ]);
  });
});
