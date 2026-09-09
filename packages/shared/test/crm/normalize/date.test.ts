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
});
