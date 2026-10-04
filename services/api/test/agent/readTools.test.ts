import { crm, getCountryProduct } from "@rgs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import {
  buildTestContext,
  closeTestContexts,
  contextRefusingWrites,
  type TestContext,
} from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { CASE_COUNT_GROUP_BY_FIELDS, createCase } from "../../src/domain/crm/cases";
import { writeCase } from "../../src/domain/crm/caseStore";
import { upsertCountryProduct } from "../../src/domain/config";

afterEach(closeTestContexts);

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

/**
 * Writes a partner row that listPartners reaches but whose body no longer
 * satisfies PartnerSchema: partnerType is gone. Mirrors the identical row in
 * test/crm/crmApi.test.ts, which exists because createPartner itself cannot
 * produce this shape; only a half-written row or an older importer format can.
 */
async function seedUnparseablePartnerItem(
  context: TestContext,
  tenantId: string,
  canonicalName: string,
  partnerId: string,
): Promise<string> {
  await context.sql.query(
    `insert into crm_partners (
       tenant_id, partner_id, canonical_name, canonical_key, aliases, created_at, updated_at
     ) values ($1, $2, $3, $4, '[]'::jsonb, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
    [tenantId, partnerId, canonicalName, crm.normalizePartnerName(canonicalName).canonicalKey ?? ""],
  );
  return partnerId;
}

/** What the property test below seeds before it drives a tool. */
interface ReadToolSeeds {
  caseId: string;
  partnerId: string;
  travellerFullName: string;
  travellerPassportNumber: string;
}

interface ToolInputCase {
  /** Names the BRANCH, not the tool -- it is what a failure line has to identify. */
  label: string;
  build: (seeds: ReadToolSeeds) => Record<string, unknown>;
}

/**
 * Every branch of every read tool's `execute` that resolves, as a valid input
 * built against fixtures seeded through the real (write-allowed) context.
 *
 * Branch review I3 / carried finding R1: this used to be `switch (name) ->
 * ONE input`, so `search_cases` only ever ran its `caseStatus` branch,
 * `find_traveller` only its `fullName` branch, and `recall` only its ORG
 * scope. The write-refusing context -- the entire mechanism -- never reached
 * the others, and a `put` inserted into `search_cases`' `partnerId` branch
 * reddened 0 of 629. The headline invariant ("`execute` proposes and never
 * touches the table") was a claim about the paths one fixture happened to
 * take, and the untested paths were partnerId search, passport lookup and
 * both non-ORG memory scopes -- what a real desk uses constantly.
 *
 * Keyed by tool name so a read tool added later with no entry here fails
 * loudly at COLLECTION time instead of silently skipping the property it
 * exists to prove. Only resolving branches belong here: `search_cases` with
 * neither filter and `find_traveller` with neither input throw on purpose,
 * and are pinned by their own tests below.
 */
function inputCasesForReadTool(toolName: string): ToolInputCase[] {
  switch (toolName) {
    case "get_case":
      return [{ label: "by caseId", build: (seeds) => ({ caseId: seeds.caseId }) }];
    case "search_cases":
      return [
        { label: "caseStatus branch", build: () => ({ caseStatus: "NEW" }) },
        { label: "partnerId branch", build: (seeds) => ({ partnerId: seeds.partnerId }) },
        { label: "caseStatus branch with an explicit limit", build: () => ({ caseStatus: "NEW", limit: 5 }) },
      ];
    case "find_traveller":
      return [
        { label: "fullName branch", build: (seeds) => ({ fullName: seeds.travellerFullName }) },
        { label: "passportNumber branch", build: (seeds) => ({ passportNumber: seeds.travellerPassportNumber }) },
        // passportNumber wins when both are given -- a separate path through
        // the same `if`, and the one a model is most likely to produce.
        {
          label: "both, passportNumber taking precedence",
          build: (seeds) => ({
            passportNumber: seeds.travellerPassportNumber,
            fullName: seeds.travellerFullName,
          }),
        },
      ];
    case "list_partners":
      return [{ label: "no input", build: () => ({}) }];
    case "aggregate":
      // Every groupBy the domain declares, not one of them: each is a
      // different read path through countCasesByField.
      return CASE_COUNT_GROUP_BY_FIELDS.map((groupByField) => ({
        label: `groupBy ${groupByField}`,
        build: () => ({ groupBy: groupByField }),
      }));
    case "get_country_checklist":
      return [{ label: "a configured country", build: () => ({ countryCode: "AE" }) }];
    case "recall":
      return [
        { label: "ORG scope", build: () => ({ scopes: ["ORG"] }) },
        { label: "USER scope", build: () => ({ scopes: ["USER"] }) },
        { label: "PARTNER scope", build: (seeds) => ({ scopes: ["PARTNER"], partnerId: seeds.partnerId }) },
        {
          label: "all three scopes at once, with an explicit limit",
          build: (seeds) => ({ scopes: ["ORG", "PARTNER", "USER"], partnerId: seeds.partnerId, limit: 3 }),
        },
      ];
    default:
      throw new Error(`no input cases registered for read tool "${toolName}" -- add some above`);
  }
}

/**
 * The cross product of tool and branch, enumerated at collection time so each
 * branch is its own test rather than one loop whose first failure hides the
 * rest. The seeds resolve inside the test body, where the fixtures exist.
 */
const READ_TOOL_INPUT_CASES = READ_TOOLS.flatMap((tool) =>
  inputCasesForReadTool(tool.name).map((inputCase) => ({ tool, ...inputCase })),
);

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
describe("every READ_TOOLS tool resolves without ever issuing a write", () => {
  it.each(READ_TOOL_INPUT_CASES)(
    "$tool.name / $label: execute resolves without issuing a write",
    async ({ tool, build }) => {
      const context = await buildTestContext();
      const partner = await createPartner(
        context,
        TENANT_ID,
        { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
        ACTOR,
      );
      const traveller = await upsertTraveller(context, TENANT_ID, {
        fullName: "ASHA RAO",
        // find_traveller's passportNumber branch needs one on file -- without
        // it that branch resolves to `{ travellers: [] }` having taken a
        // different path through findTravellerByPassport than a real lookup.
        passportNumber: "P7654321",
      });
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
      const input = build({
        caseId: seededCase.caseId,
        partnerId: partner.partnerId,
        travellerFullName: "ASHA RAO",
        travellerPassportNumber: "P7654321",
      });
      const writeRefusingContext = contextRefusingWrites(context, tool.name);

      await expect(tool.execute(writeRefusingContext, TENANT_ID, input, ACTOR)).resolves.toBeDefined();
    },
  );
});

describe("get_case", () => {
  it("returns the stored case", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    await upsertTraveller(context, TENANT_ID, { fullName: "RAVI KUMAR", passportNumber: "Z1234567" });

    const tool = new ToolRegistry(READ_TOOLS).get("find_traveller");
    const byPassport = await tool!.execute(context, TENANT_ID, { passportNumber: "Z1234567" }, ACTOR);
    expect((byPassport as { travellers: unknown[] }).travellers).toHaveLength(1);

    const byName = await tool!.execute(context, TENANT_ID, { fullName: "RAVI KUMAR" }, ACTOR);
    expect((byName as { travellers: unknown[] }).travellers).toHaveLength(1);
  });
});

// This tool used to read the CRM CountryChecklist rows. Nothing writes those
// after the Config cutover, so it would have reported a frozen list as the
// live answer -- on a tool whose whole job is telling the desk whether a file
// is complete.
describe("get_country_checklist", () => {
  const tool = () => new ToolRegistry(READ_TOOLS).get("get_country_checklist")!;

  it("answers from the Config checklist the desk edits, free-text rows included", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", ACTOR, {
      ...getCountryProduct("AE"),
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Emirates ID copy" },
      ],
    });

    await expect(tool().execute(context, TENANT_ID, { countryCode: "AE" }, ACTOR)).resolves.toEqual(
      { countryCode: "AE", requiredDocuments: ["Passport bio page", "Emirates ID copy"] },
    );
  });

  it("returns an empty list for a country with nothing configured", async () => {
    await expect(
      tool().execute(await buildTestContext(), TENANT_ID, { countryCode: "ZZ" }, ACTOR),
    ).resolves.toEqual({ countryCode: "ZZ", requiredDocuments: [] });
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
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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
