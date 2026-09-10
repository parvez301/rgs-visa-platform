import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MAX_TOOL_ITERATIONS, runAgentTurn } from "../../src/agent/loop";
import { setUserPrefs } from "../../src/agent/prefs";
import type { AgentTool } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { applyApprovedChange, stageProposal, type ProposedChange } from "../../src/agent/approval";
import { FakeLlmProvider, type ScriptedTurn } from "../../src/agent/providers/fake";
import { getCase, createCase } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { newId } from "../../src/lib/ids";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

// Mirrors writeTools.test.ts's / approval.test.ts's own helper: caseRef
// doubles as the partner's name suffix so two calls in one test do not trip
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
 * ruling P6 (task-10-controller-notes.md §1): neither of these helpers
 * exists anywhere in the codebase -- `buildTestContext()` from `../helpers`
 * is the only piece task-10-brief.md's pseudocode got right; the rest is
 * written here.
 */
function buildTestContextWithFakeLlm(scriptedTurns: ScriptedTurn[]): TestContext & { llm: FakeLlmProvider } {
  const context = buildTestContext();
  return Object.assign(context, { llm: new FakeLlmProvider(scriptedTurns) });
}

/**
 * Seeds a PREFS row through prefs.ts's own `setUserPrefs` rather than a raw
 * table write (ruling P6). `options.context` lets a caller seed a case (or
 * anything else) on the same context BEFORE the trust level is set, since a
 * scripted tool call that names a caseId has to know that id before the
 * FakeLlmProvider can be built. `autoApplyOptIn` defaults to `level === 2`
 * for convenience -- most level-2 tests want auto-apply actually eligible --
 * but is always overridable, because task-10-controller-notes.md §9's own
 * test needs a level-2 user who has explicitly NOT opted in.
 */
async function contextAtTrustLevel(
  level: 0 | 1 | 2,
  scriptedTurns: ScriptedTurn[],
  options: { autoApplyOptIn?: boolean; context?: TestContext } = {},
): Promise<TestContext & { llm: FakeLlmProvider }> {
  const baseContext = options.context ?? buildTestContext();
  const contextWithLlm = Object.assign(baseContext, { llm: new FakeLlmProvider(scriptedTurns) });
  await setUserPrefs(contextWithLlm, TENANT_ID, ACTOR, {
    trustLevel: level,
    autoApplyOptIn: options.autoApplyOptIn ?? level === 2,
  });
  return contextWithLlm;
}

