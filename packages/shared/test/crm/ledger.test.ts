import { describe, expect, it } from "vitest";
import { LedgerRowSchema, summariseApplicants } from "../../src/crm/ledger";

describe("summariseApplicants", () => {
  it("counts each custody and outcome value that actually occurs", () => {
    const summary = summariseApplicants([
      { custody: "AT_EMBASSY", outcome: "PENDING" },
      { custody: "AT_EMBASSY", outcome: "PENDING" },
      { custody: "WITH_RGS", outcome: "APPROVED" },
    ]);

    expect(summary.count).toBe(3);
    expect(summary.custody).toEqual({ AT_EMBASSY: 2, WITH_RGS: 1 });
    expect(summary.outcome).toEqual({ PENDING: 2, APPROVED: 1 });
  });

  it("omits a state nobody is in rather than writing it as zero", () => {
    const summary = summariseApplicants([{ custody: "NOT_HELD", outcome: "PENDING" }]);

    expect(Object.keys(summary.custody)).toEqual(["NOT_HELD"]);
    expect(summary.custody.RETURNED).toBeUndefined();
  });

  it("summarises an empty applicant list as a count of zero, not as an error", () => {
    // A case cannot legally have no applicants, but a half-written partition
    // can, and a summariser that throws there turns a storage defect into a
    // crash in the one function every write path runs through.
    expect(summariseApplicants([])).toEqual({ count: 0, custody: {}, outcome: {} });
  });
});

describe("LedgerRowSchema", () => {
  const validRow = {
    caseId: "case_1",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-05T09:00:00.000Z",
    applicantSummary: { count: 1, custody: { WITH_RGS: 1 }, outcome: { PENDING: 1 } },
  };

  it("parses a projected META item", () => {
    expect(LedgerRowSchema.parse(validRow).caseRef).toBe("RGS-1001");
  });

  it("accepts a row with no applicantSummary, because 7,156 stored cases predate it", () => {
    const { applicantSummary: _omitted, ...rowWithoutSummary } = validRow;
    expect(LedgerRowSchema.parse(rowWithoutSummary).applicantSummary).toBeUndefined();
  });

  it("refuses a summary naming a custody state that does not exist", () => {
    expect(() =>
      LedgerRowSchema.parse({
        ...validRow,
        applicantSummary: { count: 1, custody: { LOST_IN_TRANSIT: 1 }, outcome: {} },
      }),
    ).toThrow();
  });
});
