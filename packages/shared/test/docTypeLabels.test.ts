import { describe, expect, it } from "vitest";
import { DOC_TYPE_LABELS, labelForDocType, labelsForDocTypes } from "../src/docTypeLabels";

describe("docTypeLabels", () => {
  it("maps every DocType to a non-empty human label", () => {
    expect(labelForDocType("PASSPORT_BIO")).toBe("Passport bio page");
    expect(Object.values(DOC_TYPE_LABELS).every((label) => label.length > 0)).toBe(true);
  });

  it("dedupes labels when mapping a list of DocTypes", () => {
    expect(labelsForDocTypes(["PASSPORT_BIO", "PHOTO", "PASSPORT_BIO"])).toEqual([
      "Passport bio page",
      "Passport-size photo",
    ]);
  });
});
