import { describe, expect, it } from "vitest";
import { joinPhones } from "../src/joinPhones";
import type { MappedRow } from "../src/mapRow";

const rowFor = (caseRef: string) => ({ caseRef }) as MappedRow;

describe("joinPhones", () => {
  it("recovers a phone from the 2025 YEAR sheet by REF NO", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [{ sourceRow: 2, caseRef: "31376", phoneRaw: "9812345670", trackingNumber: "DTDC9911" }],
    );
    expect(joined.get("31376")).toEqual({ phone: "9812345670", trackingNumber: "DTDC9911" });
  });

  it("omits a phone that is not a plausible Indian mobile but keeps the tracking number", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [{ sourceRow: 2, caseRef: "31376", phoneRaw: "723001238", trackingNumber: "X1" }],
    );
    expect(joined.get("31376")?.phone).toBeUndefined();
    expect(joined.get("31376")?.trackingNumber).toBe("X1");
  });

  it("ignores year rows with no matching case", () => {
    const joined = joinPhones([rowFor("31376")], [{ sourceRow: 2, caseRef: "99999", phoneRaw: "9812345670", trackingNumber: "" }]);
    expect(joined.has("99999")).toBe(false);
  });

  // Ruling (task-8): "2025 YEAR" row 1844, column 10 holds the literal string
  // "Mukesh Kumar" in the Phone column -- a name shifted there by a bad
  // paste. It must be kept and flagged, never dropped and never coerced.
  it("keeps and flags a non-numeric phone cell instead of dropping it (the pinned 'Mukesh Kumar' row)", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [{ sourceRow: 1844, caseRef: "31376", phoneRaw: "Mukesh Kumar", trackingNumber: "" }],
    );
    expect(joined.get("31376")?.phone).toBeUndefined();
    expect(joined.get("31376")?.flaggedPhoneRaw).toBe("Mukesh Kumar");
  });

  // "2025 YEAR" duplicates 18 refs of its own. Building a fresh object per
  // row and `set`ting it unconditionally meant a later blank cell overwrote
  // an earlier real value -- measured, that lost data on 4 refs.
  it("does not let a later blank row overwrite a tracking number an earlier one had", () => {
    const joined = joinPhones(
      [rowFor("31140")],
      [
        { sourceRow: 61, caseRef: "31140", phoneRaw: "", trackingNumber: "25DEL3G0001287" },
        { sourceRow: 105, caseRef: "31140", phoneRaw: "", trackingNumber: "" },
      ],
    );
    expect(joined.get("31140")?.trackingNumber).toBe("25DEL3G0001287");
  });

  it("fills each field from the first row that has it, across duplicate refs", () => {
    const joined = joinPhones(
      [rowFor("35206")],
      [
        { sourceRow: 3829, caseRef: "35206", phoneRaw: "", trackingNumber: "DEL438907SA13542025" },
        { sourceRow: 3830, caseRef: "35206", phoneRaw: "9812345670", trackingNumber: "" },
      ],
    );
    expect(joined.get("35206")).toEqual({
      trackingNumber: "DEL438907SA13542025",
      phone: "9812345670",
    });
  });

  it("records a disagreeing value from a duplicate ref rather than dropping it", () => {
    // Ref 33356 on the real sheet: row 1989 carries phone 9844544233, row
    // 2176 carries 9891842385. One of them has to lose; neither may vanish.
    const joined = joinPhones(
      [rowFor("33356")],
      [
        { sourceRow: 1989, caseRef: "33356", phoneRaw: "9844544233", trackingNumber: "" },
        { sourceRow: 2176, caseRef: "33356", phoneRaw: "9891842385", trackingNumber: "" },
      ],
    );
    expect(joined.get("33356")?.phone).toBe("9844544233");
    expect(joined.get("33356")?.conflictingValues).toEqual([
      'Phone 9891842385 ("2025 YEAR" row 2176)',
    ]);
  });

  it("does not call two rows agreeing a conflict", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [
        { sourceRow: 2, caseRef: "31376", phoneRaw: "9812345670", trackingNumber: "" },
        { sourceRow: 3, caseRef: "31376", phoneRaw: "9812345670", trackingNumber: "" },
      ],
    );
    expect(joined.get("31376")?.conflictingValues).toBeUndefined();
  });
});
