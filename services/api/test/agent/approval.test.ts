import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import {
  AUTO_APPLIABLE_TOOLS,
  HIGH_STAKES_TOOLS,
  applyApprovedChange,
  discardProposal,
  getProposal,
  listPendingProposals,
  stageProposal,
  type ProposedChange,
} from "../../src/agent/approval";
import { changeBillingStatus, createCase, getCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { memoryScope, recallMemories, rememberMemory } from "../../src/domain/crm/memory";
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
 * enumerated as a list. `WriteToolName` is a hand-written union, not derived
 * from `WRITE_TOOLS`, and both call sites reach it through an `as
 * WriteToolName` cast -- so adding a sixth tool to `WRITE_TOOLS` does NOT
 * fail this file to compile; `pnpm -r typecheck` stays clean either way
 * (fix-round-2 correction). What actually happens is a runtime failure: the
 * switch below has no `default`, so an unhandled name falls through and this
 * function implicitly returns `undefined`, which then reaches a write tool's
 * `execute` as its `input` and throws a genuine TypeError there -- a real net,
 * just a later and noisier one than a compile error would be. Keeping this
 * switch exhaustive over the CURRENT seven names is still worth doing (it is
 * what forces a fixture here whenever this file's own union is widened by
 * hand), but it is not what catches a tool silently added only to
 * `WRITE_TOOLS`.
 *
 * `remember`'s case reuses the pre-seeded case's id as its `sourceCaseId` --
 * CrmMemorySchema's refinement (schemas.ts:153-170) refuses an agent-created
 * memory with none. `forget`'s targets the exact (scope, memoryKey) the
 * it.each block below pre-seeds with a real `rememberMemory` call before
 * running the guarded flow, so the deletion it proves durable is a deletion
 * of something, not a no-op on a key nothing ever occupied.
 */
type WriteToolName =
  | "create_case"
  | "update_case"
  | "add_line_item"
  | "set_custody"
  | "set_billing"
  | "remember"
  | "forget";

/** The (scope, memoryKey) sampleInputFor's "remember"/"forget" cases and the it.each pre-seed below agree on. */
const SAMPLE_MEMORY_SCOPE_KIND = "ORG";
const SAMPLE_MEMORY_KEY = "morning-slots";

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
    case "remember":
      return {
        scope: SAMPLE_MEMORY_SCOPE_KIND,
        memoryKey: SAMPLE_MEMORY_KEY,
        text: "prefers morning appointment slots, take 2",
        sourceCaseId: seededCase.caseId,
      };
    case "forget":
      return { scope: SAMPLE_MEMORY_SCOPE_KIND, memoryKey: SAMPLE_MEMORY_KEY };
  }
}

/**
 * The mutation-visibility half of the property test (fix-round-1 Major 1).
 * `sampleInputFor`'s twin: an equally exhaustive, no-`default` switch over
 * the same hand-written `WriteToolName` union -- so, as with `sampleInputFor`
 * above, a sixth tool added only to `WRITE_TOOLS` does not fail this file to
 * compile (fix-round-2 correction); it falls through this switch with no
 * assertion run at all. In practice that path is unreachable in a passing
 * run: `sampleInputFor`'s own fall-through already throws first (see its
 * comment above), so this function is never called with a name it doesn't
 * recognize. Every assertion below targets a value OFF the fixture's
 * default, per the same rule Task 7's fix round established: `seedOneCase`
 * case is `billingStatus: "UNBILLED"`, `lineItems: []` / `totalInr: 0`,
 * `appointmentDate` unset, and applicant `A1`'s `custody` defaults to
 * `"NOT_HELD"` (`packages/shared/src/crm/schemas.ts:87`). This is what
 * caught the reviewer's `probe_sixth` -- a read-only `apply` -- which the
 * pre-fix-round-1 property test passed outright.
 */
function expectMutationVisible(toolName: WriteToolName, storedCase: crm.CrmCase): void {
  switch (toolName) {
    case "create_case":
      expect(storedCase.caseRef, "create_case: the stored case is not the one apply should have created").toBe(
        "80099",
      );
      break;
    case "update_case":
      expect(storedCase.appointmentDate, "update_case: appointmentDate never moved off its unset default").toBe(
        "2026-10-01",
      );
      break;
    case "add_line_item":
      expect(storedCase.lineItems, "add_line_item: lineItems is still the seed's empty array").toHaveLength(1);
      expect(storedCase.totalInr, "add_line_item: totalInr is still the seed's 0").toBe(1000);
      break;
    case "set_custody": {
      const applicant = storedCase.applicants.find((candidate) => candidate.applicantRef === "A1");
      expect(applicant?.custody, "set_custody: applicant A1's custody is still the schema default NOT_HELD").toBe(
        "WITH_RGS",
      );
      break;
    }
    case "set_billing":
      expect(storedCase.billingStatus, "set_billing: billingStatus is still the seed's UNBILLED").toBe(
        "BILL_SENT",
      );
      break;
  }
}

