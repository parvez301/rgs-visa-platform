import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate, isExcelSerialCandidate } from "../src/excelSerial";

describe("excelSerialToIsoDate", () => {
  it("uses the 1900 epoch, proven against a row present on both sheets", () => {
    // REF NO 31376: "2025 YEAR" Sub Date serial 45657, "Mini CRM" text "12/31/2024".
    expect(excelSerialToIsoDate(45657)).toBe("2024-12-31");
  });

  it("converts a second known serial from the same row", () => {
    expect(excelSerialToIsoDate(45931)).toBe("2025-10-01");
  });

  it("would NOT produce the right answer under the 1904 epoch", () => {
    // Guards the epoch constant against a well-meaning edit.
    expect(excelSerialToIsoDate(45657)).not.toBe("2029-01-01");
  });

  it("truncates a fractional serial to its date part", () => {
    expect(excelSerialToIsoDate(45657.75)).toBe("2024-12-31");
  });

  it("returns null outside the plausible business window", () => {
    expect(excelSerialToIsoDate(1)).toBeNull();       // 1899
    expect(excelSerialToIsoDate(60000)).toBeNull();   // 2064
  });

  it("recognises only finite numbers as serial candidates", () => {
    expect(isExcelSerialCandidate(45657)).toBe(true);
    expect(isExcelSerialCandidate("45657")).toBe(false);
    expect(isExcelSerialCandidate(Number.NaN)).toBe(false);
    expect(isExcelSerialCandidate(null)).toBe(false);
  });
});
