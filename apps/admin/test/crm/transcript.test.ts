import { describe, expect, it } from "vitest";
import { RunTurnBody } from "@rgs/api/src/http/agentApi";
import { MAX_TOOL_ITERATIONS as ROUTE_MAX_TOOL_ITERATIONS } from "@rgs/api/src/agent/loop";
import { registerAgentRoutes } from "@rgs/api/src/http/agentApi";
import { Router } from "@rgs/api/src/http/router";
import { buildTestContext } from "@rgs/api/test/helpers";
import type { AppContext } from "@rgs/api/src/lib/context";
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "@rgs/api/src/agent/providers/types";
import {
  MAX_TOOL_ITERATIONS,
  appendTurnResult,
  appendUserTurn,
  describeIterationCap,
  transcriptCost,
  trimTranscriptToBudget,
  type TranscriptMessage,
} from "../../src/crm/agent/transcript";

function buildTurnResult(reply: string) {
  return {
    reply,
    proposals: [],
    appliedChanges: [],
    toolCallsMade: [{ toolName: "get_case", kind: "read" as const }],
    stoppedAtIterationCap: false,
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
  };
}

/** The route's own validator, not a restatement of its rules. */
function assertRouteAccepts(conversation: TranscriptMessage[], userMessage = "and then?"): void {
  expect(() => RunTurnBody.parse({ userMessage, conversation })).not.toThrow();
}

describe("the panel's transcript satisfies the turn route", () => {
  it("is accepted after one exchange", () => {
    let transcript: TranscriptMessage[] = [];
    transcript = appendTurnResult(transcript, "how many cases are open?", buildTurnResult("412 are open."));

    assertRouteAccepts(transcript);
    expect(transcript).toEqual([
      { role: "user", content: "how many cases are open?" },
      { role: "assistant", content: "412 are open." },
    ]);
  });

  it("is accepted after five exchanges, including turns that called tools", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 5; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, `question ${exchangeIndex}`, buildTurnResult(`answer ${exchangeIndex}`));
    }

    assertRouteAccepts(transcript);
  });

  it("never synthesises a tool_result, because it has no call id to pair one with", () => {
    // toolCallsMade carries { toolName, kind } and NOTHING else -- no call id,
    // no result. A panel that invented a toolCallId to look complete
    // reproduces branch-review defect C1 from the client side: a tool_result
    // answering a call that was never transmitted, which both providers
    // refuse. This is the test that stops that "improvement".
    const transcript = appendTurnResult([], "do something", buildTurnResult("done"));

    expect(transcript.some((message) => message.role === "tool_result")).toBe(false);
    expect(transcript.some((message) => message.toolCalls !== undefined)).toBe(false);
  });

  it("never appends an assistant turn with neither text nor calls", () => {
    // An iteration-capped turn returns reply: "". An empty assistant message
    // maps to an empty content block, which both vendors refuse -- and the
    // route refuses it first, as a 400 naming `conversation`.
    const transcript = appendTurnResult([], "do something", buildTurnResult(""));

    expect(transcript.filter((message) => message.role === "assistant")).toHaveLength(0);
    assertRouteAccepts(transcript);
  });

  it("keeps the replay inside the route's 100,000-character budget", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 60; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, "x".repeat(4_000), buildTurnResult("y".repeat(4_000)));
    }

    const trimmed = trimTranscriptToBudget(transcript);

    expect(transcriptCost(trimmed)).toBeLessThanOrEqual(100_000);
    assertRouteAccepts(trimmed);
    // Trimmed from the OLD end: the recent exchange is the context the next
    // turn needs, and dropping it to keep the greeting is backwards.
    expect(trimmed.at(-1)).toEqual(transcript.at(-1));
  });

  it("keeps the replay inside the 200-message cap", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 150; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, "hi", buildTurnResult("hello"));
    }

    const trimmed = trimTranscriptToBudget(transcript);

    expect(trimmed.length).toBeLessThanOrEqual(200);
    assertRouteAccepts(trimmed);
  });

  it("keeps a user turn on screen while its answer is in flight, without sending it twice", () => {
    // appendUserTurn is for rendering. The request sends `userMessage`
    // separately from `conversation`, and a panel that put the pending turn
    // in BOTH would replay it to the model twice.
    const forDisplay = appendUserTurn([], "how many?");
    expect(forDisplay).toHaveLength(1);
    assertRouteAccepts([], "how many?");
  });
});