describe("runAgentTurn", () => {
  it("throws badRequest when the context has no llm provider attached", async () => {
    const context = buildTestContext();
    await expect(
      runAgentTurn(context, TENANT_ID, { userMessage: "hi", conversation: [], actorEmail: ACTOR }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("runs read tools automatically and stages write tools, in one turn", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-01");
    const contextWithLlm = Object.assign(context, {
      llm: new FakeLlmProvider([
        { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: seededCase.caseId } }] },
        {
          text: "",
          toolCalls: [
            {
              toolCallId: "c2",
              toolName: "set_billing",
              input: { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
            },
          ],
        },
        { text: "I've drafted the billing change for you to approve.", toolCalls: [] },
      ]),
    });

    const result = await runAgentTurn(contextWithLlm, TENANT_ID, {
      userMessage: "bill this case",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.toolCallsMade.map((call) => call.toolName)).toEqual(["get_case", "set_billing"]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.status).toBe("PENDING");
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.reply).toBe("I've drafted the billing change for you to approve.");

    // The second half of "stages, does not apply": the case itself must
    // still show the pre-proposal billing status -- UNBILLED, never
    // BILL_SENT, which is what a proposal that silently applied would leave
    // behind (top-level instructions: prove the write half separately).
    const caseAfterTurn = await getCase(contextWithLlm, TENANT_ID, seededCase.caseId);
    expect(caseAfterTurn.billingStatus).toBe("UNBILLED");
  });

  it("stages a high-stakes write even at trust level 2", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "HS-01");
    const context = await contextAtTrustLevel(
      2,
      [
        {
          text: "",
          toolCalls: [
            {
              toolCallId: "c1",
              toolName: "set_billing",
              input: { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
            },
          ],
        },
        { text: "Staged for you.", toolCalls: [] },
      ],
      { context: baseContext },
    );

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "bill this case",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.proposals).toHaveLength(1); // NOT auto-applied
    expect(result.appliedChanges).toHaveLength(0);

    const caseAfterTurn = await getCase(context, TENANT_ID, seededCase.caseId);
    expect(caseAfterTurn.billingStatus).toBe("UNBILLED");
  });

  it("auto-applies a low-stakes write at trust level 2, and only there", async () => {
    const scriptFor = (caseId: string): ScriptedTurn[] => [
      {
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "update_case", input: { caseId, processing: "EXPRESS" } }],
      },
      { text: "Done.", toolCalls: [] },
    ];

    const baseContextAtTwo = buildTestContext();
    const caseAtTwo = await seedOneCase(baseContextAtTwo, "LS-02");
    const contextAtTwo = await contextAtTrustLevel(2, scriptFor(caseAtTwo.caseId), { context: baseContextAtTwo });
    const resultAtTwo = await runAgentTurn(contextAtTwo, TENANT_ID, {
      userMessage: "switch this to express",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(resultAtTwo.proposals).toHaveLength(0);
    expect(resultAtTwo.appliedChanges).toHaveLength(1);
    // A change the caller cannot name is a change the user cannot undo
    // (task-10-controller-notes.md §2) -- proposalId must be the real one,
    // and status must read as an approval, not a leftover PENDING.
    expect(resultAtTwo.appliedChanges[0]?.status).toBe("APPROVED");
    expect(resultAtTwo.appliedChanges[0]?.proposalId).toMatch(/^prop_/);
    // The write actually happened -- the case itself moved, not merely the
    // turn's own bookkeeping (top-level instructions: prove this separately).
    const caseAtTwoAfterTurn = await getCase(contextAtTwo, TENANT_ID, caseAtTwo.caseId);
    expect(caseAtTwoAfterTurn.processing).toBe("EXPRESS");

    const baseContextAtOne = buildTestContext();
    const caseAtOne = await seedOneCase(baseContextAtOne, "LS-01");
    const contextAtOne = await contextAtTrustLevel(1, scriptFor(caseAtOne.caseId), { context: baseContextAtOne });
    const resultAtOne = await runAgentTurn(contextAtOne, TENANT_ID, {
      userMessage: "switch this to express",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(resultAtOne.proposals).toHaveLength(1);
    expect(resultAtOne.appliedChanges).toHaveLength(0);
    // And the second half at level 1: nothing actually moved.
    const caseAtOneAfterTurn = await getCase(contextAtOne, TENANT_ID, caseAtOne.caseId);
    expect(caseAtOneAfterTurn.processing).toBeUndefined();
  });

  // task-10-controller-notes.md §9: autoApplyOptIn defaults to false on the
  // schema, so this is the state every real user starts in even after they
  // have been moved to trustLevel 2 by whatever future screen does that.
  it("stages rather than auto-applies at trust level 2 when the user has not opted in", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "LS-03");
    const context = await contextAtTrustLevel(
      2,
      [
        {
          text: "",
          toolCalls: [{ toolCallId: "c1", toolName: "update_case", input: { caseId: seededCase.caseId, processing: "EXPRESS" } }],
        },
        { text: "Done.", toolCalls: [] },
      ],
      { context: baseContext, autoApplyOptIn: false },
    );

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "switch this to express",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(result.proposals).toHaveLength(1);
    expect(result.appliedChanges).toHaveLength(0);
  });

  it("stops after MAX_TOOL_ITERATIONS rather than looping forever on a model that keeps calling tools", async () => {
    const neverStops: ScriptedTurn[] = Array.from({ length: 20 }, () => ({
      text: "",
      toolCalls: [{ toolCallId: "c", toolName: "list_partners", input: {} }],
    }));
    const context = buildTestContextWithFakeLlm(neverStops);
    const result = await runAgentTurn(context, TENANT_ID, { userMessage: "hi", conversation: [], actorEmail: ACTOR });
    expect(result.toolCallsMade).toHaveLength(MAX_TOOL_ITERATIONS);
  });

  it("feeds a failing tool's error back to the model instead of aborting the turn", async () => {
    const context = buildTestContextWithFakeLlm([
      { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: "nope" } }] },
      { text: "That case doesn't exist.", toolCalls: [] },
    ]);
    const result = await runAgentTurn(context, TENANT_ID, { userMessage: "find nope", conversation: [], actorEmail: ACTOR });
    expect(result.reply).toContain("doesn't exist");
  });

  // task-10-controller-notes.md §5: the brief's own throwing-tool test uses a
  // 404 (a missing case); the tools built in Tasks 4-5 also throw a plain
  // Error, not an ApiError, when called underspecified -- search_cases with
  // neither filter is one. Both kinds must come back as an ordinary
  // tool_result, never escape the turn.
  it("feeds back a plain thrown Error the same way, not only an ApiError", async () => {
    const context = buildTestContextWithFakeLlm([
      { text: "", toolCalls: [{ toolCallId: "c1", toolName: "search_cases", input: {} }] },
      { text: "I need a caseStatus or a partnerId to search by.", toolCalls: [] },
    ]);
    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "find some cases",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(result.reply).toContain("caseStatus or a partnerId");
    // Validated fine and reached execute -- it just threw once inside.
    expect(result.toolCallsMade).toEqual([{ toolName: "search_cases", kind: "read" }]);
  });

  // task-10-controller-notes.md §4 / ruling P15: providers/gemini.ts
  // attributes a functionResponse by tool NAME, not by call id. A
  // FakeLlmProvider-only test would never catch a dropped toolName -- the
  // fake does not care -- so this asserts directly on the constructed
  // message.
  it("carries toolName on every tool_result message it builds, not just toolCallId", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "TN-01");
    const contextWithLlm = Object.assign(context, {
      llm: new FakeLlmProvider([
        { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: seededCase.caseId } }] },
        { text: "done", toolCalls: [] },
      ]),
    });

    await runAgentTurn(contextWithLlm, TENANT_ID, { userMessage: "look it up", conversation: [], actorEmail: ACTOR });

    const secondRequestMessages = contextWithLlm.llm.receivedRequests[1]?.messages ?? [];
    const toolResultMessages = secondRequestMessages.filter((message) => message.role === "tool_result");
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]).toMatchObject({ toolCallId: "c1", toolName: "get_case" });
  });

  // task-10-controller-notes.md §7 / ruling P30: ToolRegistry.get() returns
  // AgentTool | undefined, and AgentTool.execute is checked bivariantly, so
  // nothing at the call site enforces that a model's tool call actually
  // matches the tool's inputSchema. The loop is where that guarantee has to
  // come from.
  it("validates a tool call's input before dispatching it -- a malformed argument comes back as a validation message, not a crash", async () => {
    const context = buildTestContextWithFakeLlm([
      { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: 12345 } }] },
      { text: "caseId needs to be text, not a number.", toolCalls: [] },
    ]);
    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "look up case 12345",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.reply).toBe("caseId needs to be text, not a number.");
    // The call never reached get_case's execute -- toolCallsMade proves the
    // gate stopped it before dispatch, not merely that the turn survived it.
    expect(result.toolCallsMade).toEqual([]);

    const secondRequestMessages = context.llm.receivedRequests[1]?.messages ?? [];
    const validationResult = secondRequestMessages.find((message) => message.role === "tool_result");
    expect(validationResult?.content).toContain("caseId");
  });

  // task-10-controller-notes.md §8 / ruling P46: auto-apply must consult
  // AUTO_APPLIABLE_TOOLS (an ALLOW-list), not merely "absent from
  // HIGH_STAKES_TOOLS" -- a write tool added later and forgotten by both
  // sets must stay staged, not slip through as auto-appliable by default.
  // WRITE_TOOLS is a plain exported array; pushing a throwaway tool onto it
  // for the duration of this one test is how task-10-controller-notes.md §1
  // says to "register" a tool the loop does not otherwise know about --
  // runAgentTurn builds its registry from this array on every call, so the
  // push is visible without changing runAgentTurn's own signature.
  it("stages a write tool that is in neither AUTO_APPLIABLE_TOOLS nor HIGH_STAKES_TOOLS, even at trust level 2", async () => {
    const throwawayWriteTool: AgentTool<Record<string, never>> = {
      name: "throwaway_write_tool",
      kind: "write",
      description: "Exists only to prove auto-apply consults an allow-list, not mere absence from a deny-list.",
      inputSchema: z.object({}),
      execute: async (context) => ({
        proposalId: newId("prop", context.now().getTime()),
        toolName: "throwaway_write_tool",
        input: {},
        summary: [{ field: "x", from: "a", to: "b" }],
        proposedBy: ACTOR,
        proposedAt: context.now().toISOString(),
        status: "PENDING" as const,
      }),
      apply: async () => ({ ok: true }),
    };

    WRITE_TOOLS.push(throwawayWriteTool);
    try {
      const context = await contextAtTrustLevel(2, [
        { text: "", toolCalls: [{ toolCallId: "c1", toolName: "throwaway_write_tool", input: {} }] },
        { text: "done", toolCalls: [] },
      ]);
      const result = await runAgentTurn(context, TENANT_ID, {
        userMessage: "do the throwaway thing",
        conversation: [],
        actorEmail: ACTOR,
      });
      expect(result.proposals).toHaveLength(1);
      expect(result.appliedChanges).toHaveLength(0);
    } finally {
      WRITE_TOOLS.splice(WRITE_TOOLS.indexOf(throwawayWriteTool), 1);
    }
  });

  // task-10-controller-notes.md §3: an auto-applied change must not read, in
  // the case's own audit trail, as though a human reviewed it.
  it("marks an auto-applied change's PROPOSAL_APPROVED event so it cannot be mistaken for a human approval", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "DIST-01");

    const autoContext = await contextAtTrustLevel(
      2,
      [
        {
          text: "",
          toolCalls: [
            { toolCallId: "c1", toolName: "update_case", input: { caseId: seededCase.caseId, processing: "EXPRESS" } },
          ],
        },
        { text: "done", toolCalls: [] },
      ],
      { context: baseContext },
    );
    const autoResult = await runAgentTurn(autoContext, TENANT_ID, {
      userMessage: "switch to express",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(autoResult.appliedChanges).toHaveLength(1);

    // Same case, staged and approved the ordinary way -- a human clicking
    // Approve in the review queue, not the trust ladder. `applyApprovedChange`
    // defaults `autoApplied` to `false`, exactly like every pre-Task-10 call
    // site (Task 11's approve endpoint among them).
    const registryHumanTool = WRITE_TOOLS.find((tool) => tool.name === "update_case");
    if (registryHumanTool === undefined) throw new Error("update_case missing from WRITE_TOOLS");
    const humanProposal = (await registryHumanTool.execute(
      autoContext,
      TENANT_ID,
      { caseId: seededCase.caseId, submissionDate: "2026-09-20" },
      ACTOR,
    )) as ProposedChange;
    await stageProposal(autoContext, TENANT_ID, humanProposal);
    await applyApprovedChange(autoContext, TENANT_ID, humanProposal.proposalId, ACTOR);

    // Not indexed positionally: both proposals land under the same frozen
    // test clock, so two PROPOSAL_APPROVED events can tie on createdAt and
    // sort by their (random) eventId instead of call order. Matched by
    // proposalId instead, which is what actually distinguishes them.
    const events = await listCaseEvents(autoContext, TENANT_ID, seededCase.caseId);
    const approvalEvents = events.filter((event) => event.eventType === "PROPOSAL_APPROVED");
    expect(approvalEvents).toHaveLength(2);
    const autoProposalId = autoResult.appliedChanges[0]?.proposalId;
    const autoEvent = approvalEvents.find((event) => event.meta.proposalId === autoProposalId);
    const humanEvent = approvalEvents.find((event) => event.meta.proposalId === humanProposal.proposalId);
    expect(autoEvent?.meta.autoApplied).toBe(true);
    expect(humanEvent?.meta.autoApplied).toBe(false);
  });
});
