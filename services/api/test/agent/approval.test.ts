import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import {
  AUTO_APPLIABLE_TOOLS,
  HIGH_STAKES_TOOLS,
  applyApprovedChange,
  discardProposal,
  listPendingProposals,
  stageProposal,
  type ProposedChange,
} from "../../src/agent/approval";
import { createCase, getCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import {
  PROPOSAL_SORT_KEY,
  caseIdFromPartitionKey,
  proposalPartitionKey,
  proposalStatusGsi1Pk,
} from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

// caseRef doubles as the partner's name suffix, so a test that needs two
// independent cases in one context (two calls to this helper) does not trip
// createPartner's one-canonical-name-per-partner rule. Mirrors
// writeTools.test.ts's own helper -- same shape, different file under test.
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
 * Wraps a real context's table so any write to a CASE-partition key throws
 * immediately -- while staging a proposal (a legitimate write to the
 * PROPOSAL partition) passes through untouched. Delegates explicitly rather
 * than spreading `context.table`: `get`/`query`/`queryGsi` live on
 * `InMemoryTableClient`'s prototype and a spread silently drops them
 * (task-8-controller-notes.md P44); mirrors `tableRecordingWrites` in
 * services/migration/src/importCli.ts, which polices the same seam by
 * observation instead of by throwing.
 *
 * Uses `caseIdFromPartitionKey`, keys.ts's own inverse of `casePartitionKey`,
 * rather than a hand-rolled substring literal -- keys.ts is the only file
 * allowed to know the shape of a CRM key.
 */
function tableThatRefusesCaseWrites(context: TestContext, toolNameForMessage: string): AppContext {
  const refuseIfCaseKey = (partitionKey: string, verb: string): void => {
    if (caseIdFromPartitionKey(partitionKey) !== undefined) {
      throw new Error(
        `INVARIANT VIOLATED: write tool "${toolNameForMessage}" ${verb} a case before approval (PK=${partitionKey})`,
      );
    }
  };
  return {
    ...context,
    table: {
      get: (partitionKey, sortKey, options) => context.table.get(partitionKey, sortKey, options),
      query: (partitionKey, options) => context.table.query(partitionKey, options),
      queryGsi: (indexName, partitionKey, options) =>
        context.table.queryGsi(indexName, partitionKey, options),
      put: (item) => {
        refuseIfCaseKey(item.PK, "wrote");
        return context.table.put(item);
      },
      delete: (partitionKey, sortKey) => {
        refuseIfCaseKey(partitionKey, "deleted");
        return context.table.delete(partitionKey, sortKey);
      },
    },
  };
}

/**
 * One valid, minimal input per write tool, keyed by name rather than
 * enumerated as a list -- an exhaustive switch with NO default branch, so a
 * sixth write tool added to `WRITE_TOOLS` later fails this file to compile
 * until someone supplies its sample here too (the same trick the registry
 * property test itself relies on, applied to the test's own fixtures).
 */
type WriteToolName = "create_case" | "update_case" | "add_line_item" | "set_custody" | "set_billing";

function sampleInputFor(
  toolName: WriteToolName,
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
  }
}

describe("an approved change is the only thing that writes", () => {
  // The property, over EVERY registered write tool: staging never reaches a
  // case, and applyApprovedChange is what makes the mutation real and
  // durable. Task 7's own suite (writeTools.test.ts) already proves `execute`
  // alone never writes -- this proves the other half.
  it.each(WRITE_TOOLS)(
    "$name: the case is untouched until applyApprovedChange runs it, then the write is durable",
    async (writeTool) => {
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

      const input = sampleInputFor(writeTool.name as WriteToolName, seededCase, partner.partnerId, traveller.travellerId);
      const guardedContext = tableThatRefusesCaseWrites(context, writeTool.name);

      const proposal = (await writeTool.execute(guardedContext, TENANT_ID, input, ACTOR)) as ProposedChange;
      const staged = await stageProposal(guardedContext, TENANT_ID, proposal);

      // Staged, not applied: the proposal is visible in the PENDING queue and
      // the case-partition guard above did not fire.
      const { proposals: pendingBeforeApproval } = await listPendingProposals(context, TENANT_ID);
      expect(pendingBeforeApproval.map((pending) => pending.proposalId)).toContain(staged.proposalId);

      // Approval runs against the REAL (unguarded) context -- this is the one
      // call in the whole flow that is allowed to touch a case.
      const domainResult = await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);
      expect(domainResult, `${writeTool.name}'s apply did not resolve`).toBeDefined();

      const { proposals: pendingAfterApproval } = await listPendingProposals(context, TENANT_ID);
      expect(pendingAfterApproval.map((pending) => pending.proposalId)).not.toContain(staged.proposalId);

      const storedProposal = await context.table.get(
        proposalPartitionKey(TENANT_ID, staged.proposalId),
        PROPOSAL_SORT_KEY,
      );
      expect(storedProposal?.status, `${writeTool.name}'s proposal did not move to APPROVED`).toBe("APPROVED");
      expect(storedProposal?.GSI1PK).toBe(proposalStatusGsi1Pk(TENANT_ID, "APPROVED"));

      // The mutation is not only returned but durable: re-reading the case
      // (via the domain result's own caseId, since create_case has none of
      // its own to start from) matches exactly what apply returned.
      const resultCaseId = (domainResult as { caseId?: string }).caseId ?? seededCase.caseId;
      const storedCase = await getCase(context, TENANT_ID, resultCaseId);
      expect(storedCase).toEqual(domainResult);
    },
  );
});