/**
 * The memory-shaped counterpart of expectMutationVisible + the getCase
 * re-read above it: remember/forget have no case to compare against, so
 * durability is proven by recalling SAMPLE_MEMORY_SCOPE_KIND's ORG scope
 * directly and checking the one row both tools agree on
 * (SAMPLE_MEMORY_KEY).
 */
async function expectMemoryMutationDurable(
  context: TestContext,
  toolName: "remember" | "forget",
): Promise<void> {
  const { memories } = await recallMemories(context, TENANT_ID, [memoryScope("ORG")]);
  const matchingMemory = memories.find((memory) => memory.memoryKey === SAMPLE_MEMORY_KEY);
  if (toolName === "remember") {
    expect(matchingMemory?.text, "remember: the memory was not durably written").toBe(
      "prefers morning appointment slots, take 2",
    );
  } else {
    expect(matchingMemory, "forget: the memory is still present after applyApprovedChange").toBeUndefined();
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
      // "forget"'s durability proof (below) needs a real row to delete --
      // seeded through the real, unguarded context, exactly as seededCase
      // itself is. Without this, forgetting SAMPLE_MEMORY_KEY would be a
      // no-op on a key nothing ever occupied, and the "no longer present"
      // assertion would pass whether or not applyApprovedChange did anything.
      if (writeTool.name === "forget") {
        await rememberMemory(
          context,
          TENANT_ID,
          {
            scope: memoryScope("ORG"),
            memoryKey: SAMPLE_MEMORY_KEY,
            text: "prefers morning appointment slots",
            sourceCaseId: seededCase.caseId,
          },
          "agent",
          ACTOR,
        );
      }

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
      // Major 5: who decided, and when -- the two fields that make the
      // transition auditable, not just its end state.
      expect(storedProposal?.decidedBy, `${writeTool.name}'s proposal has no decidedBy`).toBe(ACTOR);
      expect(storedProposal?.decidedAt, `${writeTool.name}'s proposal has no decidedAt`).toBe(
        context.now().toISOString(),
      );

      // remember/forget have no case to re-read -- their durability proof is
      // a recall, not a getCase -- so they branch off the case-shaped check
      // the other five tools share below.
      if (writeTool.name === "remember" || writeTool.name === "forget") {
        await expectMemoryMutationDurable(context, writeTool.name as "remember" | "forget");
        return;
      }

      // The mutation is not only returned but durable: re-reading the case
      // (via the domain result's own caseId, since create_case has none of
      // its own to start from) matches exactly what apply returned.
      const resultCaseId = (domainResult as { caseId?: string }).caseId ?? seededCase.caseId;
      const storedCase = await getCase(context, TENANT_ID, resultCaseId);
      expect(storedCase).toEqual(domainResult);

      // Major 1: durability alone cannot tell "apply wrote the change" apart
      // from "apply was never called and this is just a read" -- a plain
      // getCase() would satisfy toEqual(domainResult) too. Pin a value that
      // only a REAL mutation produces, off the fixture's default.
      expectMutationVisible(writeTool.name as WriteToolName, storedCase);
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
  it("invokes the tool's apply, marks the proposal APPROVED, and records a non-edited approval", async () => {
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

    // Advanced before approving so decidedAt is provably distinguishable
    // from proposedAt (Major 5) -- otherwise it is just another value that
    // happens to already be sitting in the record.
    context.advanceClock(60_000);
    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)) as crm.CrmCase;
    expect(updated.billingStatus).toBe("BILL_SENT");

    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.find((pending) => pending.proposalId === staged.proposalId)).toBeUndefined();

    const storedProposal = await context.table.get(
      proposalPartitionKey(TENANT_ID, staged.proposalId),
      PROPOSAL_SORT_KEY,
    );
    expect(storedProposal?.decidedBy).toBe(ACTOR);
    expect(storedProposal?.decidedAt).toBe(context.now().toISOString());
    expect(storedProposal?.decidedAt).not.toBe(staged.proposedAt);

    // Major 6: `edited` has to be false here, or it means nothing -- a flag
    // that is always true (or never checked) is not a signal.
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent?.meta.edited).toBe(false);
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

  // Distinct from "refuses an unknown proposal id" above: that is a missing
  // ROW (404). This proposal exists and was staged successfully -- it is the
  // TOOL NAME on it that is bogus, which is a corrupt record, not a missing
  // one (Minor 5 ruling). The two must not collide on the same status code.
  it("refuses a proposal naming a tool that is not registered, distinctly from a missing proposal", async () => {
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
      statusCode: 409,
    });
  });

  it("applies the human's edit, not the model's original input", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    // The model's original input must be a LEGAL alternative
    // (UNBILLED -> WRITTEN_OFF, stateMachines.ts), not an illegal one like
    // PAID: under mutation #3 (effectiveInput = proposal.input, discarding
    // the edit), an illegal original makes changeBillingStatus itself throw
    // a 409 before the `updated.billingStatus` assertion ever runs, so the
    // test would go red for "the state machine refused" rather than for "the
    // edit was ignored" -- indistinguishable causes (Minor 1, the identical
    // trap already fixed for the double-approval test one test above).
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "WRITTEN_OFF" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR, {
      caseId: seeded.caseId,
      billingStatus: "BILL_SENT",
    })) as crm.CrmCase;

    expect(updated.billingStatus).toBe("BILL_SENT");

    // Major 6: the flip side of the non-edited assertion above -- `edited`
    // only means something if it is true on an edited approval AND false on
    // a non-edited one.
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent?.meta.edited).toBe(true);
  });

  it("refuses an edit that fails the tool's own schema, and writes nothing", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    // Move billingStatus off its UNBILLED default first -- the "unchanged"
    // snapshot comparison below would otherwise pass even if a tool that
    // never read the case at all reported the default back.
    await changeBillingStatus(context, TENANT_ID, seeded.caseId, "BILL_SENT", ACTOR);

    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, billingStatus: "PAID" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const caseBeforeRefusal = await getCase(context, TENANT_ID, seeded.caseId);

    await expect(
      applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR, {
        caseId: seeded.caseId,
        billingStatus: "NOT_A_REAL_STATUS",
      }),
      // fix-round-2: the message names which side was at fault -- an EDITED
      // input's failure must say so, distinctly from the model's original
      // input failing (covered by the next test), so a Task 11 caller can
      // tell the human's own edit was what got rejected.
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Edited input for proposal") });

    // Major 2: "writes nothing" has to mean the CASE is untouched, not
    // merely that the proposal is still pending -- a real write inserted
    // right before the throw would leave the proposal-pending check green
    // while the case moved. Compare the whole record, not one field, so a
    // write to any part of it is caught.
    expect(await getCase(context, TENANT_ID, seeded.caseId)).toEqual(caseBeforeRefusal);

    // And the proposal itself is unaffected: still PENDING, still approvable.
    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.find((pending) => pending.proposalId === staged.proposalId)).toBeDefined();
  });

  // The other prose path (fix-round-2): a hand-rolled proposal, the same
  // pattern the phantom-tool test above uses, with an input that fails
  // set_billing's own schema and no edit supplied at approval time. The
  // message must say "Input", not "Edited input" -- nobody edited anything,
  // the model's own original proposal was the one Zod rejected.
  it("refuses the model's own original input when it fails the tool's schema, distinctly from an edit failing", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const proposal: ProposedChange = {
      proposalId: "prop_bad_original",
      toolName: "set_billing",
      input: { caseId: seeded.caseId, billingStatus: "NOT_A_REAL_STATUS" },
      summary: [{ field: "billingStatus", from: "UNBILLED", to: "NOT_A_REAL_STATUS" }],
      caseId: seeded.caseId,
      proposedBy: ACTOR,
      proposedAt: context.now().toISOString(),
      status: "PENDING",
    };
    await stageProposal(context, TENANT_ID, proposal);

    const rejection = await applyApprovedChange(context, TENANT_ID, "prop_bad_original", ACTOR).catch(
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ statusCode: 400, message: expect.stringContaining("Input for proposal") });
    expect((rejection as { message: string }).message).not.toContain("Edited input");
  });

  // fix-round-2: the guard that validates proposal.input before apply()
  // (Minor 2, fix-round-1) must not become the thing that OVERWRITES the
  // record with its own stripped copy. A model can legally attach a field a
  // tool's schema doesn't declare -- Zod's default "strip" mode drops it
  // from the validated value handed to `apply`, which is correct for the
  // domain call, but wrong for an audit trail: at 8055851, a non-edited
  // approval stored `proposal.input` verbatim, extras included.
  it("leaves a non-edited approval's stored input byte-identical to what was staged, extras included", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const proposal: ProposedChange = {
      proposalId: "prop_with_extra_field",
      toolName: "set_billing",
      // `modelNote` is not a field set_billing's inputSchema declares --
      // exactly the kind of extra a model might attach and a human never
      // touched. It must survive on the record precisely because nobody
      // edited it.
      input: { caseId: seeded.caseId, billingStatus: "BILL_SENT", modelNote: "partner confirmed by phone" },
      summary: [{ field: "billingStatus", from: "UNBILLED", to: "BILL_SENT" }],
      caseId: seeded.caseId,
      proposedBy: ACTOR,
      proposedAt: context.now().toISOString(),
      status: "PENDING",
    };
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const storedProposal = await context.table.get(
      proposalPartitionKey(TENANT_ID, staged.proposalId),
      PROPOSAL_SORT_KEY,
    );
    expect(storedProposal?.input).toEqual(proposal.input);
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

    // Major 3(a): without this, a mutation that deletes updateCaseDetails's
    // P51 no-op short-circuit (so every call genuinely writes) leaves this
    // test green on a frozen clock -- the rewritten record's `updatedAt`
    // lands on the same millisecond as the snapshot and a JSON-string
    // comparison of two structurally-different-only-in-timestamp objects
    // still differs, correctly flipping `changed` to true UNLESS the clock
    // never moved, in which case nothing at all distinguishes "no-op" from
    // "real write that happened to land in the same millisecond". Advancing
    // the clock here is what makes that distinction observable, mirroring
    // `test/crm/updateCaseDetails.test.ts:104`.
    context.advanceClock(60_000);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent, "no PROPOSAL_APPROVED event was recorded").toBeDefined();
    expect(approvalEvent?.meta.changed).toBe(false);

    // The proposal is still terminal -- a decision was made even though
    // nothing moved, so re-approving it must stay refused. (This is a
    // SEPARATE assertion from the one above -- Major 7 / mutation #1 reddens
    // this test via either one, and each is named for what it actually pins.)
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

    // Not load-bearing for correctness any more (domainCallChanged is a deep
    // compare, clock-independent -- fix-round-1 Major 3), but kept: it is
    // still a genuine gap between staging and approval, the same as in
    // production, and removing it should not turn this test green for the
    // wrong reason either.
    context.advanceClock(60_000);
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const approvalEvent = events.find((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvent?.meta.changed).toBe(true);
  });
});

