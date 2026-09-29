import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { readRefClaim } from "@rgs/api/src/domain/crm/refClaims";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillRefClaims } from "../src/backfillRefClaims";

function buildContext(): AppContext & { table: InMemoryTableClient } {
  const table = new InMemoryTableClient();
  return {
    table,
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-29T10:00:00.000Z"),
  };
}

/** writeCase, not createCase: pre-feature data has no ref claims. */
async function seedCase(
  context: AppContext,
  caseId: string,
  caseRef: string,
  applicantRefNo?: string,
): Promise<void> {
  await writeCase(
    context,
    crm.CrmCaseSchema.parse({
      tenantId: "rgs",
      caseId,
      caseRef,
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseStatus: "NEW",
      billingStatus: "UNKNOWN",
      receivedDate: "2026-03-04",
      applicants: [
        {
          applicantRef: "A1",
          travellerId: "trav_1",
          custody: "WITH_RGS",
          outcome: "PENDING",
          ...(applicantRefNo !== undefined ? { refNo: applicantRefNo } : {}),
        },
      ],
      createdAt: "2026-03-04T10:00:00.000Z",
      updatedAt: "2026-03-04T10:00:00.000Z",
    }),
  );
}

async function openDuplicateRefItems(context: AppContext, caseRef: string) {
  const listing = await listReviewItems(context, "rgs", "OPEN");
  return listing.reviewItems.filter((item) => item.reason === "DUPLICATE_REF" && item.caseRef === caseRef);
}

describe("backfillRefClaims", () => {
  it("claims every stored REF, flags the second holder of a duplicate, and is re-runnable", async () => {
    const context = buildContext();
    await seedCase(context, "case_1", "38017");
    await seedCase(context, "case_2", "38017");
    await seedCase(context, "case_3", "40000", "40000-B");

    const firstReport = await backfillRefClaims(context, "rgs");

    expect(firstReport.scanned).toBe(3);
    expect(firstReport.duplicates).toHaveLength(1);
    expect(firstReport.duplicates[0]?.refValue).toBe("38017");
    expect(await readRefClaim(context, "rgs", "40000-B")).toBeDefined();
    expect(await openDuplicateRefItems(context, "38017")).toHaveLength(1);

    const secondReport = await backfillRefClaims(context, "rgs");
    expect(secondReport.claimed).toBe(0);
    expect(secondReport.duplicates).toHaveLength(1);
    // Re-running must not raise a second review item for the same clash.
    expect(await openDuplicateRefItems(context, "38017")).toHaveLength(1);
  });
});
