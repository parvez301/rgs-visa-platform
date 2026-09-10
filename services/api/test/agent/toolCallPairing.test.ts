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
  scriptedTurns: ScriptedTurn[],
  requestIndex: number,
  seedCaseRef: string,
): Promise<{ messages: AgentMessage[]; caseId: string }> {
  const context = buildTestContext();
  const seededCase = await seedOneCase(context, seedCaseRef);
  const contextWithLlm = Object.assign(context, { llm: new FakeLlmProvider(scriptedTurns) });

  await runAgentTurn(contextWithLlm, TENANT_ID, {
    userMessage: "how is that case doing?",
    conversation: [],
    actorEmail: ACTOR,
  });

  const sentMessages = contextWithLlm.llm.receivedRequests[requestIndex]?.messages;
  expect(sentMessages, `the loop never made model call #${requestIndex + 1}`).toBeDefined();
  return { messages: sentMessages!, caseId: seededCase.caseId };
}

type AnthropicBlock = { type?: string; id?: string; tool_use_id?: string; [key: string]: unknown };
type AnthropicMessage = { role?: string; content?: unknown };
type GeminiPart = {
  text?: string;
  functionCall?: { name?: string };
  functionResponse?: { name?: string };
};
type GeminiContent = { role?: string; parts?: unknown };

function anthropicBlocks(message: AnthropicMessage): AnthropicBlock[] {
  return Array.isArray(message.content) ? (message.content as AnthropicBlock[]) : [];
}

function geminiParts(content: GeminiContent): GeminiPart[] {
  return Array.isArray(content.parts) ? (content.parts as GeminiPart[]) : [];
}

/**
 * Every way the Anthropic Messages API can refuse a transcript for pairing
 * reasons, collected rather than thrown one at a time, so a failure names all
 * of them at once instead of one per re-run.
 */
function anthropicPairingViolations(mappedMessages: AnthropicMessage[]): string[] {
  const violations: string[] = [];
  let previousWasToolResultMessage = false;

  mappedMessages.forEach((message, messageIndex) => {
    const toolResultBlocks = anthropicBlocks(message).filter((block) => block.type === "tool_result");
    if (toolResultBlocks.length === 0) {
      previousWasToolResultMessage = false;
      return;
    }

    if (message.role !== "user") {
      violations.push(`message ${messageIndex}: tool_result blocks must sit on a user message, not "${message.role}"`);
    }
    if (previousWasToolResultMessage) {
      violations.push(
        `message ${messageIndex}: two consecutive user messages both carry tool_result blocks -- ` +
          "all results answering one assistant turn must be batched into a single message",
      );
    }
    previousWasToolResultMessage = true;

    const precedingMessage = mappedMessages[messageIndex - 1];
    if (precedingMessage === undefined || precedingMessage.role !== "assistant") {
      violations.push(
        `message ${messageIndex}: tool_result blocks must immediately follow an assistant message, ` +
          `but the preceding message is ${precedingMessage === undefined ? "nothing" : `"${precedingMessage.role}"`}`,
      );
      return;
    }

    const transmittedToolUseIds = new Set(
      anthropicBlocks(precedingMessage)
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id),
    );
    for (const toolResultBlock of toolResultBlocks) {
      if (!transmittedToolUseIds.has(toolResultBlock.tool_use_id as string)) {
        violations.push(
          `message ${messageIndex}: tool_result names tool_use_id "${String(toolResultBlock.tool_use_id)}", ` +
            `which no tool_use block in the preceding assistant message carries ` +
            `(it carries: ${[...transmittedToolUseIds].map(String).join(", ") || "none"})`,
        );
      }
    }
  });

  return violations;
}