describe("discardProposal", () => {
  it("records a reason on the event, leaves the PENDING partition, and never invokes the tool's apply", async () => {
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

    // Advanced so decidedAt is provably distinguishable from proposedAt
    // (Major 5), the same reasoning as the approve-path test above.
    context.advanceClock(60_000);
    const discarded = await discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "wrong case");
    expect(discarded.status).toBe("DISCARDED");
    expect(discarded.discardReason).toBe("wrong case");

    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    // Major 4: GSI1PK re-derivation, mirroring the two assertions the
    // property test already makes for the APPROVED transition. Without this,
    // a discarded proposal forced back onto the PENDING partition leaves the
    // whole suite green while `listPendingProposals` keeps returning it
    // forever -- the exact bug reviewQueue.ts:201-210 documents.
    const { proposals: pendingAfterDiscard } = await listPendingProposals(context, TENANT_ID);
    expect(pendingAfterDiscard.map((pending) => pending.proposalId)).not.toContain(staged.proposalId);
    const storedProposal = await context.table.get(
      proposalPartitionKey(TENANT_ID, staged.proposalId),
      PROPOSAL_SORT_KEY,
    );
    expect(storedProposal?.status).toBe("DISCARDED");
    expect(storedProposal?.GSI1PK).toBe(proposalStatusGsi1Pk(TENANT_ID, "DISCARDED"));

    // Major 5: decidedBy/decidedAt on the discard path too, and genuinely
    // distinct from proposedAt.
    expect(storedProposal?.decidedBy).toBe(ACTOR);
    expect(storedProposal?.decidedAt).toBe(context.now().toISOString());
    expect(storedProposal?.decidedAt).not.toBe(staged.proposedAt);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const discardEvent = events.find((event) => event.eventType === "PROPOSAL_DISCARDED");
    expect(discardEvent, "no PROPOSAL_DISCARDED event was recorded").toBeDefined();
    // Major 6: the reason is "the only part a human wrote" (notes §3) -- an
    // event of the right TYPE existing is not the same as it carrying what
    // the human actually said.
    expect(discardEvent?.meta.reason).toBe("wrong case");
    expect(discardEvent?.meta.proposalId).toBe(staged.proposalId);
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

// fix-round-2 N1: `getProposal` is the read-back `loop.ts`'s trust ladder now
// uses instead of inferring an outcome from the fact that `applyApprovedChange`
// threw. Unlike `applyApprovedChange`'s own internal read, this one must work
// at ANY status -- that is the entire point of it.
describe("getProposal", () => {
  it("reads a proposal back at whatever status it is actually stored at", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seeded.caseId, processing: "EXPRESS" },
      ACTOR,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    await expect(getProposal(context, TENANT_ID, staged.proposalId)).resolves.toMatchObject({ status: "PENDING" });

    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);
    await expect(getProposal(context, TENANT_ID, staged.proposalId)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("returns undefined for a proposal id nothing was ever staged under, rather than throwing", async () => {
    const context = buildTestContext();
    await expect(getProposal(context, TENANT_ID, "prop_never_existed")).resolves.toBeUndefined();
  });

  // fix-round-1 M3's schema-level backstop: ProposedChangeSchema's
  // `decidedBy` now carries `.min(1)`, so a stored row that names nobody as
  // the decider fails to parse rather than round-tripping as a legitimate
  // approval. The route layer (agentApi.ts's requireAdminEmail) is what
  // actually prevents this row from ever being written; this is what catches
  // it a second time, on read, if some future call site forgets.
  it("throws for a stored row whose decidedBy is an empty string, instead of reading back a proposal 'decided' by nobody", async () => {
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

    // A row only an admin token with no email claim could have produced, had
    // agentApi.ts's requireAdminEmail not refused it first -- written
    // directly, because applyApprovedChange/discardProposal can no longer
    // produce a decidedBy this empty.
    await context.table.put({
      PK: proposalPartitionKey(TENANT_ID, staged.proposalId),
      SK: PROPOSAL_SORT_KEY,
      GSI1PK: proposalStatusGsi1Pk(TENANT_ID, "APPROVED"),
      GSI1SK: staged.proposedAt,
      ...staged,
      status: "APPROVED",
      decidedBy: "",
      decidedAt: context.now().toISOString(),
    });

    await expect(getProposal(context, TENANT_ID, staged.proposalId)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// Minor 4: house convention (test/crm/partners.test.ts:129,
// test/crm/crmEvents.test.ts:48) is an explicit "other-tenant" case for
// every module that partitions by tenantId. The approval gate had none --
// the behaviour is already correct (the tenant is inside the partition key)
// but was unpinned, and this is the module where a cross-tenant apply would
// be worst.
describe("tenant isolation", () => {
  it("keeps a proposal invisible to, and inapplicable/undiscardable by, a different tenant", async () => {
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

    const otherTenantListing = await listPendingProposals(context, "other-tenant");
    expect(otherTenantListing.proposals).toEqual([]);

    await expect(
      applyApprovedChange(context, "other-tenant", staged.proposalId, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      discardProposal(context, "other-tenant", staged.proposalId, ACTOR, "wrong tenant"),
    ).rejects.toMatchObject({ statusCode: 404 });

    // And the proposal is untouched by either rejected attempt: still
    // reachable, still PENDING, under its real tenant.
    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.map((pending) => pending.proposalId)).toContain(staged.proposalId);
  });
});

describe("HIGH_STAKES_TOOLS / AUTO_APPLIABLE_TOOLS", () => {
  // Fix-round-1 ruling: no union-covers-WRITE_TOOLS assertion any more (see
  // approval.ts's AUTO_APPLIABLE_TOOLS doc comment) -- a write tool may be
  // classified into neither set on purpose. Disjointness and no-phantom-names
  // are the two properties that still have to hold unconditionally.
  it("keeps the two sets disjoint, and names neither a phantom tool", () => {
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
  });

  // create_case is deliberately unclassified (fix-round-1 ruling) -- pin
  // that it is absent from BOTH sets, so removing it from AUTO_APPLIABLE_TOOLS
  // without ALSO removing it here silently "fixes" the deliberate gap back
  // into a covered one.
  it("leaves create_case out of both sets, on purpose", () => {
    expect(HIGH_STAKES_TOOLS.has("create_case")).toBe(false);
    expect(AUTO_APPLIABLE_TOOLS.has("create_case")).toBe(false);
  });
});
