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
    this.receivedRequests.push(request);
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
