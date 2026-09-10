import { describe, expect, it } from "vitest";
import {
  GeminiLlmProvider,
  mapGeminiResponse,
  mapMessagesToGemini,
} from "../../src/agent/providers/gemini";

describe("mapMessagesToGemini", () => {
  it("maps assistant to the 'model' role, which is what Gemini calls it", () => {
    const mapped = mapMessagesToGemini([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(mapped[0]).toEqual({ role: "user", parts: [{ text: "hello" }] });
    expect(mapped[1]).toEqual({ role: "model", parts: [{ text: "hi" }] });
  });

  it("maps a tool_result to a functionResponse part", () => {
    const mapped = mapMessagesToGemini([
      { role: "tool_result", content: '{"caseId":"c1"}', toolCallId: "get_case" },
    ]);
    expect(mapped[0]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "get_case", response: { result: '{"caseId":"c1"}' } } }],
    });
  });

  // Matches mapMessagesToAnthropic's equivalent guard/test so the two adapters
  // are covered the same way -- without this, a tool_result could not be
  // attributed to its call.
  it("refuses a tool_result with no toolCallId rather than sending an unattributable block", () => {
    expect(() => mapMessagesToGemini([{ role: "tool_result", content: "{}" }])).toThrow(
      /toolCallId/,
    );
  });
});

describe("mapGeminiResponse", () => {
  it("reads text and functionCall parts, and synthesises a stable tool call id", () => {
    const mapped = mapGeminiResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: "Looking that up." },
              { functionCall: { name: "get_case", args: { caseId: "c1" } } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, cachedContentTokenCount: 100 },
    });
    expect(mapped.text).toBe("Looking that up.");
    expect(mapped.toolCalls[0]?.toolName).toBe("get_case");
    // Gemini does not return an id. We mint one so the loop can attribute the
    // result, and it must be deterministic for a given position.
    expect(mapped.toolCalls[0]?.toolCallId).toBe("get_case-0");
    expect(mapped.usage).toEqual({ inputTokens: 120, outputTokens: 8, cachedTokens: 100 });
  });

  it("returns empty text and no calls when a candidate has no parts, rather than throwing", () => {
    const mapped = mapGeminiResponse({ candidates: [{ content: {} }], usageMetadata: {} });
    expect(mapped.text).toBe("");
    expect(mapped.toolCalls).toEqual([]);
    expect(mapped.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });
});

describe("GeminiLlmProvider", () => {
  it("passes the system prompt as systemInstruction and the model from config", async () => {
    const capturedRequests: Record<string, unknown>[] = [];
    const provider = new GeminiLlmProvider(
      { providerName: "gemini", model: "gemini-2.5-flash", apiKey: "k" },
      {
        models: {
          generateContent: async (request: Record<string, unknown>) => {
            capturedRequests.push(request);
            return { candidates: [], usageMetadata: {} };
          },
        },
      },
    );

    await provider.complete({ system: "you are a CRM assistant", messages: [], tools: [] });

    expect(capturedRequests[0]?.model).toBe("gemini-2.5-flash");
    expect(capturedRequests[0]?.config).toMatchObject({ systemInstruction: "you are a CRM assistant" });
  });

  // Controller notes §2 / ruling P9: responseSchema is a seam-wide contract, not a
  // Gemini nicety. When it is set, text is a JSON document conforming to that
  // schema and toolCalls is empty -- the same observable behaviour Task 2 pinned
  // on the Anthropic adapter via its forced-tool mechanism.
  it("passes responseSchema through as responseMimeType + responseSchema, and surfaces the JSON text with no tool calls", async () => {
    const capturedRequests: Record<string, unknown>[] = [];
    const caseStatusSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
    };
    const provider = new GeminiLlmProvider(
      { providerName: "gemini", model: "gemini-2.5-flash", apiKey: "k" },
      {
        models: {
          generateContent: async (request: Record<string, unknown>) => {
            capturedRequests.push(request);
            return {
              candidates: [{ content: { parts: [{ text: '{"status":"with RGS"}' }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
            };
          },
        },
      },
    );

    const response = await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "where is case c1" }],
      tools: [],
      responseSchema: caseStatusSchema,
    });

    expect(capturedRequests[0]?.config).toMatchObject({
      responseMimeType: "application/json",
      responseSchema: caseStatusSchema,
    });
    expect(JSON.parse(response.text)).toEqual({ status: "with RGS" });
    expect(response.toolCalls).toEqual([]);
  });

  // Controller notes §3 / attention item carried from the Task 1 review: the
  // API key must never reach a thrown error's message or stack, no matter how
  // many more ways this adapter has to leak one than config.ts did. Matches
  // the shape of the equivalent Anthropic test so both adapters are covered
  // the same way.
  it("never lets the API key reach a thrown error's message or stack", async () => {
    const distinctiveApiKeySentinel = "sk-sentinel-do-not-leak-4f9c2a";
    const provider = new GeminiLlmProvider(
      { providerName: "gemini", model: "gemini-2.5-flash", apiKey: distinctiveApiKeySentinel },
      {
        models: {
          generateContent: async () => {
            throw new Error("upstream rejected the request");
          },
        },
      },
    );

    let thrownError: Error | undefined;
    try {
      await provider.complete({ system: "s", messages: [], tools: [] });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message ?? "").not.toContain(distinctiveApiKeySentinel);
    expect(thrownError?.stack ?? "").not.toContain(distinctiveApiKeySentinel);
  });
});
