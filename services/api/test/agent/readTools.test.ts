import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { buildTestContext, type TestContext } from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";
import { writeCase } from "../../src/domain/crm/caseStore";
import { putCountryChecklist } from "../../src/domain/crm/countryChecklist";
import { META_SORT_KEY, partnerListGsi1Pk, partnerPartitionKey } from "../../src/domain/crm/keys";
import type { AppContext } from "../../src/lib/context";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

/**
 * Writes a partner row indexed exactly like a real one -- listPartners' GSI1
 * query reaches it -- but whose body no longer satisfies PartnerSchema:
 * partnerType is gone. Mirrors the identical helper in
 * services/api/test/crm/partners.test.ts, which exists because createPartner
 * itself cannot produce this shape; only a half-written row or an older
 * importer format can.
 */
async function seedUnparseablePartnerItem(
  context: TestContext,
  tenantId: string,
  canonicalName: string,
  partnerId: string,
): Promise<string> {
  await context.table.put({
    PK: partnerPartitionKey(tenantId, partnerId),
    SK: META_SORT_KEY,
    GSI1PK: partnerListGsi1Pk(tenantId),
    GSI1SK: crm.normalizePartnerName(canonicalName).canonicalKey ?? "",
    tenantId,
    partnerId,
    canonicalName,
    aliases: [],
    createdAt: "2026-07-23T10:00:00.000Z",
  });
  return partnerId;
}

/**
 * Wraps a real context's table so a read still works but any put/delete
 * throws immediately. Identical in shape to the helper of the same name in
 * writeTools.test.ts -- duplicated rather than imported because that file
 * exports nothing, and a read tool reaching a write is exactly the bug this
 * counterpart property test exists to catch (P49): a read tool has no
 * `apply`, so the only seam an accidental write could ever occur on is
 * inside `execute` itself.
 */
function refuseWrites(context: TestContext, toolNameForMessage: string): AppContext {
  return {
    ...context,
    table: {
      get: (partitionKey, sortKey, options) => context.table.get(partitionKey, sortKey, options),
      query: (partitionKey, options) => context.table.query(partitionKey, options),
      queryGsi: (indexName, partitionKey, options) =>
        context.table.queryGsi(indexName, partitionKey, options),
      put: () => {
        throw new Error(`read tool "${toolNameForMessage}"'s execute reached put()`);
      },
      delete: () => {
        throw new Error(`read tool "${toolNameForMessage}"'s execute reached delete()`);
      },
    },
  };
}

/**
 * One valid, minimal input per read tool, built against fixtures seeded
 * through the real (write-allowed) context. Keyed by tool name so the
 * property test below can drive every tool in READ_TOOLS without knowing its
 * shape up front -- and so a read tool added later with no entry here fails
 * loudly instead of silently skipping the property it exists to prove.
 */
function minimalInputForReadTool(
  toolName: string,
  seededCase: { caseId: string },
): Record<string, unknown> {
  switch (toolName) {
    case "get_case":
      return { caseId: seededCase.caseId };
    case "search_cases":
      return { caseStatus: "NEW" };
    case "find_traveller":
      return { fullName: "ASHA RAO" };
    case "list_partners":
      return {};
    case "aggregate":
      return { groupBy: "caseStatus" };
    case "get_country_checklist":
      return { countryCode: "JP" };
    case "recall":
      return { scopes: ["ORG"] };
    default:
      throw new Error(`no minimal input registered for read tool "${toolName}" -- add one above`);
  }
}

describe("the read tool registry", () => {
  it("declares every read tool as kind 'read'", () => {
    const registry = new ToolRegistry(READ_TOOLS);
    expect(registry.writeTools()).toHaveLength(0);
    expect(registry.readTools().map((tool) => tool.name).sort()).toEqual(
      [
        "aggregate",
        "find_traveller",
        "get_case",
        "get_country_checklist",
        "list_partners",
        "recall",
        "search_cases",
      ],
    );
  });

  it("emits a JSON schema per tool, so a provider can be handed the definitions", () => {
    const definitions = new ToolRegistry(READ_TOOLS).toolDefinitions();
    const getCaseDefinition = definitions.find((definition) => definition.name === "get_case");
    expect(getCaseDefinition?.inputSchema).toMatchObject({ type: "object" });
    expect(getCaseDefinition?.description.length).toBeGreaterThan(10);
  });
});

// The read-side counterpart of writeTools.test.ts's "every WRITE_TOOLS tool
// proposes without writing" property test (P49). Write tools are gated by
// construction -- execute takes a write-refusing context and apply is the
// only path to the table -- but nothing enforced the same for reads until
// now: a read tool that slipped a put/delete into its execute would pass
// every other test in this file, because none of them run against a
// write-refusing context.
describe("every READ_TOOLS tool resolves without ever reaching the table's write side", () => {
  it.each(READ_TOOLS)("$name: execute resolves without reaching put() or delete()", async (tool) => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
    const seededCase = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "40099",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await putCountryChecklist(context, TENANT_ID, { countryCode: "JP", requiredDocuments: ["PASSPORT"] }, ACTOR);

    const input = minimalInputForReadTool(tool.name, seededCase);
    const writeRefusingContext = refuseWrites(context, tool.name);

    await expect(tool.execute(writeRefusingContext, TENANT_ID, input, ACTOR)).resolves.toBeDefined();
  });
});

