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
    // Same stripping fixture as the first test: a case whose summary is
    // already current takes the alreadyCurrent short-circuit and is never
    // written at all, which would make "updatedAt unchanged" true for the
    // wrong reason -- nothing touched the item. Dropping the summary forces
    // an actual write, so this test proves the round trip PRESERVES
    // updatedAt, not merely that a no-op leaves it alone.
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { applicantSummary: _dropped, ...metaWithoutSummary } = metaItem!;
    await context.table.put(metaWithoutSummary as typeof metaItem & { PK: string; SK: string });

    const report = await backfillApplicantSummary(context, "rgs");

    // Both assertions together are the point: either alone is what let a
    // bugged round trip (a fresh updatedAt on write) pass this test before.
    expect(report.written).toBe(1);
    const backfilledMetaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilledMetaItem?.["updatedAt"]).toBe("2026-03-04T10:00:00.000Z");
  });

  it("treats a content-equal summary in a different key order as already current", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));
    // InMemoryTableClient round-trips every put/get through structuredClone,
    // which preserves object key insertion order deterministically -- so no
    // test relying on that adapter alone can ever produce two differently-
    // ordered-but-equal summaries by accident. The order has to be forced by
    // hand, which is exactly what a hand-rolled JSON.stringify comparison
    // (rather than a structural one) is blind to: DynamoDB's own Map
    // attribute gives no guarantee its key order across a PutItem/Query round
    // trip matches the order `summariseApplicants` inserted them in.
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    await context.table.put({
      ...metaItem!,
      applicantSummary: {
        count: 2,
        // Same two keys, same two values as writeCase's own computed
        // summary -- inserted in the opposite order.
        custody: { NOT_HELD: 1, WITH_RGS: 1 },
        outcome: { PENDING: 2 },
      },
    });

    const report = await backfillApplicantSummary(context, "rgs");

    expect(report).toMatchObject({ scanned: 1, written: 0, alreadyCurrent: 1 });
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
