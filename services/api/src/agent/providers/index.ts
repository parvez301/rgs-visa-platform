import { AnthropicLlmProvider } from "./anthropic";
import { GeminiLlmProvider } from "./gemini";
import type { LlmProvider, LlmProviderConfig } from "./types";

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.providerName) {
    case "anthropic":
      return new AnthropicLlmProvider(config, undefined, { thinkingMode: config.thinkingMode });
    case "gemini":
      return new GeminiLlmProvider(config);
  }
}

export * from "./types";
