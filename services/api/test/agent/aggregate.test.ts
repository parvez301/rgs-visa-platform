import { afterEach, describe, expect, it } from "vitest";
import { aggregateTool } from "../../src/agent/tools/aggregate";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";

afterEach(closeSqlTestContexts);

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedCases(context: SqlTestContext, howMany: number) {
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
    const context = await buildSqlTestContext();
    await seedCases(context, 3);

    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR);

    expect(result).toEqual({ groupBy: "caseStatus", counts: { NEW: 3 }, total: 3 });
    // The point of the tool: no case objects come back at all.
    expect(JSON.stringify(result)).not.toContain("caseRef");
  });

  it("groups by destination country", async () => {
    const context = await buildSqlTestContext();
    await seedCases(context, 2);
    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "destinationCountry" }, ACTOR);
    expect(result).toEqual({ groupBy: "destinationCountry", counts: { JP: 2 }, total: 2 });
  });

  it("names the unreadable rows it could not count rather than quietly undercounting", async () => {
    const context = await buildSqlTestContext();
    await seedCases(context, 2);
    // One case row whose counted column is blank, so it cannot be counted.
    const stored = await context.sql.query<{ case_id: string }>(
      "select case_id from crm_cases where tenant_id = $1 order by case_ref limit 1",
      [TENANT_ID],
    );
    await context.sql.query("update crm_cases set case_status = '' where case_id = $1", [
      stored.rows[0]!.case_id,
    ]);

    const result = (await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR)) as {
      total: number;
      uncountedCaseIds: string[];
    };
    expect(result.total).toBe(1);
    expect(result.uncountedCaseIds).toEqual([stored.rows[0]!.case_id]);
  });
});
