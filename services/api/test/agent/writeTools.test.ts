import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { changeApplicantCustody, createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { addLineItem } from "../../src/domain/crm/lineItems";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import { buildTestContext, type TestContext } from "../helpers";
import type { ProposedChange } from "../../src/agent/approval";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

// caseRef doubles as the partner's name suffix, so a test that needs two
// independent cases in one context (two calls to this helper) does not trip
// createPartner's one-canonical-name-per-partner rule.
async function seedOneCase(context: TestContext, caseRef = "80001") {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: `Ozzy Travels ${caseRef}`, partnerType: "AGENCY" },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef,
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

/**
 * Wraps a real context's table so a read still works -- tools read to build
 * their diffs -- but any put/delete throws immediately. A write tool's
 * `execute` that reaches either one is exactly the bug this repo's mutation
 * checks exist to catch; mirrors `tableRecordingWrites` in
 * services/migration/src/importCli.ts, which polices the same seam by
 * observation instead of by throwing.
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
        throw new Error(`write tool "${toolNameForMessage}"'s execute reached put()`);
      },
      delete: () => {
        throw new Error(`write tool "${toolNameForMessage}"'s execute reached delete()`);
      },
    },
  };
}

describe("the write tool registry", () => {
  it("declares every write tool as kind 'write'", () => {
    const registry = new ToolRegistry(WRITE_TOOLS);
    expect(registry.readTools()).toHaveLength(0);
    expect(registry.writeTools().map((tool) => tool.name).sort()).toEqual(
      ["add_line_item", "create_case", "set_billing", "set_custody", "update_case"],
    );
  });

  // The mirror-image half of the invariant: `apply` is what lets a caller
  // reach the table at all, so its presence has to line up exactly with
  // `kind`, in both directions -- a future write tool registered under
  // READ_TOOLS to dodge the gate would still fail this.
  it("gives every write tool an apply, and no read tool one", () => {
    for (const writeTool of WRITE_TOOLS) {
      expect(writeTool.apply, `${writeTool.name} is in WRITE_TOOLS but has no apply`).toBeTypeOf(
        "function",
      );
    }
    for (const readTool of READ_TOOLS) {
      expect(readTool.apply, `${readTool.name} is in READ_TOOLS but declares an apply`).toBeUndefined();
    }
  });

  // zodObjectToJsonSchema (registry.ts) used to map every array to
  // {type: "array", items: {type: "string"}} regardless of what it actually
  // held, so create_case's advertised schema said applicants was an array of
  // strings. A schema-obedient provider would then hand back
  // applicants: ["A1"], and ["A1"].map(a => a.applicantRef).join(", ") is ""
  // -- an approval card reading "applicants: (new case) -> "" for a create.
  it("describes create_case's applicants as an array of objects, not an array of strings", () => {
    const definitions = new ToolRegistry(WRITE_TOOLS).toolDefinitions();
    const createCaseDefinition = definitions.find((definition) => definition.name === "create_case");
    expect(createCaseDefinition?.inputSchema).toMatchObject({
      properties: {
        applicants: {
          type: "array",
          items: {
            type: "object",
            properties: {
              applicantRef: { type: "string" },
              travellerId: { type: "string" },
              passportNumber: { type: "string" },
            },
            required: expect.arrayContaining(["applicantRef", "travellerId"]),
          },
        },
      },
    });
    // passportNumber is optional -- required must name exactly the other two.
    const applicantsSchema = (
      createCaseDefinition?.inputSchema as { properties: { applicants: { items: { required: string[] } } } }
    ).properties.applicants.items.required;
    expect(applicantsSchema.sort()).toEqual(["applicantRef", "travellerId"]);
  });
});

/**
 * One valid, minimal input per write tool, built against a case seeded
 * through the real (write-allowed) context. Keyed by tool name so the
 * property test below can drive every tool in WRITE_TOOLS without knowing its
 * shape up front -- and so a write tool added later with no entry here fails
 * loudly instead of silently skipping the property it exists to prove.
 */
function minimalInputFor(
  toolName: string,
  seededCase: { caseId: string },
  partnerId: string,
  travellerId: string,
): Record<string, unknown> {
  switch (toolName) {
    case "create_case":
      return {
        caseRef: "80099",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId }],
      };
    case "update_case":
      return { caseId: seededCase.caseId, appointmentDate: "2026-10-01" };
    case "add_line_item":
      return {
        caseId: seededCase.caseId,
        lineItemCode: "VISA_SERVICE_FEE",
        quantity: 1,
        unitPriceInr: 1000,
      };
    case "set_custody":
      return { caseId: seededCase.caseId, applicantRef: "A1", custody: "WITH_RGS" };
    case "set_billing":
      return { caseId: seededCase.caseId, billingStatus: "BILL_SENT" };
    default:
      throw new Error(`no minimal input registered for write tool "${toolName}" -- add one above`);
  }
}

