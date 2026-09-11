import { describe, expect, it } from "vitest";
import {
  AnthropicLlmProvider,
  mapAnthropicResponse,
  mapMessagesToAnthropic,
} from "../../src/agent/providers/anthropic";

describe("mapMessagesToAnthropic", () => {
  it("turns a tool_result message into a tool_result content block, not a user string", () => {
    const mapped = mapMessagesToAnthropic([
      { role: "user", content: "where is case c1" },
      { role: "assistant", content: "checking" },
      { role: "tool_result", content: '{"caseId":"c1"}', toolCallId: "call-1" },
    ]);
    expect(mapped[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: '{"caseId":"c1"}' }],
    });
  });

  it("refuses a tool_result with no toolCallId rather than sending an unattributable block", () => {
    expect(() => mapMessagesToAnthropic([{ role: "tool_result", content: "{}" }])).toThrow(
      /toolCallId/,
    );
  });
});

describe("mapAnthropicResponse", () => {
  it("separates text blocks from tool_use blocks and carries usage across", () => {
    const mapped = mapAnthropicResponse({
      content: [
        { type: "text", text: "Looking that up." },
        { type: "tool_use", id: "call-9", name: "get_case", input: { caseId: "c1" } },
      ],
      usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100 },
    });
    expect(mapped.text).toBe("Looking that up.");
    expect(mapped.toolCalls).toEqual([
      { toolCallId: "call-9", toolName: "get_case", input: { caseId: "c1" } },
    ]);
    expect(mapped.usage).toEqual({ inputTokens: 120, outputTokens: 8, cachedTokens: 100 });
  });

  it("reports zero cached tokens when the field is absent, never NaN", () => {
    const mapped = mapAnthropicResponse({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    expect(mapped.usage.cachedTokens).toBe(0);
  });
});

describe("AnthropicLlmProvider", () => {
  it("sends the configured model and NO thinking block by default", async () => {
    const capturedRequests: Record<string, unknown>[] = [];
    const provider = new AnthropicLlmProvider(
      { providerName: "anthropic", model: "claude-opus-5", apiKey: "k" },
      {
        messages: {
          create: async (request: Record<string, unknown>) => {
            capturedRequests.push(request);
            return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    );

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(capturedRequests[0]?.model).toBe("claude-opus-5");
    expect(capturedRequests[0]).not.toHaveProperty("thinking");
  });

  it("sends adaptive thinking only when the environment asks for it", async () => {
    const capturedRequests: Record<string, unknown>[] = [];
    const provider = new AnthropicLlmProvider(
      { providerName: "anthropic", model: "claude-opus-5", apiKey: "k" },
      {
        messages: {
          create: async (request: Record<string, unknown>) => {
            capturedRequests.push(request);
            return { content: [], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
      { thinkingMode: "adaptive" },
    );

    await provider.complete({ system: "s", messages: [], tools: [] });
    expect(capturedRequests[0]?.thinking).toEqual({ type: "adaptive" });
  });

  it("never lets the API key reach a thrown error's message or stack", async () => {
    const distinctiveApiKeySentinel = "sk-sentinel-do-not-leak-4f9c2a";
    const provider = new AnthropicLlmProvider(
      { providerName: "anthropic", model: "claude-opus-5", apiKey: distinctiveApiKeySentinel },
      {
        messages: {
          create: async () => {
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

  it("forces a single response tool and returns its input as JSON text when responseSchema is set", async () => {
    const capturedRequests: Record<string, unknown>[] = [];
    const caseStatusSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
    };
    const provider = new AnthropicLlmProvider(
      { providerName: "anthropic", model: "claude-opus-5", apiKey: "k" },
      {
        messages: {
          create: async (request: Record<string, unknown>) => {
            capturedRequests.push(request);
            return {
              content: [{ type: "tool_use", id: "call-1", name: "respond", input: { status: "with RGS" } }],
              usage: { input_tokens: 10, output_tokens: 4 },
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

    expect(capturedRequests[0]?.tool_choice).toEqual({ type: "tool", name: "respond" });
    expect(capturedRequests[0]?.tools).toEqual([
      { name: "respond", description: "Return the structured reply.", input_schema: caseStatusSchema },
    ]);
    expect(JSON.parse(response.text)).toEqual({ status: "with RGS" });
    expect(response.toolCalls).toEqual([]);
  });

  it("refuses a request that sets both responseSchema and tools", async () => {
    const provider = new AnthropicLlmProvider(
      { providerName: "anthropic", model: "claude-opus-5", apiKey: "k" },
      {
        messages: {
          create: async () => {
            throw new Error("should not be called");
          },
        },
      },
    );

    await expect(
      provider.complete({
        system: "s",
        messages: [],
        tools: [{ name: "get_case", description: "d", inputSchema: {} }],
        responseSchema: { type: "object" },
      }),
    ).rejects.toThrow(/responseSchema.*tools|tools.*responseSchema/s);
  });
});