describe("get_case", () => {
  it("returns the stored case", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", partnerType: "AGENCY" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
    const createdCase = await createCase(context, TENANT_ID, {
      caseRef: "40001", caseType: "VISA", visaType: "EVISA_TOURIST", partnerId: partner.partnerId,
      destinationCountry: "JP", receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    }, ACTOR);

    const tool = new ToolRegistry(READ_TOOLS).get("get_case");
    const result = await tool!.execute(context, TENANT_ID, { caseId: createdCase.caseId }, ACTOR);
    expect((result as { caseRef: string }).caseRef).toBe("40001");
  });

  it("rejects an input the schema does not accept, before touching the table", async () => {
    const tool = new ToolRegistry(READ_TOOLS).get("get_case");
    expect(() => tool!.inputSchema.parse({})).toThrow();
  });
});

describe("find_traveller", () => {
  it("finds by passport when one is given, and by name otherwise", async () => {
    const context = buildTestContext();
    await upsertTraveller(context, TENANT_ID, { fullName: "RAVI KUMAR", passportNumber: "Z1234567" });

    const tool = new ToolRegistry(READ_TOOLS).get("find_traveller");
    const byPassport = await tool!.execute(context, TENANT_ID, { passportNumber: "Z1234567" }, ACTOR);
    expect((byPassport as { travellers: unknown[] }).travellers).toHaveLength(1);

    const byName = await tool!.execute(context, TENANT_ID, { fullName: "RAVI KUMAR" }, ACTOR);
    expect((byName as { travellers: unknown[] }).travellers).toHaveLength(1);
  });
});

// --- The partial-results signal must reach whoever reads the tool's output. ---
// listCasesByStatus/listCasesByPartner and listPartners each skip a row they
// cannot reassemble rather than 500ing the whole listing, and name the skipped
// id in `unreadableCaseIds` / `unreadablePartnerIds` instead of dropping it in
// silence. A tool that destructured its way down to the bare array would throw
// that signal away right where it would otherwise reach the model -- and the
// desk operator downstream. These two tests exist to keep that from happening.
describe("search_cases", () => {
  it("surfaces unreadableCaseIds instead of dropping the row that would not parse", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", partnerType: "AGENCY" }, ACTOR);
    const healthyTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "HEALTHY TRAVELLER" });
    const healthyCase = await createCase(context, TENANT_ID, {
      caseRef: "40010", caseType: "VISA", visaType: "EVISA_TOURIST", partnerId: partner.partnerId,
      destinationCountry: "JP", receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: healthyTraveller.travellerId }],
    }, ACTOR);
    const corruptTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "CORRUPT TRAVELLER" });
    const corruptedCase = await createCase(context, TENANT_ID, {
      caseRef: "40011", caseType: "VISA", visaType: "EVISA_TOURIST", partnerId: partner.partnerId,
      destinationCountry: "JP", receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: corruptTraveller.travellerId }],
    }, ACTOR);
    // Same corruption pattern as services/api/test/crm/cases.test.ts:405-425:
    // write the case back with no applicant items, which readCase reports as
    // CorruptRecordError and a listing skips rather than 500ing on.
    await writeCase(context, { ...corruptedCase, applicants: [] });

    const tool = new ToolRegistry(READ_TOOLS).get("search_cases");
    const result = await tool!.execute(context, TENANT_ID, { caseStatus: "NEW" }, ACTOR);

    expect((result as { cases: { caseId: string }[] }).cases.map((c) => c.caseId)).toEqual([
      healthyCase.caseId,
    ]);
    expect((result as { unreadableCaseIds: string[] }).unreadableCaseIds).toEqual([
      corruptedCase.caseId,
    ]);
  });
});

describe("list_partners", () => {
  it("surfaces unreadablePartnerIds instead of dropping the row that would not parse", async () => {
    const context = buildTestContext();
    const healthyPartner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Luxe Escape", partnerType: "AGENCY" },
      ACTOR,
    );
    const corruptPartnerId = await seedUnparseablePartnerItem(
      context,
      TENANT_ID,
      "Ozzy Travels",
      "prt_half_written",
    );

    const tool = new ToolRegistry(READ_TOOLS).get("list_partners");
    const result = await tool!.execute(context, TENANT_ID, {}, ACTOR);

    expect((result as { partners: { partnerId: string }[] }).partners.map((p) => p.partnerId)).toEqual([
      healthyPartner.partnerId,
    ]);
    expect((result as { unreadablePartnerIds: string[] }).unreadablePartnerIds).toEqual([
      corruptPartnerId,
    ]);
  });
});
