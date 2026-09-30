import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { META_SORT_KEY, casePartitionKey, caseStatusGsi1Pk } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillCaseStatusRename } from "../src/backfillCaseStatusRename";

function buildContext(): AppContext & { table: InMemoryTableClient } {
  const table = new InMemoryTableClient();
  return {
    table,
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  };
}

async function seedCase(context: AppContext, caseId: string, caseStatus: crm.CaseStatus): Promise<void> {
  await writeCase(
    context,
    crm.CrmCaseSchema.parse({
      tenantId: "rgs",
      caseId,
      caseRef: `REF-${caseId}`,
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseStatus,
      billingStatus: "UNKNOWN",
      receivedDate: "2026-03-04",
      applicants: [{ applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" }],
      createdAt: "2026-03-04T10:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
    }),
  );
}

/** Puts the case back into its pre-rename stored shape: raw IN_PROGRESS on the item and the old GSI1PK. */
async function downgradeToLegacy(context: AppContext & { table: InMemoryTableClient }, caseId: string): Promise<void> {
  const metaItem = await context.table.get(casePartitionKey("rgs", caseId), META_SORT_KEY);
  if (metaItem === undefined) throw new Error("seed missing");
  await context.table.put({ ...metaItem, caseStatus: "IN_PROGRESS", GSI1PK: caseStatusGsi1Pk("rgs", "IN_PROGRESS") });
}

describe("backfillCaseStatusRename", () => {
  it("rewrites IN_PROGRESS cases to DOCS_UNDER_REVIEW with the new GSI1PK, leaves others alone, and is idempotent", async () => {
    const context = buildContext();
    await seedCase(context, "case_1", "NEW");
    await seedCase(context, "case_2", "NEW");
    await seedCase(context, "case_3", "SUBMITTED");
    await downgradeToLegacy(context, "case_1");
    await downgradeToLegacy(context, "case_2");

    const firstReport = await backfillCaseStatusRename(context, "rgs");
    expect(firstReport).toEqual({ scanned: 2, renamed: 2, unreadableCaseIds: [] });

    const renamedMeta = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(renamedMeta?.["caseStatus"]).toBe("DOCS_UNDER_REVIEW");
    expect(renamedMeta?.["GSI1PK"]).toBe(caseStatusGsi1Pk("rgs", "DOCS_UNDER_REVIEW"));
    expect(renamedMeta?.["GSI1SK"]).toBe("2026-03-05T10:00:00.000Z");
    expect((await readCase(context, "rgs", "case_2"))?.caseStatus).toBe("DOCS_UNDER_REVIEW");
    expect((await readCase(context, "rgs", "case_3"))?.caseStatus).toBe("SUBMITTED");
    expect(await context.table.queryGsi("GSI1", caseStatusGsi1Pk("rgs", "IN_PROGRESS"))).toHaveLength(0);

    const secondReport = await backfillCaseStatusRename(context, "rgs");
    expect(secondReport).toEqual({ scanned: 0, renamed: 0, unreadableCaseIds: [] });
    expect((await readCase(context, "rgs", "case_1"))?.caseStatus).toBe("DOCS_UNDER_REVIEW");
  });

  it("reports a legacy case that cannot be reassembled instead of writing it", async () => {
    const context = buildContext();
    await seedCase(context, "case_1", "NEW");
    await downgradeToLegacy(context, "case_1");
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#00");

    const report = await backfillCaseStatusRename(context, "rgs");
    expect(report.renamed).toBe(0);
    expect(report.unreadableCaseIds).toEqual(["case_1"]);
  });
});