describe("the iteration-cap sentence", () => {
  /**
   * R59. The response does not carry the cap, and the admin bundle must not
   * import the API at runtime -- so the number in the panel's copy is a
   * hard-coded 8 in `transcript.ts`, and this is what stops it going stale
   * the day someone changes `MAX_TOOL_ITERATIONS` in the loop.
   */
  it("names the same number of rounds the loop actually stops at", () => {
    expect(MAX_TOOL_ITERATIONS).toBe(ROUTE_MAX_TOOL_ITERATIONS);
    expect(describeIterationCap()).toContain(`${ROUTE_MAX_TOOL_ITERATIONS} rounds`);
  });
});

describe("the transcript survives a real turn through the real route", () => {
  it("is accepted by the router, not just by the schema", async () => {
    // The schema is the contract; the router is where the contract is
    // enforced in production. Driving the panel's transcript through
    // registerAgentRoutes with a scripted provider is what makes this test
    // about the system rather than about a zod object.
    const { router } = buildAgentRouterForTest();
    let transcript: TranscriptMessage[] = [];

    const firstResponse = await dispatch(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "how many cases are open?",
      conversation: transcript,
    });
    expect(firstResponse.statusCode).toBe(200);
    transcript = appendTurnResult(transcript, "how many cases are open?", firstResponse.payload);

    const secondResponse = await dispatch(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "and how many are overdue?",
      conversation: transcript,
    });

    expect(secondResponse.statusCode).toBe(200);
  });
});

/**
 * The event shape `services/api/test/crm/crmApi.test.ts` builds, minus its
 * `aws-lambda` type import: `@types/aws-lambda` is a devDependency of
 * `services/api`, not of this app, so the type is taken off `Router.dispatch`
 * itself rather than named directly.
 */
type LambdaEvent = Parameters<Router["dispatch"]>[0];

function buildEvent(method: string, path: string, body?: unknown): LambdaEvent {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      // The turn route answers 403 for an admin token with no email claim --
      // `decidedBy`/`proposedBy` are audit fields and it refuses to write a
      // blank one -- and for one with no `cognito:groups`, which resolves to
      // no admin role at all.
      authorizer: {
        jwt: {
          claims: { sub: "admin_1", email: "ops@rgs.test", "cognito:groups": "[Owner]" },
        },
      },
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as LambdaEvent;
}

async function dispatch(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEvent(method, path, body))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

/**
 * A scripted provider that CALLS A TOOL on the first completion of every turn
 * and answers in text on the second.
 *
 * Deliberately not a pure text stub. A turn that never calls a tool comes back
 * with `toolCallsMade: []`, and a client mutation that synthesises tool
 * messages "from toolCallsMade" would then synthesise nothing -- so this test
 * would stay green through exactly the defect it exists to catch (the brief's
 * Step 7 red-proof). `list_partners` is the read tool with an empty input
 * schema, so it needs no fixture to succeed against an empty table.
 */
function buildScriptedLlm(): LlmProvider {
  let completionsServed = 0;
  return {
    name: "scripted",
    async complete(_request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      completionsServed += 1;
      const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
      if (completionsServed % 2 === 1) {
        return {
          text: "",
          toolCalls: [
            { toolCallId: `call_${completionsServed}`, toolName: "list_partners", input: {} },
          ],
          usage,
        };
      }
      return { text: "412 are open.", toolCalls: [], usage };
    },
  };
}

function buildAgentRouterForTest(): { router: Router; context: AppContext } {
  const context: AppContext = { ...buildTestContext(), llm: buildScriptedLlm() };
  return { router: registerAgentRoutes(new Router(), context), context };
}
