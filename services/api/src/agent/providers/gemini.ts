import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmProviderConfig,
} from "./types";

/**
 * Stub for Task 3, which fills in the real Gemini adapter. Deliberately no
 * vendor SDK import here: adding one before the adapter that calls it exists
 * would leave an unused dependency in the lockfile.
 */
export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";

  constructor(
    private readonly providerConfig: LlmProviderConfig,
    private readonly injectedClient?: unknown,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    throw new Error("GeminiLlmProvider is implemented in Task 3");
  }
}
