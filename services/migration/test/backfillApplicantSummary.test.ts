import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillApplicantSummary } from "../src/backfillApplicantSummary";

function buildContext(): AppContext & { table: InMemoryTableClient } {
  const table = new InMemoryTableClient();
  return {
    table,
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-11T10:00:00.000Z"),
  };
}

function buildCase(caseId: string): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
    tenantId: "rgs",
    caseId,
    caseRef: `RGS-${caseId}`,
    caseType: "VISA",
    visaType: "TOURIST",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "NEW",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    applicants: [
      { applicantRef: "A1", travellerId: "t1", custody: "WITH_RGS", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "t2", custody: "NOT_HELD", outcome: "PENDING" },
    ],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
  });
}

describe("backfillApplicantSummary", () => {
  it("gives a pre-existing case the roll-up it was written without", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));
    // Simulate the real stored state: written before Task 1 existed.
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { applicantSummary: _dropped, ...metaWithoutSummary } = metaItem!;
    await context.table.put(metaWithoutSummary as typeof metaItem & { PK: string; SK: string });

    const report = await backfillApplicantSummary(context, "rgs");

    const backfilled = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilled?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, NOT_HELD: 1 },
      outcome: { PENDING: 2 },
    });
    expect(report).toMatchObject({ scanned: 1, written: 1, alreadyCurrent: 0 });
  });

  it("leaves updatedAt alone, so a backfilled case does not jump the ledger's sort", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));

    await backfillApplicantSummary(context, "rgs");

    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(metaItem?.["updatedAt"]).toBe("2026-03-04T10:00:00.000Z");
  });

  it("is re-runnable: a second run writes nothing", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));

    await backfillApplicantSummary(context, "rgs");
    const secondReport = await backfillApplicantSummary(context, "rgs");

    expect(secondReport).toMatchObject({ scanned: 1, written: 0, alreadyCurrent: 1 });
  });

  it("names a case it cannot reassemble and keeps going", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));
    await writeCase(context, buildCase("case_2"));
    // A partition holding META with no applicant items -- exactly what a
    // timeout between writeCase's two writes leaves behind.
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#00");
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#01");

    const report = await backfillApplicantSummary(context, "rgs");

    expect(report.unreadableCaseIds).toEqual(["case_1"]);
    expect(report.written).toBe(0);
    expect(report.alreadyCurrent).toBe(1);
    // The half-written case keeps whatever it had. A fabricated count: 0
    // summary would say, on the Ledger, that this case has no applicants.
    const brokenMeta = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(brokenMeta?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, NOT_HELD: 1 },
      outcome: { PENDING: 2 },
    });
  });
});
