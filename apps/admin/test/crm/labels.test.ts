import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
  describeCustodyRollUp,
} from "../../src/crm/labels";

describe("display labels", () => {
  it("names every value of every axis, so no enum can reach a screen raw", () => {
    for (const caseStatus of crm.CASE_STATUSES) expect(CASE_STATUS_LABELS[caseStatus]).toBeTruthy();
    for (const custody of crm.CUSTODY_STATUSES) expect(CUSTODY_LABELS[custody]).toBeTruthy();
    for (const outcome of crm.APPLICANT_OUTCOMES) expect(OUTCOME_LABELS[outcome]).toBeTruthy();
    for (const billing of crm.BILLING_STATUSES) expect(BILLING_LABELS[billing]).toBeTruthy();
  });

  it("uses RGS's own words, reviewable in one place", () => {
    expect(CUSTODY_LABELS.NOT_HELD).toBe("Not held");
    expect(CUSTODY_LABELS.WITH_RGS).toBe("With us");
    expect(CUSTODY_LABELS.AT_EMBASSY).toBe("At embassy");
    expect(CUSTODY_LABELS.IN_TRANSIT).toBe("In transit");
    expect(CUSTODY_LABELS.RETURNED).toBe("Returned");
  });
});

describe("describeCustodyRollUp", () => {
  it("states the single value when every applicant agrees", () => {
    expect(describeCustodyRollUp({ count: 3, custody: { AT_EMBASSY: 3 }, outcome: {} })).toBe(
      "At embassy",
    );
  });

  it("counts each value when they disagree, commonest first", () => {
    expect(
      describeCustodyRollUp({ count: 3, custody: { AT_EMBASSY: 2, WITH_RGS: 1 }, outcome: {} }),
    ).toBe("2 at embassy · 1 with us");
  });

  it("says so when the case has never been summarised, rather than inventing a zero", () => {
    expect(describeCustodyRollUp(undefined)).toBe("Not summarised");
  });
});