/** The Gemini twin: functionResponse parts, paired by function NAME. */
function geminiPairingViolations(mappedContents: GeminiContent[]): string[] {
  const violations: string[] = [];
  let previousWasFunctionResponseTurn = false;

  mappedContents.forEach((content, contentIndex) => {
    const functionResponseParts = geminiParts(content).filter((part) => part.functionResponse !== undefined);
    if (functionResponseParts.length === 0) {
      previousWasFunctionResponseTurn = false;
      return;
    }

    if (content.role !== "user") {
      violations.push(`content ${contentIndex}: functionResponse parts must sit on a user turn, not "${content.role}"`);
    }
    if (previousWasFunctionResponseTurn) {
      violations.push(
        `content ${contentIndex}: two consecutive user turns both carry functionResponse parts -- ` +
          "all responses answering one model turn must be batched into a single turn",
      );
    }
    previousWasFunctionResponseTurn = true;

    const precedingContent = mappedContents[contentIndex - 1];
    if (precedingContent === undefined || precedingContent.role !== "model") {
      violations.push(
        `content ${contentIndex}: functionResponse parts must immediately follow a model turn, ` +
          `but the preceding turn is ${precedingContent === undefined ? "nothing" : `"${precedingContent.role}"`}`,
      );
      return;
    }

    const transmittedFunctionNames = new Set(
      geminiParts(precedingContent)
        .filter((part) => part.functionCall !== undefined)
        .map((part) => part.functionCall?.name),
    );
    for (const functionResponsePart of functionResponseParts) {
      if (!transmittedFunctionNames.has(functionResponsePart.functionResponse?.name)) {
        violations.push(
          `content ${contentIndex}: functionResponse names "${String(functionResponsePart.functionResponse?.name)}", ` +
            `which no functionCall part in the preceding model turn carries ` +
            `(it carries: ${[...transmittedFunctionNames].map(String).join(", ") || "none"})`,
        );
      }
    }
  });

  return violations;
}

function countAnthropicBlocks(mappedMessages: AnthropicMessage[], blockType: string): number {
  return mappedMessages.reduce(
    (runningTotal, message) =>
      runningTotal + anthropicBlocks(message).filter((block) => block.type === blockType).length,
    0,
  );
}

function countGeminiParts(mappedContents: GeminiContent[], partKey: "functionCall" | "functionResponse"): number {
  return mappedContents.reduce(
    (runningTotal, content) => runningTotal + geminiParts(content).filter((part) => part[partKey] !== undefined).length,
    0,
  );
}

/**
 * The whole invariant, asserted through both real mappers at once, with a
 * floor on how many pairs it saw. The floor is what stops this from passing
 * vacuously: a transcript with no tool_result blocks in it satisfies "every
 * tool_result is paired" trivially, and that is exactly the state a
 * regression in the loop would produce.
 */
function expectEveryToolResultPaired(sentMessages: AgentMessage[], expectedPairCount: number): void {
  const anthropicMessages = mapMessagesToAnthropic(sentMessages) as AnthropicMessage[];
  const geminiContents = mapMessagesToGemini(sentMessages) as GeminiContent[];

  expect(anthropicPairingViolations(anthropicMessages), "Anthropic pairing").toEqual([]);
  expect(geminiPairingViolations(geminiContents), "Gemini pairing").toEqual([]);

  expect(countAnthropicBlocks(anthropicMessages, "tool_result")).toBe(expectedPairCount);
  expect(countAnthropicBlocks(anthropicMessages, "tool_use")).toBe(expectedPairCount);
  expect(countGeminiParts(geminiContents, "functionResponse")).toBe(expectedPairCount);
  expect(countGeminiParts(geminiContents, "functionCall")).toBe(expectedPairCount);
}

describe("the loop -> adapter seam: every tool result reaches the provider paired with its call", () => {
  it("pairs a single tool call with its result, through both real mappers", async () => {
    const { messages, caseId } = await messagesSentOnRequest(
      [
        { text: "", toolCalls: [{ toolCallId: "toolu_01ABC", toolName: "get_case", input: { caseId: "" } }] },
        { text: "It is still NEW.", toolCalls: [] },
      ],
      1,
      "PAIR-01",
    );

    // The scripted call above cannot know the seeded caseId, so the tool
    // errors -- which is deliberate here and irrelevant to the invariant: a
    // tool_result carrying an error message is still a tool_result, and still
    // has to name a call the model actually made.
    expect(caseId).toBeDefined();
    expectEveryToolResultPaired(messages, 1);

    // The concrete shape, spelled out once, so a reader of this file can see
    // what "paired" means without reconstructing it from the walkers above.
    const anthropicMessages = mapMessagesToAnthropic(messages) as AnthropicMessage[];
    const assistantMessage = anthropicMessages.find((message) => message.role === "assistant");
    expect(anthropicBlocks(assistantMessage ?? {})).toContainEqual({
      type: "tool_use",
      id: "toolu_01ABC",
      name: "get_case",
      input: { caseId: "" },
    });
  });

  it("keeps the pairing when the model calls a tool with no text of its own", async () => {
    const { messages } = await messagesSentOnRequest(
      [
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
    const { messages } = await messagesSentOnRequest(
      [
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
    const { messages } = await messagesSentOnRequest(
      [
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
