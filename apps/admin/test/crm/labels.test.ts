import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  COURIER_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
  VISA_TYPE_LABELS,
  describeCustodyRollUp,
  describeOutcomeRollUp,
} from "../../src/crm/labels";

describe("display labels", () => {
  it("names every value of every axis, so no enum can reach a screen raw", () => {
    for (const caseStatus of crm.CASE_STATUSES) expect(CASE_STATUS_LABELS[caseStatus]).toBeTruthy();
    for (const custody of crm.CUSTODY_STATUSES) expect(CUSTODY_LABELS[custody]).toBeTruthy();
    for (const outcome of crm.APPLICANT_OUTCOMES) expect(OUTCOME_LABELS[outcome]).toBeTruthy();
    for (const billing of crm.BILLING_STATUSES) expect(BILLING_LABELS[billing]).toBeTruthy();
    for (const caseType of crm.CASE_TYPES) expect(CASE_TYPE_LABELS[caseType]).toBeTruthy();
    for (const visaType of crm.VISA_TYPES) expect(VISA_TYPE_LABELS[visaType]).toBeTruthy();
    for (const courierMode of crm.COURIER_MODES) expect(COURIER_LABELS[courierMode]).toBeTruthy();
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

  it("says so when the summary exists but names no custody state, rather than inventing a zero", () => {
    expect(describeCustodyRollUp({ count: 0, custody: {}, outcome: {} })).toBe("Not summarised");
  });
});

describe("describeOutcomeRollUp", () => {
  // Each summary below carries non-empty, non-matching custody data alongside
  // the outcome data under test. That is deliberate: describeOutcomeRollUp and
  // describeCustodyRollUp are one delegation to the same describeRollUp helper
  // differing only in which two arguments they pass, so a copy-paste that
  // wires this function to `summary?.custody, CUSTODY_LABELS` instead of
  // `summary?.outcome, OUTCOME_LABELS` is the single most likely way this
  // file breaks. With custody data present and different from the outcome
  // data, that mutation does not just go quiet -- it prints the wrong,
  // custody-shaped answer, which is what makes these tests catch it.
  it("states the single value when every applicant agrees", () => {
    expect(
      describeOutcomeRollUp({ count: 3, outcome: { APPROVED: 3 }, custody: { AT_EMBASSY: 3 } }),
    ).toBe("Approved");
  });

  it("counts each value when they disagree, commonest first", () => {
    expect(
      describeOutcomeRollUp({
        count: 3,
        outcome: { REJECTED: 2, SENT_BACK: 1 },
        custody: { WITH_RGS: 2, IN_TRANSIT: 1 },
      }),
    ).toBe("2 rejected · 1 sent back");
  });

  it("says so when the case has never been summarised, rather than inventing a zero", () => {
    expect(describeOutcomeRollUp(undefined)).toBe("Not summarised");
  });
});
