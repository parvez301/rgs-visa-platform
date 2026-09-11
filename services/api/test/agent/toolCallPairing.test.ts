import { describe, expect, it } from "vitest";
import { runAgentTurn } from "../../src/agent/loop";
import { FakeLlmProvider, type ScriptedTurn } from "../../src/agent/providers/fake";
import { mapMessagesToAnthropic } from "../../src/agent/providers/anthropic";
import { mapMessagesToGemini } from "../../src/agent/providers/gemini";
import type { AgentMessage } from "../../src/agent/providers/types";
import { createCase } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { buildTestContext, type TestContext } from "../helpers";

/**
 * The seam test this branch never had (branch review C1 / M3).
 *
 * Tasks 2 and 3 reviewed the adapters against hand-built message arrays, each
 * holding a single standalone `tool_result`. Task 10 reviewed the loop against
 * `FakeLlmProvider`, which accepts any array at all. Nothing composed the two,
 * and the defect lived exactly there: the loop built a transcript in which
 * every `tool_result` answered a `tool_use` that was never transmitted --
 * because `AgentMessage` had no field that could carry one -- so the second
 * model call of every tool-using turn was an `invalid_request_error` at both
 * real providers. 629 tests were green.
 *
 * So this file owns the seam rather than either side of it: it drives the REAL
 * loop with the fake provider, takes the messages the loop actually sent on a
 * later call, and pushes them through the two REAL adapter mappers. What it
 * asserts is the pairing invariant both vendors enforce:
 *
 *   every tool_result / functionResponse is paired with a matching
 *   tool_use / functionCall in the IMMEDIATELY PRECEDING assistant turn,
 *
 * plus its second half, which Anthropic is equally strict about: all of one
 * turn's results live in ONE user message, never spread across consecutive
 * ones.
 */

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedOneCase(context: TestContext, caseRef: string) {
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
 * Runs a real turn and hands back what the loop sent to the model on the
 * `requestIndex`-th call (0-based). `receivedRequests[1]` is the call that
 * carries the first iteration's history -- the request the real providers were
 * rejecting.
 */
async function messagesSentOnRequest(
  buildScriptedTurns: (seededCase: { caseId: string }) => ScriptedTurn[],
  requestIndex: number,
  seedCaseRef: string,
): Promise<AgentMessage[]> {
  const context = buildTestContext();
  const seededCase = await seedOneCase(context, seedCaseRef);
  const contextWithLlm = Object.assign(context, {
    llm: new FakeLlmProvider(buildScriptedTurns(seededCase)),
  });

  await runAgentTurn(contextWithLlm, TENANT_ID, {
    userMessage: "how is that case doing?",
    conversation: [],
    actorEmail: ACTOR,
  });

  const sentMessages = contextWithLlm.llm.receivedRequests[requestIndex]?.messages;
  expect(sentMessages, `the loop never made model call #${requestIndex + 1}`).toBeDefined();
  return sentMessages!;
}

import {
  anthropicBlocks,
  anthropicPairingViolations,
  countAnthropicBlocks,
  countGeminiParts,
  expectEveryToolResultPaired,
  geminiPairingViolations,
  geminiParts,
  type AnthropicMessage,
  type GeminiContent,
} from "../pairingWalkers";

describe("the loop -> adapter seam: every tool result reaches the provider paired with its call", () => {
  it("pairs a single tool call with its result, through both real mappers", async () => {
    let seededCaseId = "";
    const messages = await messagesSentOnRequest(
      (seededCase) => {
        seededCaseId = seededCase.caseId;
        return [
          {
            text: "",
            toolCalls: [
              { toolCallId: "toolu_01ABC", toolName: "get_case", input: { caseId: seededCase.caseId } },
            ],
          },
          { text: "It is still NEW.", toolCalls: [] },
        ];
      },
      1,
      "PAIR-01",
    );

    expectEveryToolResultPaired(messages, 1);

    // The concrete shape, spelled out once, so a reader of this file can see
    // what "paired" means without reconstructing it from the walkers above.
    const anthropicMessages = mapMessagesToAnthropic(messages) as AnthropicMessage[];
    const assistantMessage = anthropicMessages.find((message) => message.role === "assistant");
    expect(anthropicBlocks(assistantMessage ?? {})).toContainEqual({
      type: "tool_use",
      id: "toolu_01ABC",
      name: "get_case",
      input: { caseId: seededCaseId },
    });
  });

  it("keeps the pairing when the model calls a tool with no text of its own", async () => {
    const messages = await messagesSentOnRequest(
      () => [
        { text: "", toolCalls: [{ toolCallId: "toolu_silent", toolName: "list_partners", input: {} }] },
        { text: "Here they are.", toolCalls: [] },
      ],
      1,
      "PAIR-02",
    );

    // The regression this pins specifically: the loop used to push the
    // assistant turn only `if (completion.text !== "")`, so a silent
    // tool-calling turn -- the COMMON case -- transmitted no assistant
    // message at all and the transcript became two consecutive user turns
    // with an orphan tool_result between them.
    expectEveryToolResultPaired(messages, 1);
    const anthropicMessages = mapMessagesToAnthropic(messages) as AnthropicMessage[];
    const assistantMessage = anthropicMessages.find((message) => message.role === "assistant");
    expect(assistantMessage, "a silent tool-calling turn transmitted no assistant message").toBeDefined();
    // No empty text block rides along with the calls.
    expect(anthropicBlocks(assistantMessage!).every((block) => block.type === "tool_use")).toBe(true);
  });

  it("batches two tool calls made in one iteration into a single results message, still paired", async () => {
    const messages = await messagesSentOnRequest(
      () => [
        {
          text: "Let me check both.",
          toolCalls: [
            { toolCallId: "toolu_first", toolName: "list_partners", input: {} },
            { toolCallId: "toolu_second", toolName: "aggregate", input: { groupBy: "caseStatus" } },
          ],
        },
        { text: "Both done.", toolCalls: [] },
      ],
      1,
      "PAIR-03",
    );

    expectEveryToolResultPaired(messages, 2);

    // M3, stated directly: Anthropic requires both results in ONE user
    // message. A 1:1 message mapping produced two consecutive user messages
    // holding one block each, which the API refuses.
    const anthropicMessages = mapMessagesToAnthropic(messages) as AnthropicMessage[];
    const resultMessages = anthropicMessages.filter(
      (message) => anthropicBlocks(message).some((block) => block.type === "tool_result"),
    );
    expect(resultMessages).toHaveLength(1);
    expect(anthropicBlocks(resultMessages[0]!)).toHaveLength(2);

    const geminiContents = mapMessagesToGemini(messages) as GeminiContent[];
    const responseTurns = geminiContents.filter((content) =>
      geminiParts(content).some((part) => part.functionResponse !== undefined),
    );
    expect(responseTurns).toHaveLength(1);
    expect(geminiParts(responseTurns[0]!)).toHaveLength(2);
  });

  it("pairs each iteration's results with that iteration's own calls, over two iterations", async () => {
    const messages = await messagesSentOnRequest(
      () => [
        { text: "", toolCalls: [{ toolCallId: "toolu_it1", toolName: "list_partners", input: {} }] },
        { text: "", toolCalls: [{ toolCallId: "toolu_it2", toolName: "aggregate", input: { groupBy: "caseStatus" } }] },
        { text: "All done.", toolCalls: [] },
      ],
      2,
      "PAIR-04",
    );

    // Two separate assistant turns, each followed by its own results message.
    // Batching must not run the two iterations' results together, and the
    // first iteration's result must not drift onto the second's call.
    expectEveryToolResultPaired(messages, 2);
    const anthropicMessages = mapMessagesToAnthropic(messages) as AnthropicMessage[];
    const resultMessages = anthropicMessages.filter(
      (message) => anthropicBlocks(message).some((block) => block.type === "tool_result"),
    );
    expect(resultMessages).toHaveLength(2);
  });

  it("pairs a staged write tool's result, not only read tools' results", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "PAIR-05");
    const contextWithLlm = Object.assign(context, {
      llm: new FakeLlmProvider([
        {
          text: "",
          toolCalls: [
            {
              toolCallId: "toolu_write",
              toolName: "set_billing",
              input: { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
            },
          ],
        },
        { text: "Staged it for you.", toolCalls: [] },
      ]),
    });

    const result = await runAgentTurn(contextWithLlm, TENANT_ID, {
      userMessage: "bill this case",
      conversation: [],
      actorEmail: ACTOR,
    });
    expect(result.proposals).toHaveLength(1);

    // The trust ladder pushes its "Staged for human approval" text through the
    // same tool_result path, so it is subject to the same invariant -- and a
    // write turn is the one a user is most likely to be in the middle of when
    // a malformed request costs them the turn.
    expectEveryToolResultPaired(contextWithLlm.llm.receivedRequests[1]?.messages ?? [], 1);
  });

  it("pairs a client-replayed assistant turn's calls with the results replayed after them", async () => {
    // The route lets a client send `conversation` back (http/agentApi.ts).
    // If that replay could not carry the assistant turn's own calls, the
    // break C1 fixed in the loop would simply walk back in through the route
    // on the next turn -- so the mappers must pair a replayed transcript
    // exactly as they pair one the loop built.
    const replayedConversation: AgentMessage[] = [
      { role: "user", content: "how many cases are open?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ toolCallId: "toolu_replayed", toolName: "aggregate", input: { groupBy: "caseStatus" } }],
      },
      { role: "tool_result", content: '{"total":3}', toolCallId: "toolu_replayed", toolName: "aggregate" },
      { role: "assistant", content: "Three." },
      { role: "user", content: "and now?" },
    ];

    expectEveryToolResultPaired(replayedConversation, 1);
  });
});
