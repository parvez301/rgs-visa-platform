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
});
