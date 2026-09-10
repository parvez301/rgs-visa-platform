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
      parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export function mapMessagesToGemini(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool_result") {
      if (message.toolCallId === undefined) {
        throw new Error("a tool_result message needs a toolCallId to attribute it to its call");
      }
      // Gemini attributes a response by TOOL NAME, not by call id, so the loop
      // stores the name in toolCallId for this provider. Documented here because
      // it is the one place the two vendors disagree about identity.
      return {
        role: "user",
        parts: [
          { functionResponse: { name: message.toolCallId, response: { result: message.content } } },
        ],
      };
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    };
  });
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
      // Gemini returns no call id. We mint one from the tool call's own
      // position among tool calls (not its position among all parts, which
      // would shift the id around whenever a text part is interleaved before
      // it) so the loop can attribute a result deterministically.
      const toolCallPosition = toolCalls.length;
      toolCalls.push({
        toolCallId: `${responsePart.functionCall.name}-${toolCallPosition}`,
        toolName: responsePart.functionCall.name,
        input: responsePart.functionCall.args,
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
    // Task 2 implemented on the Anthropic side.
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
