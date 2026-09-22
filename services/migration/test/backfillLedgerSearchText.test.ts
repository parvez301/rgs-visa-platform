import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { upsertTraveller } from "@rgs/api/src/domain/crm/travellers";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillLedgerSearchText } from "../src/backfillLedgerSearchText";

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

async function seedCaseWithTravellers(
  context: AppContext,
  caseId: string,
): Promise<crm.CrmCase> {
  const asha = await upsertTraveller(context, "rgs", {
    fullName: "Asha Rao",
    passportNumber: "M1234567",
  });
  const crmCase = crm.CrmCaseSchema.parse({
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
      {
        applicantRef: "A1",
        travellerId: asha.travellerId,
        custody: "WITH_RGS",
        outcome: "PENDING",
      },
    ],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
  });
  await writeCase(context, crmCase);
  return crmCase;
}

describe("backfillLedgerSearchText", () => {
  it("gives a pre-existing case the searchText it was written without", async () => {
    const context = buildContext();
    await seedCaseWithTravellers(context, "case_1");
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { searchText: _dropped, ...metaWithoutSearchText } = metaItem!;
    await context.table.put(metaWithoutSearchText as typeof metaItem & { PK: string; SK: string });

    const report = await backfillLedgerSearchText(context, "rgs");

    const backfilled = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilled?.["searchText"]).toBe("asha rao m1234567");
    expect(report).toMatchObject({ scanned: 1, written: 1, alreadyCurrent: 0 });
  });

  it("leaves updatedAt alone so a backfilled case does not jump the ledger sort", async () => {
    const context = buildContext();
    await seedCaseWithTravellers(context, "case_1");
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { searchText: _dropped, ...metaWithoutSearchText } = metaItem!;
    await context.table.put(metaWithoutSearchText as typeof metaItem & { PK: string; SK: string });

    const report = await backfillLedgerSearchText(context, "rgs");

    expect(report.written).toBe(1);
    const backfilledMetaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilledMetaItem?.["updatedAt"]).toBe("2026-03-04T10:00:00.000Z");
  });

  it("is re-runnable: a second run writes nothing", async () => {
    const context = buildContext();
    await seedCaseWithTravellers(context, "case_1");

    await backfillLedgerSearchText(context, "rgs");
    const secondReport = await backfillLedgerSearchText(context, "rgs");

    expect(secondReport).toMatchObject({ scanned: 1, written: 0, alreadyCurrent: 1 });
  });
});
