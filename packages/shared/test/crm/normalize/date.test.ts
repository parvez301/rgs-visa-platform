import { describe, expect, it } from "vitest";
import { normalizeExcelDate } from "../../../src/crm/normalize/date";

describe("normalizeExcelDate", () => {
  it("passes a real Date cell through", () => {
    const result = normalizeExcelDate(new Date(Date.UTC(2025, 0, 8)));
    expect(result.isoDate).toBe("2025-01-08");
    expect(result.needsReview).toBe(false);
  });

  it("reads the dash format as day-first", () => {
    expect(normalizeExcelDate("30-12-2024").isoDate).toBe("2024-12-30");
    expect(normalizeExcelDate("26-12-2024").isoDate).toBe("2024-12-26");
  });

  it("reads the slash format as day-first, matching Indian convention", () => {
    expect(normalizeExcelDate("01/05/2025").isoDate).toBe("2025-05-01");
    expect(normalizeExcelDate("02/07/2026").isoDate).toBe("2026-07-02");
  });

  it("reads a day above 12 day-first, unambiguously", () => {
    // 13 cannot be a month, so day-first resolves this outright.
    expect(normalizeExcelDate("13-08-2025").isoDate).toBe("2025-08-13");
  });

  it("falls back to month-first only when day-first is impossible", () => {
    // Day-first would mean month 13, which does not exist — so this is 13 August.
    expect(normalizeExcelDate("08-13-2025").isoDate).toBe("2025-08-13");
  });

  it("stays day-first when both readings are valid", () => {
    // 05/09 is ambiguous; the sheet is day-first, so this is 5 September.
    expect(normalizeExcelDate("05/09/2026").isoDate).toBe("2026-09-05");
  });

  it("tolerates the stray spaces the sheet contains", () => {
    expect(normalizeExcelDate("  15-11-2025 ").isoDate).toBe("2025-11-15");
    expect(normalizeExcelDate("01 /09/2026").isoDate).toBe("2026-09-01");
  });

  it("sends dates outside a sane window to review", () => {
    expect(normalizeExcelDate("01-01-2006").needsReview).toBe(true);
    expect(normalizeExcelDate("01-01-2030").needsReview).toBe(true);
  });

  it("sends unparseable and empty values to review", () => {
    expect(normalizeExcelDate("not a date").needsReview).toBe(true);
    expect(normalizeExcelDate("").needsReview).toBe(true);
    expect(normalizeExcelDate(null).needsReview).toBe(true);
    expect(normalizeExcelDate(undefined).needsReview).toBe(true);
  });

  it("preserves the original for the review queue", () => {
    expect(normalizeExcelDate("not a date").rawValue).toBe("not a date");
  });

  it("rejects impossible calendar dates rather than rolling them over", () => {
    // 31 February and 30 February do not exist. A naive parser would roll
    // these into March; the round-trip check in isRealCalendarDate must not.
    expect(normalizeExcelDate("31-02-2025").isoDate).toBeNull();
    expect(normalizeExcelDate("31-02-2025").needsReview).toBe(true);
    expect(normalizeExcelDate("30-02-2025").isoDate).toBeNull();
    // 31 April likewise — and note neither reading (day-first nor
    // month-first) is valid here, so it must fall through to review.
    expect(normalizeExcelDate("31-04-2025").needsReview).toBe(true);
  });

  it("routes a raw numeric Excel serial to review rather than guessing an epoch", () => {
    expect(normalizeExcelDate(45658).needsReview).toBe(true);
    expect(normalizeExcelDate(45658).isoDate).toBeNull();
  });

  it("reads the ISO shape the reader emits for a Date cell", () => {
    // readWorkbook.ts converts a Date cell to "YYYY-MM-DD" (UTC) before this
    // function ever sees it. A 4-digit year FIRST does not match the
    // dd-mm-yyyy branch above, so this needs its own branch.
    expect(normalizeExcelDate("2025-06-12")).toEqual({
      isoDate: "2025-06-12",
      needsReview: false,
      rawValue: "2025-06-12",
    });
  });

  it("sends an ISO date outside the sane window to review, while accepting one just inside it", () => {
    // Review round 1, Minor 4: asserting only the rejection is vacuous — an
    // ISO-shaped string can NEVER match the dd-mm-yyyy branch's pattern
    // (that branch requires a 4-digit group LAST, not first), so deleting
    // the entire ISO branch also sends "2019-06-12" to review, for the
    // unrelated reason that nothing matched at all. Pairing the rejection
    // with the boundary-year acceptance in the same test means deleting the
    // whole branch turns "2020-06-12" into a rejection too, which fails the
    // acceptance assertion below — that is what makes this test prove the
    // branch exists, not just that this one input is rejected.
    expect(normalizeExcelDate("2019-06-12")).toEqual({
      isoDate: null,
      needsReview: true,
      rawValue: "2019-06-12",
    });
    expect(normalizeExcelDate("2020-06-12")).toEqual({
      isoDate: "2020-06-12",
      needsReview: false,
      rawValue: "2020-06-12",
    });
  });

  it("rejects an ISO date that is not a real calendar day, while accepting a neighboring real one", () => {
    // Same discrimination as above, for isRealCalendarDate rather than
    // isPlausibleYear: pairing the Feb-30 rejection with the Feb-28
    // acceptance (same year, so isPlausibleYear is not what's under test)
    // means deleting the whole ISO branch — or just its calendar check —
    // shows up as the acceptance assertion failing, not only the rejection.
    expect(normalizeExcelDate("2025-02-30")).toEqual({
      isoDate: null,
      needsReview: true,
      rawValue: "2025-02-30",
    });
    expect(normalizeExcelDate("2025-02-28")).toEqual({
      isoDate: "2025-02-28",
      needsReview: false,
      rawValue: "2025-02-28",
    });
  });

  it("does not throw on an invalid Date object, routing it to review instead", () => {
    const invalidDate = new Date("nonsense");
    expect(() => normalizeExcelDate(invalidDate)).not.toThrow();
    const result = normalizeExcelDate(invalidDate);
    expect(result.isoDate).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(result.rawValue).toBe("Invalid Date");
  });
});