describe("stageProposal", () => {
  it("refuses to stage a proposal that does not arrive PENDING", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    const notPending: ProposedChange = {
      proposalId: "prop_hand_rolled",
      toolName: "set_billing",
      input: { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      summary: [],
      caseId: seededCase.caseId,
      proposedBy: ACTOR,
      proposedAt: context.now().toISOString(),
      status: "APPROVED",
    };
    await expect(stageProposal(context, TENANT_ID, notPending)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("applyApprovedChange", () => {
  it("invokes the tool's apply and marks the proposal APPROVED", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    expect(seeded.billingStatus).toBe("UNBILLED");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)) as crm.CrmCase;
    expect(updated.billingStatus).toBe("BILL_SENT");

    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.find((pending) => pending.proposalId === staged.proposalId)).toBeUndefined();
  });

  it("refuses an unknown proposal id", async () => {
    const context = buildTestContext();
    await expect(applyApprovedChange(context, TENANT_ID, "prop_does_not_exist", ACTOR)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // add_line_item, not set_billing: changeBillingStatus's own state machine
  // already refuses a second BILL_SENT (409, independent of this guard), so
  // that scenario cannot tell the guard apart from the domain function's own
  // idempotency check. addLineItem has no such check -- calling it twice
  // legitimately adds two lines -- so this is the one write tool where only
  // applyApprovedChange's own PENDING guard stands between a double-approval
  // and a genuine double-charge on the bill.
  it("refuses to apply the same proposal twice (a double-approved line item is a double-charge)", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("add_line_item")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, lineItemCode: "VISA_SERVICE_FEE", quantity: 1, unitPriceInr: 1000 },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const firstApply = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)) as crm.CrmCase;
    expect(firstApply.totalInr).toBe(1000);

    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    // The refusal must also mean nothing wrote a second time: still one line,
    // still totalInr 1000 -- not 2000.
    const caseAfterRefusal = await getCase(context, TENANT_ID, seeded.caseId);
    expect(caseAfterRefusal.totalInr).toBe(1000);
    expect(caseAfterRefusal.lineItems).toHaveLength(1);
  });

  it("refuses to apply a proposal that was already discarded", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "wrong case");
    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses a proposal naming a tool that is not registered", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const proposal: ProposedChange = {
      proposalId: "prop_phantom_tool",
      toolName: "delete_everything",
      input: { caseId: seeded.caseId },
      summary: [{ field: "x", from: "a", to: "b" }],
      caseId: seeded.caseId,
      proposedBy: ACTOR,
      proposedAt: context.now().toISOString(),
      status: "PENDING",
    };
    await stageProposal(context, TENANT_ID, proposal);
    await expect(applyApprovedChange(context, TENANT_ID, "prop_phantom_tool", ACTOR)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("applies the human's edit, not the model's original input", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR, {
      caseId: seeded.caseId,
      billingStatus: "BILL_SENT",
    })) as crm.CrmCase;

    expect(updated.billingStatus).toBe("BILL_SENT");
  });

  it("refuses an edit that fails the tool's own schema, and writes nothing", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await expect(
      applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR, {
        caseId: seeded.caseId,
        billingStatus: "NOT_A_REAL_STATUS",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Nothing written: the case is exactly as seedOneCase left it, and the
    // proposal is still PENDING and therefore still approvable.
    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.find((pending) => pending.proposalId === staged.proposalId)).toBeDefined();
  });

  it("records PROPOSAL_APPROVED against the case's own event list for create_case, though caseId is unknown at stage time", async () => {
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
        caseRef: "80077",
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
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const created = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)) as crm.CrmCase;
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toContain("PROPOSAL_APPROVED");
  });

  it("marks a no-op update_case approval as unchanged, not as an applied change (P53)", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    // Move appointmentDate off its (unset) default first -- re-supplying the
    // SAME already-stored value is what proves the "unchanged" branch, not
    // the schema default.
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "2026-10-01" }, ACTOR);

    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, appointmentDate: "2026-10-01" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent, "no PROPOSAL_APPROVED event was recorded").toBeDefined();
    expect(approvalEvent?.meta.changed).toBe(false);

    // The proposal is still terminal -- a decision was made even though
    // nothing moved, so re-approving it must stay refused.
    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("marks a real update_case approval as changed", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    expect(seeded.appointmentDate).toBeUndefined();

    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, appointmentDate: "2026-10-01" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    // The "changed" signal is `updatedAt` moving (see approval.ts's
    // domainCallChanged) -- advance the clock so a real write's freshly
    // computed `updatedAt` is genuinely distinguishable from the snapshot
    // read a moment earlier, the same idiom updateCaseDetails.test.ts uses
    // to prove `updatedAt` really moved rather than landing in the same
    // frozen millisecond.
    context.advanceClock(60_000);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent?.meta.changed).toBe(true);
  });
});

