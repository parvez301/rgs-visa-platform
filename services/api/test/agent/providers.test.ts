import { describe, expect, it } from "vitest";
import { AnthropicLlmProvider } from "../../src/agent/providers/anthropic";
import {
  llmProviderConfigFromEnvironment,
} from "../../src/agent/providers/config";
import { FakeLlmProvider } from "../../src/agent/providers/fake";
import { createLlmProvider } from "../../src/agent/providers/index";

describe("llmProviderConfigFromEnvironment", () => {
  it("reads provider, model and key from the environment", () => {
    const config = llmProviderConfigFromEnvironment({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-2.5-flash",
      LLM_API_KEY: "key-123",
    });
    expect(config.providerName).toBe("gemini");
    expect(config.model).toBe("gemini-2.5-flash");
    expect(config.apiKey).toBe("key-123");
    expect(config.fallbackProviderName).toBeUndefined();
  });

  it("refuses an unknown provider by name rather than failing later at call time", () => {
    expect(() =>
      llmProviderConfigFromEnvironment({
        LLM_PROVIDER: "oracle",
        LLM_MODEL: "m",
        LLM_API_KEY: "k",
      }),
    ).toThrow(/LLM_PROVIDER/);
  });

  it("refuses a missing model rather than baking a default into the code", () => {
    expect(() =>
      llmProviderConfigFromEnvironment({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "k" }),
    ).toThrow(/LLM_MODEL/);
  });

  it("refuses an empty LLM_PROVIDER before it reads anything else", () => {
    let thrownMessage = "";
    try {
      llmProviderConfigFromEnvironment({ LLM_PROVIDER: "", LLM_API_KEY: "super-secret" });
    } catch (error) {
      thrownMessage = (error as Error).message;
    }
    expect(thrownMessage).not.toContain("super-secret");
  });

  it("does not leak a present api key when a later guard throws", () => {
    let thrownMessage = "";
    try {
      llmProviderConfigFromEnvironment({
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "claude-opus-5",
        LLM_API_KEY: "super-secret-key-value",
        LLM_FALLBACK_PROVIDER: "oracle",
      });
    } catch (error) {
      thrownMessage = (error as Error).message;
    }
    expect(thrownMessage).not.toBe("");
    expect(thrownMessage).not.toContain("super-secret-key-value");
  });

  // Ruling P7 (task 2, link 1 of 3: env -> config).
  it("reads LLM_THINKING into thinkingMode when set to adaptive, and omits the field when absent", () => {
    const configWithThinking = llmProviderConfigFromEnvironment({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5",
      LLM_API_KEY: "k",
      LLM_THINKING: "adaptive",
    });
    expect(configWithThinking.thinkingMode).toBe("adaptive");

    const configWithoutThinking = llmProviderConfigFromEnvironment({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5",
      LLM_API_KEY: "k",
    });
    expect("thinkingMode" in configWithoutThinking).toBe(false);
  });

  it("refuses an LLM_THINKING value other than adaptive, naming the variable and the allowed value", () => {
    expect(() =>
      llmProviderConfigFromEnvironment({
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "claude-opus-5",
        LLM_API_KEY: "k",
        LLM_THINKING: "hard",
      }),
    ).toThrow(/LLM_THINKING.*adaptive/s);
  });
});

describe("FakeLlmProvider", () => {
  it("replays scripted turns in order and records what it was asked", async () => {
    const fakeProvider = new FakeLlmProvider([
      { text: "", toolCalls: [{ toolCallId: "call-1", toolName: "get_case", input: { caseId: "c1" } }] },
      { text: "The case is with RGS.", toolCalls: [] },
    ]);

    const firstResponse = await fakeProvider.complete({
      system: "you are a CRM assistant",
      messages: [{ role: "user", content: "where is case c1" }],
      tools: [],
    });
    expect(firstResponse.toolCalls[0]?.toolName).toBe("get_case");

    const secondResponse = await fakeProvider.complete({
      system: "you are a CRM assistant",
      messages: [{ role: "user", content: "where is case c1" }],
      tools: [],
    });
    expect(secondResponse.text).toBe("The case is with RGS.");
    expect(fakeProvider.receivedRequests).toHaveLength(2);
  });

  it("throws when the loop asks for more turns than were scripted", async () => {
    const fakeProvider = new FakeLlmProvider([{ text: "done", toolCalls: [] }]);
    await fakeProvider.complete({ system: "s", messages: [], tools: [] });
    await expect(
      fakeProvider.complete({ system: "s", messages: [], tools: [] }),
    ).rejects.toThrow(/scripted/);
  });
});

describe("createLlmProvider", () => {
  it("returns a provider whose name matches the configured one", () => {
    const provider = createLlmProvider({
      providerName: "anthropic",
      model: "claude-opus-5",
      apiKey: "k",
    });
    expect(provider.name).toBe("anthropic");
  });

  // Ruling P7 (task 2, link 2 of 3: config -> factory -> adapter).
  it("threads thinkingMode from the config through to the Anthropic adapter", () => {
    const provider = createLlmProvider({
      providerName: "anthropic",
      model: "claude-opus-5",
      apiKey: "k",
      thinkingMode: "adaptive",
    });
    expect(provider).toBeInstanceOf(AnthropicLlmProvider);
    expect((provider as AnthropicLlmProvider).thinkingMode).toBe("adaptive");
  });
});
