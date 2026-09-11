import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "./types";

export interface ScriptedTurn {
  text: string;
  toolCalls: LlmCompletionResponse["toolCalls"];
  usage?: LlmCompletionResponse["usage"];
}

/**
 * Every test in this plan that needs a model uses this. No test may call a real
 * provider: a suite that costs money and needs a network is a suite nobody runs.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly receivedRequests: LlmCompletionRequest[] = [];
  private nextTurnIndex = 0;

  constructor(private readonly scriptedTurns: ScriptedTurn[]) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Snapshot, not a reference to the caller's own array (task-10-fix-1
    // A2 / review Probe 3): a caller that reuses one `messages` array
    // across iterations -- exactly what runAgentTurn does -- would
    // otherwise leave every entry in `receivedRequests` pointing at the
    // SAME array, so `receivedRequests[0].messages` and
    // `receivedRequests[1].messages` both show the final state regardless
    // of what was actually sent on each call. A test reading
    // `receivedRequests[n].messages` is meant to prove what the model saw
    // ON THAT CALL; without this copy it can only prove what the array
    // looked like by the time the whole turn finished.
    this.receivedRequests.push({ ...request, messages: [...request.messages] });
    const scriptedTurn = this.scriptedTurns[this.nextTurnIndex];
    if (scriptedTurn === undefined) {
      throw new Error(
        `FakeLlmProvider ran out of scripted turns: the loop asked for turn ${this.nextTurnIndex + 1} of ${this.scriptedTurns.length}`,
      );
    }
    this.nextTurnIndex += 1;
    return {
      text: scriptedTurn.text,
      toolCalls: scriptedTurn.toolCalls,
      usage: scriptedTurn.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    };
  }
}