describe("every WRITE_TOOLS tool proposes without writing", () => {
  it.each(WRITE_TOOLS)("$name: execute resolves to a PENDING proposal and never reaches the table", async (tool) => {
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
        caseRef: "80001",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    const input = minimalInputFor(tool.name, seededCase, partner.partnerId, traveller.travellerId);
    const writeRefusingContext = refuseWrites(context, tool.name);

    const proposal = await tool.execute(writeRefusingContext, TENANT_ID, input, ACTOR);

    expect(proposal, `${tool.name}'s execute did not resolve`).toBeDefined();
    const proposedChange = proposal as ProposedChange;
    expect(proposedChange.status, `${tool.name}'s proposal is not PENDING`).toBe("PENDING");
    expect(proposedChange.toolName, `${tool.name}'s proposal names the wrong tool`).toBe(tool.name);
    expect(
      Array.isArray(proposedChange.summary),
      `${tool.name}'s proposal has no summary array`,
    ).toBe(true);
    // A populated summary, not merely an array: an approval card with zero
    // rows gives the human nothing to judge.
    expect(
      proposedChange.summary.length,
      `${tool.name}'s proposal has an empty summary`,
    ).toBeGreaterThan(0);
    // The exact two fields ruling P35 exists for: proposalId minted by
    // newId("prop", ...), proposedAt from the injectable clock -- never
    // `new Date()`. The test clock is frozen (helpers.ts), so a `new Date()`
    // proposedAt would fail the second assertion immediately.
    expect(proposedChange.proposalId, `${tool.name}'s proposalId is not prop_-prefixed`).toMatch(/^prop_/);
    expect(proposedChange.proposedAt, `${tool.name}'s proposedAt did not come from context.now()`).toBe(
      context.now().toISOString(),
    );
  });
});

describe("set_billing", () => {
  it("reads the from value off the stored case, not a placeholder", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    expect(seededCase.billingStatus).toBe("UNBILLED");

    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "billingStatus", from: "UNBILLED", to: "BILL_SENT" },
    ]);
    expect(proposal.caseId).toBe(seededCase.caseId);
    expect(proposal.proposedBy).toBe(ACTOR);
  });

  it("applies through changeBillingStatus, honouring the billing state machine", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;

    const updatedCase = (await tool.apply!(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as crm.CrmCase;
    expect(updatedCase.billingStatus).toBe("BILL_SENT");

    // PAID directly from UNBILLED (a fresh case, never billed) is not a legal
    // edge (stateMachines.ts BILLING_TRANSITIONS) -- apply must be the real
    // mutator, not a shortcut that skips the check.
    const anotherSeededCase = await seedOneCase(context, "80002");
    expect(anotherSeededCase.billingStatus).toBe("UNBILLED");
    await expect(
      tool.apply!(context, TENANT_ID, { caseId: anotherSeededCase.caseId, billingStatus: "PAID" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("set_custody", () => {
  it("reads the applicant's from value off the stored case, not the schema default", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    // NOT_HELD is CaseApplicantSchema's default -- moving custody off it first
    // is what stops a hardcoded "NOT_HELD" from passing this assertion.
    await changeApplicantCustody(context, TENANT_ID, seededCase.caseId, "A1", "WITH_RGS", ACTOR);

    const tool = new ToolRegistry(WRITE_TOOLS).get("set_custody")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, applicantRef: "A1", custody: "AT_EMBASSY" },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "applicants.A1.custody", from: "WITH_RGS", to: "AT_EMBASSY" },
    ]);
  });

  it("refuses an applicantRef that is not on the case", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_custody")!;

    // toMatchObject({ statusCode: 404 }), not a bare rejects.toThrow(): delete
    // the notFound guard this pins and currentApplicant.custody throws a raw
    // TypeError instead -- which also satisfies a bare toThrow().
    await expect(
      tool.execute(context, TENANT_ID, { caseId: seededCase.caseId, applicantRef: "NOPE", custody: "WITH_RGS" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("applies through changeApplicantCustody, honouring the custody state machine and the auto-CLOSED derivation", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_custody")!;

    // NOT_HELD -> WITH_RGS is the one legal first move (stateMachines.ts
    // CUSTODY_TRANSITIONS).
    const afterFirstMove = (await tool.apply!(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, applicantRef: "A1", custody: "WITH_RGS" },
      ACTOR,
    )) as crm.CrmCase;
    expect(afterFirstMove.applicants[0]?.custody).toBe("WITH_RGS");

    // NOT_HELD -> RETURNED, skipping WITH_RGS, is not a legal edge on a fresh
    // case -- apply must be the real mutator honouring CUSTODY_TRANSITIONS,
    // not a shortcut that writes whatever custody it is given.
    const anotherSeededCase = await seedOneCase(context, "80003");
    await expect(
      tool.apply!(
        context,
        TENANT_ID,
        { caseId: anotherSeededCase.caseId, applicantRef: "A1", custody: "RETURNED" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Completing the journey (WITH_RGS -> RETURNED) once the bill is settled
    // closes the case automatically -- a derivation changeApplicantCustody
    // performs internally (cases.ts applyDerivedCaseStatusIfLegal), not
    // something set_custody's tool code does itself.
    const billingTool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    await billingTool.apply!(context, TENANT_ID, { caseId: seededCase.caseId, billingStatus: "BILL_SENT" }, ACTOR);
    await billingTool.apply!(context, TENANT_ID, { caseId: seededCase.caseId, billingStatus: "PAID" }, ACTOR);
    const afterReturned = (await tool.apply!(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, applicantRef: "A1", custody: "RETURNED" },
      ACTOR,
    )) as crm.CrmCase;
    expect(afterReturned.applicants[0]?.custody).toBe("RETURNED");
    expect(afterReturned.caseStatus).toBe("CLOSED");
  });
});

describe("add_line_item", () => {
  it("describes the line being added and reports the stored total, without recomputing it", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    // Seed one real line first -- lineItems: [] / totalInr: 0 is the schema
    // default, and asserting against that default is indistinguishable from a
    // tool that never reads the stored case at all.
    await addLineItem(
      context,
      TENANT_ID,
      seededCase.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 2, unitPriceInr: 5000 },
      ACTOR,
    );

    const tool = new ToolRegistry(WRITE_TOOLS).get("add_line_item")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, lineItemCode: "GOVT_FEE", quantity: 1, unitPriceInr: 1500 },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      {
        field: "lineItems",
        from: "1 line(s), totalInr 10000",
        to: "+1 x GOVT_FEE @ 1500/unit",
      },
    ]);
  });

  it("applies through addLineItem, which recomputes totalInr from every stored line", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("add_line_item")!;

    const updatedCase = (await tool.apply!(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, lineItemCode: "VISA_SERVICE_FEE", quantity: 2, unitPriceInr: 5000 },
      ACTOR,
    )) as crm.CrmCase;
    expect(updatedCase.totalInr).toBe(10000);
  });
});