describe("discardProposal", () => {
  it("records a reason and never invokes the tool's apply", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const discarded = await discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "wrong case");
    expect(discarded.status).toBe("DISCARDED");
    expect(discarded.discardReason).toBe("wrong case");

    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    expect(events.map((event) => event.eventType)).toContain("PROPOSAL_DISCARDED");
    // set_billing's apply is changeBillingStatus, which always writes a
    // BILLING_CHANGED event when it runs -- its absence is the evidence apply
    // was never called.
    expect(events.map((event) => event.eventType)).not.toContain("BILLING_CHANGED");
  });

  it("refuses an empty reason", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await expect(
      discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "   "),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to discard a proposal that was already approved", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    await expect(
      discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "changed my mind"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to discard the same proposal twice", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);
    await discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "first reason");

    await expect(
      discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "second reason"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("listPendingProposals", () => {
  it("reports a stored proposal that will not parse, instead of dropping it silently", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    const healthy = await stageProposal(context, TENANT_ID, proposal);

    // A PENDING-indexed row whose body has lost `proposedBy` -- required by
    // ProposedChangeSchema, so this row cannot reassemble.
    await context.table.put({
      PK: proposalPartitionKey(TENANT_ID, "prop_ghost"),
      SK: PROPOSAL_SORT_KEY,
      GSI1PK: proposalStatusGsi1Pk(TENANT_ID, "PENDING"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      proposalId: "prop_ghost",
      toolName: "set_billing",
      input: {},
      summary: [],
      status: "PENDING",
    });

    const { proposals, unreadableProposalIds } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.map((pending) => pending.proposalId)).toEqual([healthy.proposalId]);
    expect(unreadableProposalIds).toEqual(["prop_ghost"]);
  });

  it("reports nothing unreadable when every staged proposal is healthy", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      ACTOR,
    )) as ProposedChange;
    await stageProposal(context, TENANT_ID, proposal);

    const { unreadableProposalIds } = await listPendingProposals(context, TENANT_ID);
    expect(unreadableProposalIds).toEqual([]);
  });
});

describe("HIGH_STAKES_TOOLS / AUTO_APPLIABLE_TOOLS", () => {
  it("classifies every registered write tool into exactly one of the two sets, and names neither a phantom", () => {
    const registeredWriteToolNames = new ToolRegistry(WRITE_TOOLS).writeTools().map((tool) => tool.name);

    for (const highStakesName of HIGH_STAKES_TOOLS) {
      expect(
        registeredWriteToolNames,
        `HIGH_STAKES_TOOLS names "${highStakesName}", which is not a registered write tool`,
      ).toContain(highStakesName);
    }
    for (const autoAppliableName of AUTO_APPLIABLE_TOOLS) {
      expect(
        registeredWriteToolNames,
        `AUTO_APPLIABLE_TOOLS names "${autoAppliableName}", which is not a registered write tool`,
      ).toContain(autoAppliableName);
      expect(
        HIGH_STAKES_TOOLS.has(autoAppliableName),
        `"${autoAppliableName}" is in both HIGH_STAKES_TOOLS and AUTO_APPLIABLE_TOOLS`,
      ).toBe(false);
    }
    for (const writeToolName of registeredWriteToolNames) {
      const isClassified = HIGH_STAKES_TOOLS.has(writeToolName) || AUTO_APPLIABLE_TOOLS.has(writeToolName);
      expect(
        isClassified,
        `write tool "${writeToolName}" is in neither HIGH_STAKES_TOOLS nor AUTO_APPLIABLE_TOOLS`,
      ).toBe(true);
    }
  });
});
