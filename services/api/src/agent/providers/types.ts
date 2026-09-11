/** One turn in the conversation, provider-agnostic. */
export interface AgentMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  /**
   * Meaningful only on an `assistant` message: the tool calls the model made
   * on that turn.
   *
   * Without this field the transcript could record that a tool RESULT exists
   * but never that the model asked for it (branch review C1): both vendors
   * require a result to be paired with the call it answers -- Anthropic by
   * `tool_use_id` against a `tool_use` block in the immediately preceding
   * assistant message, Gemini by function name against a `functionCall` part
   * in the immediately preceding model turn -- and an unpaired result is an
   * `invalid_request_error`, not a warning. So every turn in which the agent
   * used any tool was malformed on its second model call.
   *
   * The pairing invariant this field exists to make expressible is asserted
   * end to end, through both real adapter mappers, by
   * test/agent/toolCallPairing.test.ts. Anything that changes how the loop
   * builds history has to keep that test green.
   */
  toolCalls?: ToolCall[];
  /** Present only on tool_result messages; ties the result to its call. */
  toolCallId?: string;
  /**
   * Required on a tool_result message; the name of the tool whose result this
   * is. Anthropic ignores it -- it attributes a result to its call via
   * tool_use_id alone -- but Gemini attributes by function name, not by call
   * id, so its adapter needs this field to build a `functionResponse` the
   * vendor can match back to the declared tool.
   */
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema. Produced from the tool's Zod schema by the registry. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface LlmCompletionRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  /** Optional JSON Schema for a structured reply, used by intake. */
  responseSchema?: Record<string, unknown>;
}

export interface LlmCompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
}

/**
 * The whole vendor surface. Provider-specific capabilities -- prompt caching
 * shape, adaptive thinking, effort levels -- stay behind the adapter and
 * degrade to no-ops where the vendor does not support them (spec §7).
 */
export interface LlmProvider {
  name: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export const LLM_PROVIDER_NAMES = ["anthropic", "gemini"] as const;
export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number];

export interface LlmProviderConfig {
  providerName: LlmProviderName;
  model: string;
  apiKey: string;
  fallbackProviderName?: LlmProviderName;
  /**
   * Anthropic-only. Absent by default: a 400 on every request beats a thinking
   * block a model does not accept, and we cannot infer support from a model
   * string alone (spec §7, task-2 ruling P7).
   */
  thinkingMode?: "adaptive";
}
