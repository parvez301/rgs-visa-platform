import { LLM_PROVIDER_NAMES, type LlmProviderConfig, type LlmProviderName } from "./types";

function requireProviderName(rawValue: string | undefined, variableName: string): LlmProviderName {
  // The raw value is echoed back deliberately -- it is a provider name, never a
  // secret -- but nothing else from the environment is, and the API key in
  // particular must never reach a message that gets logged.
  if (rawValue === undefined || rawValue === "") {
    throw new Error(`${variableName} is required and must be one of: ${LLM_PROVIDER_NAMES.join(", ")}`);
  }
  const matchedName = LLM_PROVIDER_NAMES.find((candidate) => candidate === rawValue);
  if (matchedName === undefined) {
    throw new Error(
      `${variableName} must be one of: ${LLM_PROVIDER_NAMES.join(", ")} (received "${rawValue}")`,
    );
  }
  return matchedName;
}

/**
 * Spec §7: the model id is never hardcoded. There is deliberately no default
 * here -- a default model is how a deployment silently runs on something the
 * owner did not choose and did not price.
 */
export function llmProviderConfigFromEnvironment(
  environment: Record<string, string | undefined>,
): LlmProviderConfig {
  const providerName = requireProviderName(environment.LLM_PROVIDER, "LLM_PROVIDER");

  const model = environment.LLM_MODEL;
  if (model === undefined || model === "") {
    throw new Error("LLM_MODEL is required; the model id is never hardcoded");
  }

  const apiKey = environment.LLM_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("LLM_API_KEY is required");
  }

  const rawFallback = environment.LLM_FALLBACK_PROVIDER;
  const fallbackProviderName =
    rawFallback === undefined || rawFallback === ""
      ? undefined
      : requireProviderName(rawFallback, "LLM_FALLBACK_PROVIDER");

  return {
    providerName,
    model,
    apiKey,
    ...(fallbackProviderName !== undefined ? { fallbackProviderName } : {}),
  };
}
