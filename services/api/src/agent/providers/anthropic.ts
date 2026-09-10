import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmProviderConfig,
} from "./types";

/**
 * Stub for Task 2, which fills in the real Anthropic adapter. Deliberately no
 * vendor SDK import here: adding one before the adapter that calls it exists
 * would leave an unused dependency in the lockfile.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";

  constructor(
    private readonly providerConfig: LlmProviderConfig,
    private readonly injectedClient?: unknown,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    throw new Error("AnthropicLlmProvider is implemented in Task 2");
  }
}
