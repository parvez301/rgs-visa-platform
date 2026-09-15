/**
 * The panel's replayed conversation, in exactly the shape
 * POST /api/v1/admin/crm/agent/turn validates (agentApi.ts's AgentMessageBody
 * and RunTurnBody).
 *
 * The shape is deliberately narrow: user text turns and assistant text turns,
 * and nothing else. The route's pairing rules are strict for a reason -- a
 * tool_result whose toolCallId was not on the immediately preceding assistant
 * message is refused, and both real providers refuse the same thing -- and the
 * turn response gives the panel `toolCallsMade: { toolName, kind }[]` with NO
 * call ids and NO results. There is therefore nothing the panel could pair
 * correctly, so it pairs nothing. What the agent did with its tools is shown
 * from `toolCallsMade` as a rendered footnote, never replayed as transcript.
 *
 * This module imports NOTHING (R60): not `crmClient.ts`, not React, not the
 * DOM. It is put into the admin `tsc` program alongside API source by its own
 * cross-package test, and it is the module the fallback layout would have
 * moved that test to -- both of which only work while it stays free-standing.
 * The slice of the turn response it needs is declared here, structurally,
 * rather than imported.
 */

/** Mirrors AgentMessage (services/api/src/agent/providers/types.ts) exactly. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolCalls?: { toolCallId: string; toolName: string; input: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
}

/**
 * The part of `AgentTurnResponse` this module reads, declared structurally so
 * nothing here depends on the client that fetches it (R60). `AgentPanel`
 * passes the real response in; it satisfies this by construction.
 */
export interface AgentTurnSlice {
  reply: string;
  stoppedAtIterationCap: boolean;
  toolCallsMade: { toolName: string; kind: "read" | "write" }[];
}

export const MAX_REPLAY_CHARACTERS = 100_000;
export const MAX_REPLAY_MESSAGES = 200;

/**
 * The loop's own cap on how many rounds of tool calls one turn may take
 * (`MAX_TOOL_ITERATIONS`, services/api/src/agent/loop.ts).
 *
 * Hard-coded rather than imported (R59): the turn response does not carry the
 * cap, and the admin bundle must not pull the API in at runtime. What keeps
 * this honest is `transcript.test.ts`, which imports the API's constant
 * through the test-only dev dependency and asserts the two are equal -- so a
 * change to the loop's cap reddens here rather than quietly leaving the panel
 * telling a desk agent the wrong number.
 */
export const MAX_TOOL_ITERATIONS = 8;

/**
 * What the panel says when `stoppedAtIterationCap` is true.
 *
 * Both loop exits return the last completion's text, and for a tool-calling
 * turn that is `""` -- so without this sentence a user who hit the cap gets a
 * blank reply indistinguishable from a model with nothing to say.
 */
export function describeIterationCap(): string {
  return `The agent stopped after ${MAX_TOOL_ITERATIONS} rounds of tool calls and may not have finished.`;
}

/** The route's own cost function, mirrored so trimming targets the same number. */
export function transcriptCost(transcript: TranscriptMessage[]): number {
  return transcript.reduce((runningTotal, message) => {
    const toolCallsLength = (message.toolCalls ?? []).reduce(
      (callTotal, toolCall) =>
        callTotal + toolCall.toolCallId.length + toolCall.toolName.length + JSON.stringify(toolCall.input).length,
      0,
    );
    return runningTotal + message.content.length + toolCallsLength + (message.toolCallId?.length ?? 0);
  }, 0);
}

/**
 * The pending user turn, for RENDERING only.
 *
 * The request sends `userMessage` separately from `conversation`, so the
 * message a user has just typed must never be in the array sent with it -- a
 * panel that put it in both would replay it to the model twice. This is what
 * keeps it on screen while its answer is in flight; `appendTurnResult` is what
 * puts it into the replayed history, once, when the answer arrives.
 */
export function appendUserTurn(
  transcript: TranscriptMessage[],
  userMessage: string,
): TranscriptMessage[] {
  return [...transcript, { role: "user", content: userMessage }];
}

export function appendTurnResult(
  transcript: TranscriptMessage[],
  userMessage: string,
  result: AgentTurnSlice,
): TranscriptMessage[] {
  const withUserTurn: TranscriptMessage[] = [...transcript, { role: "user", content: userMessage }];
  // An assistant turn with neither text nor calls is refused by the route and
  // by both vendors. A capped turn returns reply: "" -- so there is genuinely
  // no assistant turn to record, and recording one would be a 400 on the next
  // message. The cap itself is surfaced in the UI from stoppedAtIterationCap.
  if (result.reply.trim() === "") return trimTranscriptToBudget(withUserTurn);
  return trimTranscriptToBudget([...withUserTurn, { role: "assistant", content: result.reply }]);
}

/**
 * Drops whole exchanges from the OLD end until the replay fits both caps.
 *
 * Whole exchanges, never a half: dropping an assistant turn and keeping the
 * user turn that prompted it leaves the model answering a question whose
 * answer it can no longer see, and dropping a user turn while keeping its
 * answer is worse.
 */
export function trimTranscriptToBudget(transcript: TranscriptMessage[]): TranscriptMessage[] {
  let trimmed = [...transcript];
  while (
    (transcriptCost(trimmed) > MAX_REPLAY_CHARACTERS || trimmed.length > MAX_REPLAY_MESSAGES) &&
    trimmed.length > 1
  ) {
    const dropCount = trimmed[1]?.role === "assistant" ? 2 : 1;
    trimmed = trimmed.slice(dropCount);
  }
  return trimmed;
}
