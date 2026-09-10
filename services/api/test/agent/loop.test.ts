import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MAX_TOOL_ITERATIONS, runAgentTurn } from "../../src/agent/loop";
import { setUserPrefs } from "../../src/agent/prefs";
import type { AgentTool } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import {
  AUTO_APPLIABLE_TOOLS,
  HIGH_STAKES_TOOLS,
  applyApprovedChange,
  listPendingProposals,
  stageProposal,
  type ProposedChange,
} from "../../src/agent/approval";
import { FakeLlmProvider, type ScriptedTurn } from "../../src/agent/providers/fake";
import type { AgentMessage } from "../../src/agent/providers/types";
import { getCase, createCase } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { memoryScope, rememberMemory } from "../../src/domain/crm/memory";
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

    // MIN-2: the full object, not just toolName -- a hardcoded `kind: "read"`
    // on every entry would satisfy a toolName-only comparison here.
    expect(result.toolCallsMade).toEqual([
      { toolName: "get_case", kind: "read" },
      { toolName: "set_billing", kind: "write" },
    ]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.status).toBe("PENDING");
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.reply).toBe("I've drafted the billing change for you to approve.");

    // MAJ-1 / B1: the staged half of the trust ladder must actually reach
    // storage, not merely appear in the in-memory result -- every user is on
    // this path by default, and a proposal that exists only in
    // `result.proposals` is a card in production whose Approve button 404s.
    // `listPendingProposals` is the same read the approval queue itself uses.
    const { proposals: pendingProposals } = await listPendingProposals(contextWithLlm, TENANT_ID);
    expect(pendingProposals.map((proposal) => proposal.proposalId)).toEqual([result.proposals[0]?.proposalId]);

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
    // MIN-3: decidedBy is who actually approved this -- unpinned before,
    // a constant would have satisfied the assertions above unnoticed.
    expect(resultAtTwo.appliedChanges[0]?.decidedBy).toBe(ACTOR);
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

  // MAJ-2 / B2: the trustLevel === 2 conjunct was itself unpinned --
  // contextAtTrustLevel defaults autoApplyOptIn to `level === 2`, so the
  // level-1 leg of the test above stages because autoApplyOptIn happens to
  // be false there, not because trustLevel isn't 2. This test forces
  // autoApplyOptIn true at level 1, a state production can genuinely reach:
  // setUserPrefs merges (prefs.test.ts's own "merges onto the existing row"
  // test proves it), so a demotion from {trustLevel: 2, autoApplyOptIn:
  // true} to {trustLevel: 1} leaves the flag on.
  it("stages at trust level 1 even when the user HAS opted in to auto-apply", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "LVL1-01");
    const context = await contextAtTrustLevel(
      1,
      [
        {
          text: "",
          toolCalls: [
            { toolCallId: "c1", toolName: "update_case", input: { caseId: seededCase.caseId, processing: "EXPRESS" } },
          ],
        },
        { text: "Done.", toolCalls: [] },
      ],
      { context: baseContext, autoApplyOptIn: true },
    );

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "switch this to express",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.appliedChanges).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    const caseAfterTurn = await getCase(context, TENANT_ID, seededCase.caseId);
    expect(caseAfterTurn.processing).toBeUndefined();
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

  // MAJ-3 / B3: nothing asserted on `receivedRequests[n].system` at all --
  // the whole of buildSystemPrompt, including the recallMemories call
  // inside it, could be replaced with a string constant and every other
  // test in this file would stay green.
  it("puts the tenant's ORG-scope memories into the system prompt", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "MEM-ORG-01");
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("ORG"),
        memoryKey: "billing_cadence",
        text: "Bill agencies weekly, every Friday.",
        sourceCaseId: seededCase.caseId,
      },
      ACTOR,
    );
    const contextWithLlm = Object.assign(context, { llm: new FakeLlmProvider([{ text: "sure", toolCalls: [] }]) });

    await runAgentTurn(contextWithLlm, TENANT_ID, { userMessage: "hi", conversation: [], actorEmail: ACTOR });

    expect(contextWithLlm.llm.receivedRequests[0]?.system).toContain("Bill agencies weekly, every Friday.");
  });

  // The half of B3 that matters most: a scoping bug in buildSystemPrompt
  // would leak one desk user's private memories into another user's prompt,
  // and without this, nothing would go red.
  it("puts the caller's own USER-scope memories into the prompt, and never another user's", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "MEM-USER-01");
    const OTHER_USER = "other-agent@rgs.local";
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("USER", ACTOR),
        memoryKey: "note_to_self",
        text: "Prefers EXPRESS for VIP partners.",
        sourceCaseId: seededCase.caseId,
      },
      ACTOR,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      {
        scope: memoryScope("USER", OTHER_USER),
        memoryKey: "note_to_self",
        text: "This is the other user's private note.",
        sourceCaseId: seededCase.caseId,
      },
      OTHER_USER,
    );
    const contextWithLlm = Object.assign(context, { llm: new FakeLlmProvider([{ text: "sure", toolCalls: [] }]) });

    await runAgentTurn(contextWithLlm, TENANT_ID, { userMessage: "hi", conversation: [], actorEmail: ACTOR });

    const systemPrompt = contextWithLlm.llm.receivedRequests[0]?.system ?? "";
    expect(systemPrompt).toContain("Prefers EXPRESS for VIP partners.");
    expect(systemPrompt).not.toContain("This is the other user's private note.");
  });

  // MAJ-4 / B4: every scripted turn elsewhere in this file omits `usage`,
  // so FakeLlmProvider defaults it to all zeroes -- asserting
  // `result.usage` equals zeroes would be vacuous by construction (the
  // standing rule: move the stored/scripted value off its default before
  // asserting against it). Two turns, non-zero and DIFFERENT from each
  // other, so only a real sum produces the expected total.
  it("sums usage across every model call in the turn", async () => {
    const context = buildTestContextWithFakeLlm([
      {
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "list_partners", input: {} }],
        usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 1 },
      },
      { text: "done", toolCalls: [], usage: { inputTokens: 30, outputTokens: 5, cachedTokens: 4 } },
    ]);

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "list partners",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 7, cachedTokens: 5 });
  });

  // MAJ-5 / B5: the brief names this branch explicitly ("if unknown, feed
  // back an error message as a tool_result rather than throwing") and
  // controller-notes §5 restates it, but no test called an unknown tool
  // name until now -- a `throw` in its place reddened nothing.
  it("feeds back an unknown tool name as an ordinary tool_result instead of throwing", async () => {
    const context = buildTestContextWithFakeLlm([
      { text: "", toolCalls: [{ toolCallId: "c1", toolName: "no_such_tool", input: {} }] },
      { text: "I don't have that tool.", toolCalls: [] },
    ]);

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "do the thing",
      conversation: [],
      actorEmail: ACTOR,
    });

    expect(result.reply).toBe("I don't have that tool.");
    // Never reached the registry as a real dispatch.
    expect(result.toolCallsMade).toEqual([]);

    const secondRequestMessages = context.llm.receivedRequests[1]?.messages ?? [];
    const toolResult = secondRequestMessages.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toContain("no_such_tool");
  });

  // MAJ-7 / B6: a hardcoded stand-in identity threaded into `execute`
  // instead of `input.actorEmail` reddened nothing, because every test's
  // caller and every test's seeded prefs happened to share ACTOR's own
  // literal. The real caller here (REAL_CALLER) is deliberately a THIRD
  // identity, distinct from ACTOR (who is opted in to auto-apply) and from
  // the two constants the loop hardcoded before B6/N3 closed them (fix-
  // round-2 NEW-6: the prior wording claimed this was distinct from "any
  // constant the loop might hardcode", which overstates what the test
  // actually proves) -- so the write must stay staged (proving prefs were
  // read for the real caller, not for ACTOR), the proposal must name
  // REAL_CALLER as its proposer (proving the identity threaded into
  // execute() is the real one, not a stand-in), and ACTOR's own private
  // memory must not reach a prompt built for REAL_CALLER (fix-round-2 N3:
  // the same USER-scope leak B3 closed inside `buildSystemPrompt`, one call
  // frame earlier -- nothing previously pinned the identity handed TO it).
  it("reads trust-level prefs and records proposals under the actual caller's identity, not a hardcoded stand-in", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "ID-01");
    const REAL_CALLER = "manager@rgs.local";
    await setUserPrefs(baseContext, TENANT_ID, ACTOR, { trustLevel: 2, autoApplyOptIn: true });
    await rememberMemory(
      baseContext,
      TENANT_ID,
      {
        scope: memoryScope("USER", ACTOR),
        memoryKey: "note_to_self",
        text: "ACTOR's own private note -- REAL_CALLER must never see this.",
        sourceCaseId: seededCase.caseId,
      },
      ACTOR,
    );
    const contextWithLlm = Object.assign(baseContext, {
      llm: new FakeLlmProvider([
        {
          text: "",
          toolCalls: [
            { toolCallId: "c1", toolName: "update_case", input: { caseId: seededCase.caseId, processing: "EXPRESS" } },
          ],
        },
        { text: "done", toolCalls: [] },
      ]),
    });

    const result = await runAgentTurn(contextWithLlm, TENANT_ID, {
      userMessage: "switch to express",
      conversation: [],
      actorEmail: REAL_CALLER,
    });

    // REAL_CALLER has no PREFS row of its own -- trust level 0 -- so this
    // must stay staged even though ACTOR (a different user) is opted in at
    // level 2. Auto-applying here would mean prefs were read under the
    // wrong identity.
    expect(result.appliedChanges).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.proposedBy).toBe(REAL_CALLER);

    // N3: the prompt itself must be built for REAL_CALLER, not ACTOR --
    // proved separately from the proposal-identity assertions above.
    const systemPrompt = contextWithLlm.llm.receivedRequests[0]?.system ?? "";
    expect(systemPrompt).not.toContain("ACTOR's own private note");
  });

  // B8 / review Probe 1: the redundant !HIGH_STAKES_TOOLS.has(...) conjunct
  // reads as defense-in-depth in loop.ts's own comment, but nothing forced
  // that claim to be checkable. AUTO_APPLIABLE_TOOLS is a real Set at
  // runtime despite its ReadonlySet type, so a cast constructs the exact
  // violation the conjunct exists for -- a tool on BOTH lists -- and proves
  // the write still stages.
  it("stages a high-stakes tool even when it has been added to AUTO_APPLIABLE_TOOLS", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "GUARD-01");
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
        { text: "done", toolCalls: [] },
      ],
      { context: baseContext },
    );

    (AUTO_APPLIABLE_TOOLS as Set<string>).add("set_billing");
    try {
      expect(AUTO_APPLIABLE_TOOLS.has("set_billing")).toBe(true);
      expect(HIGH_STAKES_TOOLS.has("set_billing")).toBe(true);

      const result = await runAgentTurn(context, TENANT_ID, {
        userMessage: "bill this case",
        conversation: [],
        actorEmail: ACTOR,
      });

      expect(result.proposals).toHaveLength(1);
      expect(result.appliedChanges).toHaveLength(0);
      expect((await getCase(context, TENANT_ID, seededCase.caseId)).billingStatus).toBe("UNBILLED");
    } finally {
      (AUTO_APPLIABLE_TOOLS as Set<string>).delete("set_billing");
    }
  });

  // MIN-1: `conversation` is part of the brief's own declared input and no
  // other test in this file ever passes a non-empty one, so dropping it
  // reddened nothing.
  it("carries prior conversation into the first request's messages", async () => {
    const context = buildTestContextWithFakeLlm([{ text: "sure thing", toolCalls: [] }]);
    const priorConversation: AgentMessage[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];

    await runAgentTurn(context, TENANT_ID, {
      userMessage: "follow up",
      conversation: priorConversation,
      actorEmail: ACTOR,
    });

    expect(context.llm.receivedRequests[0]?.messages).toEqual([
      ...priorConversation,
      { role: "user", content: "follow up" },
    ]);
  });

  // MIN-4: a model that narrates before calling a tool loses that
  // narration from its own next-iteration context if the loop drops it,
  // and nothing would notice.
  it("keeps the assistant's own narration in the transcript across iterations", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "NARR-01");
    const contextWithLlm = Object.assign(context, {
      llm: new FakeLlmProvider([
        {
          text: "Let me check that case for you.",
          toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: seededCase.caseId } }],
        },
        { text: "done", toolCalls: [] },
      ]),
    });

    await runAgentTurn(contextWithLlm, TENANT_ID, { userMessage: "look it up", conversation: [], actorEmail: ACTOR });

    const secondRequestMessages = contextWithLlm.llm.receivedRequests[1]?.messages ?? [];
    expect(secondRequestMessages).toContainEqual({ role: "assistant", content: "Let me check that case for you." });
  });

  // A1 / MAJ-6: applyApprovedChange can throw AFTER stageProposal already
  // wrote a PENDING row -- set_custody's own `execute` builds its diff
  // without checking the transition is legal (it only checks the applicant
  // exists), but `changeApplicantCustody`, the real domain call `apply`
  // makes, refuses NOT_HELD -> AT_EMBASSY via the real custody state
  // machine. Reproduced with the real tool and the real state machine, no
  // mocking. Both halves of the claim ("named in proposals" and "really
  // staged in storage") are proved separately, and a third: the model is
  // told what actually happened.
  it("names a staged proposal in `proposals` when its auto-apply throws after staging, rather than orphaning it", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "ORPHAN-01");
    const context = await contextAtTrustLevel(
      2,
      [
        {
          text: "",
          toolCalls: [
            {
              toolCallId: "c1",
              toolName: "set_custody",
              input: { caseId: seededCase.caseId, applicantRef: "A1", custody: "AT_EMBASSY" },
            },
          ],
        },
        { text: "done", toolCalls: [] },
      ],
      { context: baseContext },
    );

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "move custody to the embassy",
      conversation: [],
      actorEmail: ACTOR,
    });

    const { proposals: pendingProposals } = await listPendingProposals(context, TENANT_ID);
    expect({
      returnedProposals: result.proposals.length,
      returnedApplied: result.appliedChanges.length,
      pendingRowsInStore: pendingProposals.length,
    }).toEqual({ returnedProposals: 1, returnedApplied: 0, pendingRowsInStore: 1 });
    expect(result.proposals[0]?.proposalId).toBe(pendingProposals[0]?.proposalId);

    // The model is told it was staged for a human, not merely that
    // something failed.
    const secondRequestMessages = context.llm.receivedRequests[1]?.messages ?? [];
    const toolResult = secondRequestMessages.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toContain("Staged for human approval");
  });

  // fix-round-2 N1: the inverse of MAJ-6, and round 1's own fault (the
  // coordinator's ruling, not the implementer's -- A1 said "record it in
  // `proposals` when the subsequent apply throws" and never said what the
  // catch may assume about WHERE in `applyApprovedChange` the throw came
  // from). `applyApprovedChange` runs apply() -> putProposal(APPROVED) ->
  // recordCrmEvent(PROPOSAL_APPROVED); a throw from the LAST of those three
  // means the domain mutation already landed and the approval row is
  // already APPROVED, so inferring "still PENDING" from the mere fact that
  // something threw is exactly backwards here. Reproduced with the real
  // loop, the real tools and the real state machine -- the only injected
  // fault is one table write, chosen by its own `eventType`, so nothing
  // about `update_case` or `applyApprovedChange` is mocked.
  it("reads back what actually happened when apply succeeds but the write after it fails, instead of guessing", async () => {
    const baseContext = buildTestContext();
    const seededCase = await seedOneCase(baseContext, "N1-01");
    const context = await contextAtTrustLevel(
      2,
      [
        {
          text: "",
          toolCalls: [
            {
              toolCallId: "c1",
              toolName: "update_case",
              input: { caseId: seededCase.caseId, processing: "EXPRESS" },
            },
          ],
        },
        { text: "done", toolCalls: [] },
      ],
      { context: baseContext },
    );

    // The only injected fault: the audit-trail write specifically, chosen by
    // its own eventType, so every other write in the turn (including the
    // domain mutation itself) goes through untouched.
    const realTablePut = context.table.put.bind(context.table);
    context.table.put = async (item) => {
      if (item["eventType"] === "PROPOSAL_APPROVED") {
        throw new Error("audit write blew up");
      }
      return realTablePut(item);
    };

    const result = await runAgentTurn(context, TENANT_ID, {
      userMessage: "switch to express",
      conversation: [],
      actorEmail: ACTOR,
    });

    const { proposals: pendingProposals } = await listPendingProposals(context, TENANT_ID);
    const caseAfterTurn = await getCase(context, TENANT_ID, seededCase.caseId);

    // All four together, because this defect is precisely a set of them
    // disagreeing: the bucket the turn actually returns it in, the status
    // the row is actually persisted at, whether the case actually moved,
    // and what the model is actually told.
    expect({
      returnedApplied: result.appliedChanges.length,
      returnedProposals: result.proposals.length,
      persistedStatus: result.appliedChanges[0]?.status,
      caseProcessing: caseAfterTurn.processing,
      pendingRowsInStore: pendingProposals.length,
    }).toEqual({
      returnedApplied: 1,
      returnedProposals: 0,
      persistedStatus: "APPROVED",
      caseProcessing: "EXPRESS",
      pendingRowsInStore: 0,
    });

    const secondRequestMessages = context.llm.receivedRequests[1]?.messages ?? [];
    const toolResult = secondRequestMessages.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toContain("Applied on your behalf");
    expect(toolResult?.content).not.toContain("Staged for human approval");
  });
});