describe("update_case", () => {
  it("reports (not set) for a field with no prior value", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    expect(seededCase.appointmentDate).toBeUndefined();

    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, appointmentDate: "2026-10-01" },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "appointmentDate", from: "(not set)", to: "2026-10-01" },
    ]);
  });

  it("reports the stored value as from when a prior value exists, not (not set)", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seededCase.caseId, { appointmentDate: "2026-09-09" }, ACTOR);

    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, appointmentDate: "2026-10-01" },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "appointmentDate", from: "2026-09-09", to: "2026-10-01" },
    ]);
  });

  it("reads visaType's from off the stored case too, not only appointmentDate's", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    // seedOneCase sets visaType at creation -- already off the "unset" state,
    // so this covers a second of the six from-branches for free.
    expect(seededCase.visaType).toBe("EVISA_TOURIST");

    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, visaType: "TOURIST" },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.summary).toEqual([
      { field: "visaType", from: "EVISA_TOURIST", to: "TOURIST" },
    ]);
  });

  it("refuses a call with no fields to change instead of proposing an empty diff", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;

    await expect(
      tool.execute(context, TENANT_ID, { caseId: seededCase.caseId }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("applies through updateCaseDetails, which still ignores the state-machine axes", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;

    const updatedCase = (await tool.apply!(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, appointmentDate: "2026-10-01", caseStatus: "DECIDED" } as never,
      ACTOR,
    )) as crm.CrmCase;

    expect(updatedCase.appointmentDate).toBe("2026-10-01");
    expect(updatedCase.caseStatus).toBe(seededCase.caseStatus);
  });

  // The tool's own input schema is the first gate: it declares no
  // caseStatus/billingStatus property at all. This is a property of the
  // SCHEMA that a future call path relying on `inputSchema.parse` will get
  // for free -- nothing in src/ calls it yet (grep -rn "inputSchema"
  // services/api/src shows it read only by zodObjectToJsonSchema); the
  // enforcement that IS load-bearing today is updateCaseDetails's own
  // allow-list (see cases.ts, and the apply test above).
  it("strips a state-machine-axis key instead of passing it through", () => {
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const parsed = tool.inputSchema.parse({ caseId: "case_1", caseStatus: "DECIDED" }) as Record<
      string,
      unknown
    >;
    expect(parsed["caseStatus"]).toBeUndefined();
  });
});

describe("create_case", () => {
  it("uses the (new case) sentinel for every from, never the mutation sentinel 'unknown'", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });

    const tool = new ToolRegistry(WRITE_TOOLS).get("create_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      {
        caseRef: "80050",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    )) as ProposedChange;

    expect(proposal.caseId).toBeUndefined();
    expect(proposal.summary.length).toBeGreaterThan(0);
    for (const summaryLine of proposal.summary) {
      expect(summaryLine.from).toBe("(new case)");
    }
  });

  it("applies through createCase and produces a real, readable case", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
    const tool = new ToolRegistry(WRITE_TOOLS).get("create_case")!;

    const createdCase = (await tool.apply!(
      context,
      TENANT_ID,
      {
        caseRef: "80051",
        caseType: "VISA",
        visaType: "EVISA_TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    )) as crm.CrmCase;

    expect(createdCase.caseRef).toBe("80051");
    expect(createdCase.caseStatus).toBe("NEW");
  });
});
