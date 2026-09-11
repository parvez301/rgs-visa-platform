import { describe, expect, it } from "vitest";
import { aggregateTool } from "../../src/agent/tools/aggregate";
import { buildTestContext, type TestContext } from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";
import { META_SORT_KEY, casePartitionKey, caseStatusGsi1Pk } from "../../src/domain/crm/keys";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedCases(context: TestContext, howMany: number) {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  for (let caseIndex = 0; caseIndex < howMany; caseIndex += 1) {
    await createCase(
      context,
      TENANT_ID,
      {
        caseRef: `5000${caseIndex}`,
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
  }
  return partner;
}

describe("aggregate", () => {
  it("returns counts, never the underlying rows", async () => {
    const context = buildTestContext();
    await seedCases(context, 3);

    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR);

    expect(result).toEqual({ groupBy: "caseStatus", counts: { NEW: 3 }, total: 3 });
    // The point of the tool: no case objects come back at all.
    expect(JSON.stringify(result)).not.toContain("caseRef");
  });

  it("groups by destination country", async () => {
    const context = buildTestContext();
    await seedCases(context, 2);
    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "destinationCountry" }, ACTOR);
    expect(result).toEqual({ groupBy: "destinationCountry", counts: { JP: 2 }, total: 2 });
  });

  it("names the unreadable rows it could not count rather than quietly undercounting", async () => {
    const context = buildTestContext();
    await seedCases(context, 1);
    // A META item indexed under NEW whose body carries no caseStatus at all --
    // built with the same key builders writeCase itself uses, per the ban on
    // writing a raw CRM key literal outside keys.ts.
    await context.table.put({
      PK: casePartitionKey(TENANT_ID, "broken"),
      SK: META_SORT_KEY,
      GSI1PK: caseStatusGsi1Pk(TENANT_ID, "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: TENANT_ID,
      caseId: "broken",
    });

    const result = (await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR)) as {
      total: number;
      uncountedCaseIds: string[];
    };
    expect(result.total).toBe(1);
    expect(result.uncountedCaseIds).toHaveLength(1);
  });
});
