import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentMessage,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmProviderConfig,
} from "./types";

/** The slice of the SDK this adapter uses, so a test can supply a fake. */
export interface AnthropicMessagesClient {
  messages: { create(request: Record<string, unknown>): Promise<AnthropicRawResponse> };
}

export interface AnthropicRawResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: string; [key: string]: unknown }
  >;
  // The real SDK types this `number | null`: the field is never *absent*, it
  // is `null` on a cache miss. `?? 0` below coalesces both, so this was
  // harmless, but `?: number` claimed a shape the vendor does not send.
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
}

export interface AnthropicAdapterOptions {
  /** Omitted by default. See the plan's note on API drift: sending a thinking
   * block a model does not accept is a 400 on every single request. */
  thinkingMode?: "adaptive";
  maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * The Anthropic Messages API has no native "structured output" mode the way
 * Gemini does. A single forced tool call is the idiomatic substitute: the
 * model is required to answer by calling this tool, whose input schema is
 * the caller's `responseSchema`, and the tool's `input` becomes the reply.
 */
const FORCED_RESPONSE_TOOL_NAME = "respond";

export function mapMessagesToAnthropic(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool_result") {
      if (message.toolCallId === undefined) {
        throw new Error("a tool_result message needs a toolCallId to attribute it to its call");
      }
      return {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

export interface MapAnthropicResponseOptions {
  /**
   * Set when the request forced a single response tool (see
   * FORCED_RESPONSE_TOOL_NAME above). When the matching tool_use block is
   * found, its `input` becomes `text` (JSON-stringified) instead of a normal
   * tool call, so callers of `complete()` never see the mechanism -- they
   * just get the JSON document they asked for via `responseSchema`.
   */
  forcedResponseToolName?: string;
}

export function mapAnthropicResponse(
  response: AnthropicRawResponse,
  options: MapAnthropicResponseOptions = {},
): LlmCompletionResponse {
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    // Absent on responses with no cache hit. `?? 0` rather than arithmetic on
    // undefined, which yields NaN and poisons every cost figure downstream.
    cachedTokens: response.usage.cache_read_input_tokens ?? 0,
  };

  if (options.forcedResponseToolName !== undefined) {
    const forcedResponseBlock = response.content.find(
      (contentBlock) =>
        contentBlock.type === "tool_use" &&
        (contentBlock as { name?: unknown }).name === options.forcedResponseToolName,
    ) as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | undefined;

    if (forcedResponseBlock !== undefined) {
      return { text: JSON.stringify(forcedResponseBlock.input), toolCalls: [], usage };
    }
  }

  const textParts: string[] = [];
  const toolCalls: LlmCompletionResponse["toolCalls"] = [];

  for (const contentBlock of response.content) {
    if (contentBlock.type === "text" && typeof contentBlock.text === "string") {
      textParts.push(contentBlock.text);
    }
    if (contentBlock.type === "tool_use") {
      const toolUseBlock = contentBlock as { id: string; name: string; input: Record<string, unknown> };
      toolCalls.push({
        toolCallId: toolUseBlock.id,
        toolName: toolUseBlock.name,
        input: toolUseBlock.input,
      });
    }
  }

  return { text: textParts.join(""), toolCalls, usage };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: AnthropicMessagesClient;
  /**
   * Ruling P7: read only from the constructor's options, never from
   * `providerConfig`, and exposed publicly so the env -> config -> factory ->
   * adapter wiring is observable end to end from outside the class.
   */
  readonly thinkingMode: "adaptive" | undefined;

  constructor(
    private readonly providerConfig: LlmProviderConfig,
    injectedClient?: AnthropicMessagesClient,
    private readonly options: AnthropicAdapterOptions = {},
  ) {
    // `as unknown as AnthropicMessagesClient` bypasses tsc for this
    // construction: a future @anthropic-ai/sdk upgrade that changes
    // `messages.create`'s shape will not fail the build here. Re-check
    // AnthropicMessagesClient and AnthropicRawResponse by hand against the
    // installed SDK types when bumping this dependency.
    this.client =
      injectedClient ?? (new Anthropic({ apiKey: providerConfig.apiKey }) as unknown as AnthropicMessagesClient);
    this.thinkingMode = options.thinkingMode;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Ruling P9: when `responseSchema` is set, `text` on the returned
    // LlmCompletionResponse is a JSON document conforming to that schema and
    // `toolCalls` is empty -- both providers honour the field uniformly. A
    // forced tool choice and the caller's own tools are a contradiction, so
    // a request that sets both is a caller bug, refused before any network
    // call is made.
    if (request.responseSchema !== undefined && request.tools.length > 0) {
      throw new Error(
        "AnthropicLlmProvider.complete: a request cannot set both responseSchema and a " +
          "non-empty tools array -- forcing the response tool would contradict the caller's own tools",
      );
    }

    const forcedResponseToolName =
      request.responseSchema !== undefined ? FORCED_RESPONSE_TOOL_NAME : undefined;

    const rawResponse = await this.client.messages.create({
      model: this.providerConfig.model,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      system: request.system,
      messages: mapMessagesToAnthropic(request.messages),
      ...(forcedResponseToolName !== undefined
        ? {
            tools: [
              {
                name: forcedResponseToolName,
                description: "Return the structured reply.",
                input_schema: request.responseSchema,
              },
            ],
            tool_choice: { type: "tool", name: forcedResponseToolName },
          }
        : request.tools.length > 0
          ? {
              tools: request.tools.map((toolDefinition) => ({
                name: toolDefinition.name,
                description: toolDefinition.description,
                input_schema: toolDefinition.inputSchema,
              })),
            }
          : {}),
      ...(this.thinkingMode === "adaptive" ? { thinking: { type: "adaptive" } } : {}),
    });

    return mapAnthropicResponse(rawResponse, { forcedResponseToolName });
  }
}
