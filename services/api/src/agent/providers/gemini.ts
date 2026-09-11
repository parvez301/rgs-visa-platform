import { GoogleGenAI } from "@google/genai";
import type {
  AgentMessage,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmProviderConfig,
} from "./types";

/** The slice of the SDK this adapter uses, so a test can supply a fake. */
export interface GeminiModelsClient {
  models: { generateContent(request: Record<string, unknown>): Promise<GeminiRawResponse> };
}

export interface GeminiRawResponse {
  candidates?: Array<{
    content?: {
      // The real SDK (@google/genai@2.21.0, dist/genai.d.ts:5210-5220) makes both
      // `name` and `args` optional and adds an optional vendor `id` -- the
      // mechanism the SDK itself uses to disambiguate repeated calls to one
      // tool within a turn. Widened here to match reality instead of assuming
      // fields the vendor does not guarantee.
      parts?: Array<{
        text?: string;
        functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

/**
 * The provider-agnostic transcript, in the shape generateContent requires --
 * the Gemini twin of `mapMessagesToAnthropic`, enforcing the same two rules
 * for the same reasons (branch review C1 and M3): a model turn that made tool
 * calls carries a `functionCall` part per call, and every `functionResponse`
 * answering one model turn sits in a single user turn rather than spread
 * across consecutive ones.
 */
export function mapMessagesToGemini(messages: AgentMessage[]): Record<string, unknown>[] {
  const mappedContents: Record<string, unknown>[] = [];
  let pendingFunctionResponseParts: Record<string, unknown>[] = [];

  function flushPendingFunctionResponses(): void {
    if (pendingFunctionResponseParts.length === 0) return;
    mappedContents.push({ role: "user", parts: pendingFunctionResponseParts });
    pendingFunctionResponseParts = [];
  }

  for (const message of messages) {
    if (message.role === "tool_result") {
      if (message.toolCallId === undefined) {
        throw new Error("a tool_result message needs a toolCallId to attribute it to its call");
      }
      if (message.toolName === undefined) {
        throw new Error("a tool_result message needs a toolName to attribute it to its call");
      }
      // Gemini attributes a functionResponse by TOOL NAME, not by call id --
      // unlike Anthropic, which attributes by tool_use_id alone. Building this
      // from toolCallId (as Anthropic's adapter does) would send Gemini a
      // synthesised id like "get_case-0" where it requires the declared
      // function name "get_case"; toolName is the field the seam carries for
      // exactly this.
      pendingFunctionResponseParts.push({
        functionResponse: { name: message.toolName, response: { result: message.content } },
      });
      continue;
    }

    flushPendingFunctionResponses();

    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      mappedContents.push({
        role: "model",
        parts: [
          ...(message.content !== "" ? [{ text: message.content }] : []),
          // NAME AND ARGS ONLY, deliberately no `id`: the functionResponse
          // half above is name-attributed (see its comment), and
          // mapGeminiResponse SYNTHESISES an id ("get_case-0") whenever the
          // vendor omits one -- echoing a synthesised id back to the vendor
          // as though it had issued it is a claim we cannot support. The
          // known cost of name-only attribution, on both halves, is that two
          // calls to the SAME tool in one turn are indistinguishable to
          // Gemini; that is a pre-existing property of the response mapping,
          // not something introduced here, and closing it needs the vendor id
          // carried through both halves together.
          ...message.toolCalls.map((toolCall) => ({
            functionCall: { name: toolCall.toolName, args: toolCall.input },
          })),
        ],
      });
      continue;
    }

    mappedContents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    });
  }

  flushPendingFunctionResponses();
  return mappedContents;
}

export function mapGeminiResponse(response: GeminiRawResponse): LlmCompletionResponse {
  const firstCandidate = response.candidates?.[0];
  const responseParts = firstCandidate?.content?.parts ?? [];

  const textParts: string[] = [];
  const toolCalls: LlmCompletionResponse["toolCalls"] = [];

  responseParts.forEach((responsePart) => {
    if (typeof responsePart.text === "string") {
      textParts.push(responsePart.text);
    }
    if (responsePart.functionCall !== undefined) {
      // `name` is optional on the vendor type (see GeminiRawResponse above); a
      // functionCall with no usable name cannot become a ToolCall (toolName is
      // required there), so it is skipped rather than emitted as a nameless
      // call the loop could never dispatch.
      const functionName = responsePart.functionCall.name;
      if (functionName === undefined || functionName === "") {
        return;
      }
      // Prefer the vendor's own id -- its mechanism for disambiguating
      // repeated calls to one tool in a turn -- and fall back to a positional
      // id (among tool calls, not among all parts, so it does not shift when a
      // text part is interleaved before it) only when Gemini omits one.
      const toolCallPosition = toolCalls.length;
      toolCalls.push({
        toolCallId: responsePart.functionCall.id ?? `${functionName}-${toolCallPosition}`,
        toolName: functionName,
        input: responsePart.functionCall.args ?? {},
      });
    }
  });

  return {
    text: textParts.join(""),
    toolCalls,
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      cachedTokens: response.usageMetadata?.cachedContentTokenCount ?? 0,
    },
  };
}

export class GeminiLlmProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly client: GeminiModelsClient;

  constructor(
    private readonly providerConfig: LlmProviderConfig,
    injectedClient?: GeminiModelsClient,
  ) {
    // `as unknown as GeminiModelsClient` bypasses tsc for this construction: a
    // future @google/genai upgrade that changes `models.generateContent`'s
    // shape will not fail the build here. Re-check GeminiModelsClient and
    // GeminiRawResponse by hand against the installed SDK types when bumping
    // this dependency.
    this.client =
      injectedClient ??
      (new GoogleGenAI({ apiKey: providerConfig.apiKey }) as unknown as GeminiModelsClient);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    // Ruling P9 (see anthropic.ts for the sibling mechanism): when
    // responseSchema is set, text on the returned LlmCompletionResponse is a
    // JSON document conforming to that schema and toolCalls is empty. Gemini
    // honours this natively via responseMimeType + responseSchema -- no
    // forced-tool trick needed -- but the observable contract is the same one
    // Task 2 implemented on the Anthropic side. Unlike Anthropic's forced-tool
    // mechanism, nothing here otherwise stops a caller-supplied tools array
    // from riding along, so the combination must be refused explicitly.
    if (request.responseSchema !== undefined && request.tools.length > 0) {
      throw new Error(
        "GeminiLlmProvider.complete: a request cannot set both responseSchema and a " +
          "non-empty tools array -- responseSchema promises an empty toolCalls " +
          "contract that a caller-supplied tools array would break",
      );
    }

    const rawResponse = await this.client.models.generateContent({
      model: this.providerConfig.model,
      contents: mapMessagesToGemini(request.messages),
      config: {
        systemInstruction: request.system,
        ...(request.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((toolDefinition) => ({
                    name: toolDefinition.name,
                    description: toolDefinition.description,
                    parameters: toolDefinition.inputSchema,
                  })),
                },
              ],
            }
          : {}),
        ...(request.responseSchema !== undefined
          ? { responseMimeType: "application/json", responseSchema: request.responseSchema }
          : {}),
      },
    });

    return mapGeminiResponse(rawResponse);
  }
}
