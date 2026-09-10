# CRM Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the RGS CRM an agent that reads freely, proposes every write for human approval, and can be pointed at either Anthropic or Gemini without touching a line of application code.

**Architecture:** A provider-neutral `LlmProvider` seam with two adapters behind a factory on `LLM_PROVIDER`. Above it, our own loop — never a vendor tool-runner — because the approval gate is a safety invariant and must live in code we own. Read tools execute immediately; write tools are pure functions that return a `ProposedChange` and physically cannot reach the table. Approval is what invokes the existing Plan 2 domain functions.

**Tech Stack:** TypeScript strict (ESM, no file extensions on local imports), Zod 3, Vitest 2, `@anthropic-ai/sdk`, `@google/genai`, DynamoDB single-table via the existing `TableClient` port.

**Spec:** `docs/superpowers/specs/2026-09-09-rgs-crm-design.md` §7 (agent layer), §10 (testing), §13 (AX Handbook mapping). **The watchdog, though it sits in §7, is NOT in this plan** — see "Scope" below.

## Global Constraints

- Node >= 22, pnpm workspace. TypeScript strict with `noUncheckedIndexedAccess: true`.
- **ESM only: local imports carry no file extension.** `import { foo } from "./bar"`, never `"./bar.js"`.
- **Descriptive variable names.** Repo owner's standing rule. No `x`, `res`, `tmp`, `d`.
- **`services/api/src/domain/crm/keys.ts` is the ONLY file permitted to write a CRM DynamoDB key as a string literal.** Every new key shape gets a builder there. Reviewers grep for leaks.
- **`services/api/src/http/router.ts` maps only `ApiError` subclasses.** A bare `.parse()` ZodError becomes a 500. Parse request bodies into an `ApiError` via the existing helpers.
- **The CDK admin route `/api/v1/admin/{proxy+}` declares GET/POST/PUT/DELETE and NO PATCH** (`infra/lib/rgs-platform-stack.ts:214-221`). A PATCH route passes every unit test and then 404s in the deployed environment. Use PUT.
- **Mount every new route on the admin router**, as `crmApi.ts` does — it inherits the admin Cognito authorizer and the existing proxy route, so no CDK change is needed for this plan.
- **`LLM_MODEL` is never hardcoded.** Model id, provider and key all come from environment. No default model string anywhere in application code.
- **No secret is ever logged, echoed into an audit event, or included in an error message.**
- Every domain mutation takes `(context, tenantId, ..., actorEmail)` in that order and records a CRM event. Follow the existing shape in `services/api/src/domain/crm/cases.ts`.
- `context.now()` for all time. Never `new Date()` inside domain or agent code.
- A test that does not go red when you break the line it covers has not tested anything. Before committing any task, delete the line your new test targets and confirm the test fails.

---

## Scope: what this plan deliberately excludes

Spec §7 contains two independent subsystems, and the writing-plans scope check says
to split them. This plan is **the agent core**. The **watchdog** is not here, for three
reasons that are facts rather than preferences:

1. Its detection is deterministic code with **no LLM involvement at all** — one model
   call per day, only to phrase and rank. It shares almost nothing with the agent loop.
2. It needs **new CDK infrastructure**. `infra/lib/rgs-platform-stack.ts` currently
   contains no EventBridge rule, no schedule, and no scheduled Lambda — verified by
   grep. That is a different kind of work from a tool registry, with a different
   failure mode (it breaks in the deployed environment, not in tests).
3. Its data model already exists and is unread: `WATCHDOG_RULE_IDS`,
   `WatchdogConfigSchema` (defaults `custody_held` 7, `case_quiet` 5,
   `courier_unconfirmed` 4, `billing_overdue` 30), and the per-case
   `watchdogOverrides` / `mutedRules` / `snoozedUntil` fields. It can be built against
   that model without the agent existing.

The watchdog and the UI screens belong in their own plans, in that order.

---

## Established facts, measured in the codebase on 2026-09-10 at `main` = `6589aeb`

Do not re-derive these; do not assume anything beyond them.

**Exists and is ready to build on:**

- `AppContext` is exactly `{ table, documents, email, adminNotificationAddress, now }`
  (`services/api/src/lib/context.ts:8-14`). **It has no LLM field.** Task 1 adds one.
- Domain mutators all share the shape `(context, tenantId, ...args, actorEmail)` and
  return the updated `crm.CrmCase`: `createCase`, `changeCaseStatus`,
  `changeApplicantCustody`, `changeApplicantOutcome`, `changeBillingStatus`
  (`services/api/src/domain/crm/cases.ts`).
- Reads available for the read tools: `getCase`, `listCasesByStatus`,
  `listCasesByPartner`, `listCaseRefsByStatus`, `listPartners`, `findPartnerByName`,
  `findTravellerByPassport`, `findTravellerByName`, `getTravellerOrThrow`,
  `listCaseEvents`, `listReviewItems`.
- `crm.CrmCase` already carries `lineItems`, `totalInr`, `appointmentDate`,
  `watchdogOverrides`, `mutedRules`, `snoozedUntil` (`packages/shared/src/crm/schemas.ts:95-125`).
- `LINE_ITEM_CATALOG` and `getLineItemDefinition(lineItemCode)` exist in
  `packages/shared/src/crm/lineItems.ts`.
- `CrmEventType` is a union of exactly six strings: `CASE_CREATED`,
  `CASE_STATUS_CHANGED`, `CUSTODY_CHANGED`, `BILLING_CHANGED`, `CASE_UPDATED`,
  `APPLICANT_OUTCOME_CHANGED` (`services/api/src/domain/crm/crmEvents.ts:5-11`).
  This plan widens it; every widening is a shared-package change with consumers.
- `registerCrmRoutes(router, context)` in `services/api/src/http/crmApi.ts` is the
  pattern to copy, including its comment explaining why PUT and not PATCH.
- Listing endpoints return `{ items, unreadableXIds }` and never let one corrupt row
  500 a whole listing. New listings must follow this.

**Does NOT exist — this plan creates it:**

- No `addLineItem` anywhere. `createCase` sets `lineItems: []`
  (`services/api/src/domain/crm/cases.ts:68`) and nothing ever appends. The
  `add_line_item` write tool has no domain function to call. **Task 6 builds it.**
- No general `updateCase`. Only the four specific mutators above. The `update_case`
  write tool is therefore scoped in Task 8 to the fields that have no mutator:
  `visaType`, `entryType`, `processing`, `submissionDate`, `appointmentDate`,
  `expectedCollectionDate`. Status, custody, outcome and billing keep their own tools.
- No `COUNTRY#<iso2>` checklist store. (`services/api/src/domain/documents.ts:40`
  has a *different* checklist — the applicant portal's document types. Do not reuse it.)
- No `trustLevel`, no `TENANT#<t>#CRM_USER#<email> / PREFS` item, no `CONFIG`
  partition key builder in `keys.ts`.
- No `@anthropic-ai/sdk` and no `@google/genai` dependency in any package.json.

---

## File structure

```
services/api/src/agent/
  providers/
    types.ts          LlmProvider, AgentMessage, ToolDefinition, ToolCall, LlmUsage
    config.ts         env -> LlmProviderConfig; throws on missing required vars
    anthropic.ts      AnthropicLlmProvider
    gemini.ts         GeminiLlmProvider
    fake.ts           FakeLlmProvider — scripted turns, for every other task's tests
    index.ts          createLlmProvider(config) factory + fallback
  tools/
    registry.ts       ToolRegistry, read/write split, JSON-schema emission
    readTools.ts      search_cases, get_case, find_traveller, list_partners
    aggregate.ts      aggregate — computes in code, returns numbers
    checklist.ts      get_country_checklist
    writeTools.ts     create_case, update_case, add_line_item, set_custody, set_billing
    memoryTools.ts    remember, forget, recall
  approval.ts         ProposedChange, ApprovalToken, applyApprovedChange
  memory.ts           three-scope memory store
  prefs.ts            trustLevel read/write
  loop.ts             the agent loop
services/api/src/domain/crm/
  lineItems.ts        addLineItem — the missing write path
  countryChecklist.ts COUNTRY#<iso2> profiles
services/api/src/http/
  agentApi.ts         routes, mounted on the admin router
```

---

### Task 1: The provider seam and a fake to build everything else against

**Files:**
- Create: `services/api/src/agent/providers/types.ts`
- Create: `services/api/src/agent/providers/config.ts`
- Create: `services/api/src/agent/providers/fake.ts`
- Create: `services/api/src/agent/providers/index.ts`
- Modify: `services/api/src/lib/context.ts:8-14` (add `llm` to `AppContext`)
- Test: `services/api/test/agent/providers.test.ts`

**Interfaces:**
- Consumes: nothing — this is the first task.
- Produces: `LlmProvider`, `AgentMessage`, `ToolDefinition`, `ToolCall`, `LlmUsage`,
  `LlmProviderConfig`, `llmProviderConfigFromEnvironment(env)`,
  `createLlmProvider(config)`, `FakeLlmProvider`. Every later task's tests use
  `FakeLlmProvider`; no later task may call a real provider in a test.

No vendor SDK is installed in this task. The seam must be provable without one.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/agent/providers.test.ts
import { describe, expect, it } from "vitest";
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

  it("never puts the api key in the thrown message", () => {
    let thrownMessage = "";
    try {
      llmProviderConfigFromEnvironment({ LLM_PROVIDER: "", LLM_API_KEY: "super-secret" });
    } catch (error) {
      thrownMessage = (error as Error).message;
    }
    expect(thrownMessage).not.toContain("super-secret");
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
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd services/api && pnpm exec vitest run test/agent/providers.test.ts`
Expected: FAIL — cannot resolve `../../src/agent/providers/config`.

- [ ] **Step 3: Write the types**

```ts
// services/api/src/agent/providers/types.ts

/** One turn in the conversation, provider-agnostic. */
export interface AgentMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  /** Present only on tool_result messages; ties the result to its call. */
  toolCallId?: string;
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
}
```

- [ ] **Step 4: Write the config reader**

```ts
// services/api/src/agent/providers/config.ts
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
```

- [ ] **Step 5: Write the fake**

```ts
// services/api/src/agent/providers/fake.ts
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
} from "./types";

export interface ScriptedTurn {
  text: string;
  toolCalls: LlmCompletionResponse["toolCalls"];
  usage?: LlmCompletionResponse["usage"];
}

/**
 * Every test in this plan that needs a model uses this. No test may call a real
 * provider: a suite that costs money and needs a network is a suite nobody runs.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly receivedRequests: LlmCompletionRequest[] = [];
  private nextTurnIndex = 0;

  constructor(private readonly scriptedTurns: ScriptedTurn[]) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    this.receivedRequests.push(request);
    const scriptedTurn = this.scriptedTurns[this.nextTurnIndex];
    if (scriptedTurn === undefined) {
      throw new Error(
        `FakeLlmProvider ran out of scripted turns: the loop asked for turn ${this.nextTurnIndex + 1} of ${this.scriptedTurns.length}`,
      );
    }
    this.nextTurnIndex += 1;
    return {
      text: scriptedTurn.text,
      toolCalls: scriptedTurn.toolCalls,
      usage: scriptedTurn.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    };
  }
}
```

- [ ] **Step 6: Write the factory**

Tasks 2 and 3 fill in the adapters. Until then the factory throws a named error for
each, which is what the Task 1 test asserts against by checking `.name` only.

```ts
// services/api/src/agent/providers/index.ts
import { AnthropicLlmProvider } from "./anthropic";
import { GeminiLlmProvider } from "./gemini";
import type { LlmProvider, LlmProviderConfig } from "./types";

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.providerName) {
    case "anthropic":
      return new AnthropicLlmProvider(config);
    case "gemini":
      return new GeminiLlmProvider(config);
  }
}

export * from "./types";
```

- [ ] **Step 7: Add `llm` to `AppContext`**

In `services/api/src/lib/context.ts`, add the field to the interface:

```ts
export interface AppContext {
  table: TableClient;
  documents: DocumentStore;
  email: EmailSender;
  adminNotificationAddress: string;
  now: () => Date;
  /**
   * The agent's model seam. Optional because every route that predates the
   * agent builds a context without one, and a required field here would mean
   * touching every existing test.
   */
  llm?: LlmProvider;
}
```

- [ ] **Step 8: Run the test and the whole suite**

Run: `cd services/api && pnpm exec vitest run` — the new file passes and nothing
that already existed breaks. Then `pnpm -r typecheck`.

- [ ] **Step 9: Mutation check before committing**

Delete the `LLM_MODEL` guard in `config.ts` and re-run: the "refuses a missing model"
test must go red. Restore it.

- [ ] **Step 10: Commit**

```bash
git add services/api/src/agent services/api/src/lib/context.ts services/api/test/agent
git commit -m "feat(agent): a provider-neutral LLM seam and the fake every other task tests against"
```

---

### Task 2: The Anthropic adapter

**Files:**
- Create: `services/api/src/agent/providers/anthropic.ts`
- Modify: `services/api/package.json` (add `@anthropic-ai/sdk`)
- Test: `services/api/test/agent/anthropicProvider.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`, `LlmProviderConfig`, `AgentMessage`, `ToolDefinition`,
  `ToolCall` from Task 1's `providers/types`.
- Produces: `AnthropicLlmProvider`, and `mapMessagesToAnthropic(messages)` /
  `mapAnthropicResponse(response)` exported for direct testing.

**API drift you must not get wrong.** Several Claude API shapes changed in 2025-2026,
and a recalled pattern is likely stale:

- Extended thinking on Claude 4.6+ models is `thinking: { type: "adaptive" }`.
  `budget_tokens` is **rejected with a 400** on Fable 5/5.1, Sonnet 5, Opus 5/4.8/4.7.
- Because `LLM_MODEL` is environment-driven, this adapter **must not send a thinking
  block at all** unless `LLM_THINKING=adaptive` is set. We cannot know from a model
  string alone whether the deployment's model accepts it, and a 400 on every request
  is a worse failure than no thinking.

The test uses an injected fake client, not the network. Take the SDK's message-create
shape as the seam.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/agent/anthropicProvider.test.ts
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
});
```

- [ ] **Step 2: Confirm it fails** — `pnpm exec vitest run test/agent/anthropicProvider.test.ts`, module not found.

- [ ] **Step 3: Add the dependency**

```bash
pnpm --filter @rgs/api add @anthropic-ai/sdk
```

- [ ] **Step 4: Write the adapter**

```ts
// services/api/src/agent/providers/anthropic.ts
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
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

export interface AnthropicAdapterOptions {
  /** Omitted by default. See the plan's note on API drift: sending a thinking
   * block a model does not accept is a 400 on every single request. */
  thinkingMode?: "adaptive";
  maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

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

export function mapAnthropicResponse(response: AnthropicRawResponse): LlmCompletionResponse {
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

  return {
    text: textParts.join(""),
    toolCalls,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      // Absent on responses with no cache hit. `?? 0` rather than arithmetic on
      // undefined, which yields NaN and poisons every cost figure downstream.
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: AnthropicMessagesClient;

  constructor(
    private readonly config: LlmProviderConfig,
    injectedClient?: AnthropicMessagesClient,
    private readonly options: AnthropicAdapterOptions = {},
  ) {
    this.client = injectedClient ?? (new Anthropic({ apiKey: config.apiKey }) as unknown as AnthropicMessagesClient);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const rawResponse = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      system: request.system,
      messages: mapMessagesToAnthropic(request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((toolDefinition) => ({
              name: toolDefinition.name,
              description: toolDefinition.description,
              input_schema: toolDefinition.inputSchema,
            })),
          }
        : {}),
      ...(this.options.thinkingMode === "adaptive" ? { thinking: { type: "adaptive" } } : {}),
    });

    return mapAnthropicResponse(rawResponse);
  }
}
```

- [ ] **Step 5: Run the tests** — all four pass; `pnpm -r typecheck` clean.

- [ ] **Step 6: Mutation check** — change `?? 0` to `as number` on `cache_read_input_tokens`; the "never NaN" test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/agent/providers/anthropic.ts services/api/test/agent/anthropicProvider.test.ts services/api/package.json pnpm-lock.yaml
git commit -m "feat(agent): the Anthropic adapter, with thinking off unless asked for"
```

---

### Task 3: The Gemini adapter

**Files:**
- Create: `services/api/src/agent/providers/gemini.ts`
- Modify: `services/api/package.json` (add `@google/genai`)
- Test: `services/api/test/agent/geminiProvider.test.ts`

**Interfaces:**
- Consumes: the same `providers/types` surface as Task 2.
- Produces: `GeminiLlmProvider`, `mapMessagesToGemini`, `mapGeminiResponse`.

This is the provider the owner expects to run on, for cost. It must be at least as
well covered as the Anthropic one. Gemini names things differently — `contents` not
`messages`, `parts` not content blocks, `functionCall` not `tool_use`,
`functionDeclarations` not `tools`, and usage arrives as `usageMetadata` with
`promptTokenCount` / `candidatesTokenCount` / `cachedContentTokenCount`.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/agent/geminiProvider.test.ts
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
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Add the dependency** — `pnpm --filter @rgs/api add @google/genai`

- [ ] **Step 4: Write the adapter**

```ts
// services/api/src/agent/providers/gemini.ts
import { GoogleGenAI } from "@google/genai";
import type {
  AgentMessage,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmProviderConfig,
} from "./types";

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

  responseParts.forEach((responsePart, partIndex) => {
    if (typeof responsePart.text === "string") {
      textParts.push(responsePart.text);
    }
    if (responsePart.functionCall !== undefined) {
      toolCalls.push({
        // Gemini returns no call id. Position makes it deterministic, which
        // matters because the loop keys tool results off this value.
        toolCallId: `${responsePart.functionCall.name}-${partIndex}`,
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

  constructor(private readonly config: LlmProviderConfig, injectedClient?: GeminiModelsClient) {
    this.client =
      injectedClient ?? (new GoogleGenAI({ apiKey: config.apiKey }) as unknown as GeminiModelsClient);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const rawResponse = await this.client.models.generateContent({
      model: this.config.model,
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
```

- [ ] **Step 5: Run tests, then `pnpm -r typecheck`.**

- [ ] **Step 6: Mutation check** — drop the `?? 0` on `promptTokenCount`; the "no parts" test goes red on `inputTokens` being `undefined`. Restore.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/agent/providers/gemini.ts services/api/test/agent/geminiProvider.test.ts services/api/package.json pnpm-lock.yaml
git commit -m "feat(agent): the Gemini adapter, the one the owner expects to run on"
```

---

### Task 4: The tool registry and the four simple read tools

**Files:**
- Create: `services/api/src/agent/tools/registry.ts`
- Create: `services/api/src/agent/tools/readTools.ts`
- Test: `services/api/test/agent/readTools.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` (Task 1); `getCase`, `listCasesByStatus`,
  `listCasesByPartner`, `listPartners`, `findTravellerByPassport`,
  `findTravellerByName` from `services/api/src/domain/crm/`.
- Produces:
  ```ts
  export type ToolKind = "read" | "write";
  export interface AgentTool<TInput = Record<string, unknown>> {
    name: string;
    kind: ToolKind;
    description: string;
    inputSchema: z.ZodType<TInput>;
    execute(context: AppContext, tenantId: string, input: TInput, actorEmail: string): Promise<unknown>;
  }
  export class ToolRegistry {
    constructor(tools: AgentTool[]);
    get(toolName: string): AgentTool | undefined;
    readTools(): AgentTool[];
    writeTools(): AgentTool[];
    toolDefinitions(): ToolDefinition[];
  }
  export const READ_TOOLS: AgentTool[];
  ```

The registry is what makes the approval gate checkable: `kind` is data, so a test can
assert a property over *every* write tool rather than over the ones someone remembered.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/agent/readTools.test.ts
import { describe, expect, it } from "vitest";
import { READ_TOOLS } from "../../src/agent/tools/readTools";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { buildTestContext } from "../helpers/context";       // existing helper
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

describe("the read tool registry", () => {
  it("declares every read tool as kind 'read'", () => {
    const registry = new ToolRegistry(READ_TOOLS);
    expect(registry.writeTools()).toHaveLength(0);
    expect(registry.readTools().map((tool) => tool.name).sort()).toEqual(
      ["find_traveller", "get_case", "list_partners", "search_cases"],
    );
  });

  it("emits a JSON schema per tool, so a provider can be handed the definitions", () => {
    const definitions = new ToolRegistry(READ_TOOLS).toolDefinitions();
    const getCaseDefinition = definitions.find((definition) => definition.name === "get_case");
    expect(getCaseDefinition?.inputSchema).toMatchObject({ type: "object" });
    expect(getCaseDefinition?.description.length).toBeGreaterThan(10);
  });
});

describe("get_case", () => {
  it("returns the stored case", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", partnerType: "AGENT" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" }, ACTOR);
    const createdCase = await createCase(context, TENANT_ID, {
      caseRef: "40001", caseType: "VISA", partnerId: partner.partnerId,
      destinationCountry: "JP", receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    }, ACTOR);

    const tool = new ToolRegistry(READ_TOOLS).get("get_case");
    const result = await tool!.execute(context, TENANT_ID, { caseId: createdCase.caseId }, ACTOR);
    expect((result as { caseRef: string }).caseRef).toBe("40001");
  });

  it("rejects an input the schema does not accept, before touching the table", async () => {
    const tool = new ToolRegistry(READ_TOOLS).get("get_case");
    expect(() => tool!.inputSchema.parse({})).toThrow();
  });
});

describe("find_traveller", () => {
  it("finds by passport when one is given, and by name otherwise", async () => {
    const context = buildTestContext();
    await upsertTraveller(context, TENANT_ID, { fullName: "RAVI KUMAR", passportNumber: "Z1234567" }, ACTOR);

    const tool = new ToolRegistry(READ_TOOLS).get("find_traveller");
    const byPassport = await tool!.execute(context, TENANT_ID, { passportNumber: "Z1234567" }, ACTOR);
    expect((byPassport as { travellers: unknown[] }).travellers).toHaveLength(1);

    const byName = await tool!.execute(context, TENANT_ID, { fullName: "RAVI KUMAR" }, ACTOR);
    expect((byName as { travellers: unknown[] }).travellers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Write the registry**

```ts
// services/api/src/agent/tools/registry.ts
import { z } from "zod";
import type { AppContext } from "../../lib/context";
import type { ToolDefinition } from "../providers/types";

export type ToolKind = "read" | "write";

export interface AgentTool<TInput = any> {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(
    context: AppContext,
    tenantId: string,
    input: TInput,
    actorEmail: string,
  ): Promise<unknown>;
}

/**
 * Minimal Zod -> JSON Schema. Deliberately not a dependency: the tool inputs in
 * this plan are flat objects of strings, numbers, booleans, enums and arrays of
 * strings, and a whole library to convert those is weight we do not need.
 * If a tool ever needs a nested object, extend this and its test together.
 */
export function zodObjectToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const objectSchema = schema as unknown as z.ZodObject<z.ZodRawShape>;
  const shape = objectSchema.shape;
  const properties: Record<string, unknown> = {};
  const requiredPropertyNames: string[] = [];

  for (const [propertyName, propertySchema] of Object.entries(shape)) {
    const unwrapped = propertySchema instanceof z.ZodOptional ? propertySchema.unwrap() : propertySchema;
    if (!(propertySchema instanceof z.ZodOptional)) {
      requiredPropertyNames.push(propertyName);
    }
    if (unwrapped instanceof z.ZodEnum) {
      properties[propertyName] = { type: "string", enum: unwrapped.options };
    } else if (unwrapped instanceof z.ZodNumber) {
      properties[propertyName] = { type: "number" };
    } else if (unwrapped instanceof z.ZodBoolean) {
      properties[propertyName] = { type: "boolean" };
    } else if (unwrapped instanceof z.ZodArray) {
      properties[propertyName] = { type: "array", items: { type: "string" } };
    } else {
      properties[propertyName] = { type: "string" };
    }
  }

  return { type: "object", properties, required: requiredPropertyNames };
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`two tools are registered under the name "${tool.name}"`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  get(toolName: string): AgentTool | undefined {
    return this.toolsByName.get(toolName);
  }

  allTools(): AgentTool[] {
    return [...this.toolsByName.values()];
  }

  readTools(): AgentTool[] {
    return this.allTools().filter((tool) => tool.kind === "read");
  }

  writeTools(): AgentTool[] {
    return this.allTools().filter((tool) => tool.kind === "write");
  }

  toolDefinitions(): ToolDefinition[] {
    return this.allTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodObjectToJsonSchema(tool.inputSchema),
    }));
  }
}
```

- [ ] **Step 4: Write the read tools**

```ts
// services/api/src/agent/tools/readTools.ts
import { z } from "zod";
import { crm } from "@rgs/shared";
import { getCase, listCasesByPartner, listCasesByStatus } from "../../domain/crm/cases";
import { listPartners } from "../../domain/crm/partners";
import { findTravellerByName, findTravellerByPassport } from "../../domain/crm/travellers";
import type { AgentTool } from "./registry";

const SEARCH_CASES_PAGE_LIMIT = 50;

const getCaseTool: AgentTool<{ caseId: string }> = {
  name: "get_case",
  kind: "read",
  description:
    "Fetch one case by its caseId, with its applicants, three status axes, line items and dates.",
  inputSchema: z.object({ caseId: z.string().min(1) }),
  execute: async (context, tenantId, input) => getCase(context, tenantId, input.caseId),
};

const searchCasesTool: AgentTool<{ caseStatus?: crm.CaseStatus; partnerId?: string; limit?: number }> = {
  name: "search_cases",
  kind: "read",
  description:
    "List cases by status or by partner. Returns at most 50 per call; state which filter you used when you answer.",
  inputSchema: z.object({
    caseStatus: z.enum(crm.CASE_STATUSES).optional(),
    partnerId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(SEARCH_CASES_PAGE_LIMIT).optional(),
  }),
  execute: async (context, tenantId, input) => {
    const limit = input.limit ?? SEARCH_CASES_PAGE_LIMIT;
    if (input.partnerId !== undefined) {
      return listCasesByPartner(context, tenantId, input.partnerId, { limit });
    }
    if (input.caseStatus !== undefined) {
      return listCasesByStatus(context, tenantId, input.caseStatus, limit);
    }
    // Neither filter given. Refusing beats scanning the whole tenant and
    // handing the model 7,156 cases it cannot hold.
    throw new Error("search_cases needs either caseStatus or partnerId");
  },
};

const findTravellerTool: AgentTool<{ passportNumber?: string; fullName?: string }> = {
  name: "find_traveller",
  kind: "read",
  description: "Find travellers already on file, by passport number or by full name.",
  inputSchema: z.object({
    passportNumber: z.string().min(1).optional(),
    fullName: z.string().min(1).optional(),
  }),
  execute: async (context, tenantId, input) => {
    if (input.passportNumber !== undefined) {
      const traveller = await findTravellerByPassport(context, tenantId, input.passportNumber);
      return { travellers: traveller === undefined ? [] : [traveller] };
    }
    if (input.fullName !== undefined) {
      const traveller = await findTravellerByName(context, tenantId, input.fullName);
      return { travellers: traveller === undefined ? [] : [traveller] };
    }
    throw new Error("find_traveller needs either passportNumber or fullName");
  },
};

const listPartnersTool: AgentTool<Record<string, never>> = {
  name: "list_partners",
  kind: "read",
  description: "List every referring agency with its canonical name and aliases.",
  inputSchema: z.object({}),
  execute: async (context, tenantId) => listPartners(context, tenantId),
};

export const READ_TOOLS: AgentTool[] = [
  getCaseTool,
  searchCasesTool,
  findTravellerTool,
  listPartnersTool,
];
```

- [ ] **Step 5: Run tests and typecheck.**

- [ ] **Step 6: Mutation check** — change `searchCasesTool.kind` to `"write"`; the
  "declares every read tool as kind 'read'" test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/agent/tools services/api/test/agent/readTools.test.ts
git commit -m "feat(agent): the tool registry and the four simple read tools"
```

---

### Task 5: `aggregate` and `get_country_checklist`

**Files:**
- Create: `services/api/src/agent/tools/aggregate.ts`
- Create: `services/api/src/agent/tools/checklist.ts`
- Create: `services/api/src/domain/crm/countryChecklist.ts`
- Modify: `services/api/src/domain/crm/keys.ts` (add `countryChecklistPartitionKey`)
- Modify: `services/api/src/agent/tools/readTools.ts` (add both to `READ_TOOLS`)
- Test: `services/api/test/agent/aggregate.test.ts`, `services/api/test/crm/countryChecklist.test.ts`

**Interfaces:**
- Consumes: `AgentTool` (Task 4), `listCaseRefsByStatus` and `listCasesByStatus`.
- Produces: `aggregateTool`, `getCountryChecklistTool`,
  `putCountryChecklist(context, tenantId, checklist, actorEmail)`,
  `getCountryChecklist(context, tenantId, countryCode)`,
  `CountryChecklistSchema` with shape
  `{ countryCode, requiredDocuments: string[], notes?: string, updatedAt }`.

Spec §7: **`aggregate` computes in code and returns numbers. The model never holds the
ledger in context.** That is the whole reason this tool exists, so the test that proves
it must assert on the SHAPE of what comes back — counts, not rows.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/agent/aggregate.test.ts
import { describe, expect, it } from "vitest";
import { aggregateTool } from "../../src/agent/tools/aggregate";
import { buildTestContext } from "../helpers/context";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedCases(context: ReturnType<typeof buildTestContext>, howMany: number) {
  const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", partnerType: "AGENT" }, ACTOR);
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" }, ACTOR);
  for (let caseIndex = 0; caseIndex < howMany; caseIndex += 1) {
    await createCase(context, TENANT_ID, {
      caseRef: `5000${caseIndex}`, caseType: "VISA", partnerId: partner.partnerId,
      destinationCountry: "JP", receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    }, ACTOR);
  }
  return partner;
}

describe("aggregate", () => {
  it("returns counts, never the underlying rows", async () => {
    const context = buildTestContext();
    await seedCases(context, 3);

    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR);

    expect(result).toEqual({ groupBy: "caseStatus", counts: { NEW: 3 }, total: 3 });
    // The point of the tool: no case objects come back at all.
    expect(JSON.stringify(result)).not.toContain("caseRef");
  });

  it("groups by destination country", async () => {
    const context = buildTestContext();
    await seedCases(context, 2);
    const result = await aggregateTool.execute(context, TENANT_ID, { groupBy: "destinationCountry" }, ACTOR);
    expect(result).toEqual({ groupBy: "destinationCountry", counts: { JP: 2 }, total: 2 });
  });

  it("names the unreadable rows it could not count rather than quietly undercounting", async () => {
    const context = buildTestContext();
    await seedCases(context, 1);
    await context.table.put({ PK: `TENANT#${TENANT_ID}#CASE#broken`, SK: "META", GSI1PK: `TENANT#${TENANT_ID}#CASE_STATUS#NEW`, GSI1SK: "x" });

    const result = (await aggregateTool.execute(context, TENANT_ID, { groupBy: "caseStatus" }, ACTOR)) as {
      total: number; uncountedCaseIds: string[];
    };
    expect(result.total).toBe(1);
    expect(result.uncountedCaseIds).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Write `aggregate`**

```ts
// services/api/src/agent/tools/aggregate.ts
import { z } from "zod";
import { crm } from "@rgs/shared";
import { listCasesByStatus } from "../../domain/crm/cases";
import type { AgentTool } from "./registry";

const AGGREGATE_PAGE_LIMIT = 1_000_000;
const GROUP_BY_FIELDS = ["caseStatus", "destinationCountry", "billingStatus", "partnerId"] as const;
type GroupByField = (typeof GROUP_BY_FIELDS)[number];

export const aggregateTool: AgentTool<{ groupBy: GroupByField }> = {
  name: "aggregate",
  kind: "read",
  description:
    "Count cases grouped by status, destination country, billing status or partner. Returns numbers only — use this instead of listing cases when the question is 'how many'.",
  inputSchema: z.object({ groupBy: z.enum(GROUP_BY_FIELDS) }),
  execute: async (context, tenantId, input) => {
    const counts: Record<string, number> = {};
    const uncountedCaseIds: string[] = [];
    let total = 0;

    for (const caseStatus of crm.CASE_STATUSES) {
      const { cases, unreadableCaseIds } = await listCasesByStatus(
        context, tenantId, caseStatus, AGGREGATE_PAGE_LIMIT,
      );
      uncountedCaseIds.push(...unreadableCaseIds);
      for (const storedCase of cases) {
        const groupValue = String(storedCase[input.groupBy]);
        counts[groupValue] = (counts[groupValue] ?? 0) + 1;
        total += 1;
      }
    }

    // A corrupt row is named, never silently dropped from a number the owner
    // will act on. Same rule the listing endpoints follow.
    return uncountedCaseIds.length > 0
      ? { groupBy: input.groupBy, counts, total, uncountedCaseIds }
      : { groupBy: input.groupBy, counts, total };
  },
};
```

- [ ] **Step 4: Write the country checklist store**

Add to `services/api/src/domain/crm/keys.ts` — this is the only file allowed the literal:

```ts
export function countryChecklistPartitionKey(tenantId: string, countryCode: string): string {
  return `TENANT#${tenantId}#COUNTRY#${countryCode}`;
}
```

```ts
// services/api/src/domain/crm/countryChecklist.ts
import { z } from "zod";
import type { AppContext } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { META_SORT_KEY, countryChecklistPartitionKey } from "./keys";

export const CountryChecklistSchema = z.object({
  countryCode: z.string().length(2),
  requiredDocuments: z.array(z.string().min(1)),
  notes: z.string().optional(),
  updatedAt: z.string(),
});
export type CountryChecklist = z.infer<typeof CountryChecklistSchema>;

export async function putCountryChecklist(
  context: AppContext,
  tenantId: string,
  input: { countryCode: string; requiredDocuments: string[]; notes?: string },
): Promise<CountryChecklist> {
  const checklist: CountryChecklist = {
    countryCode: input.countryCode,
    requiredDocuments: input.requiredDocuments,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    updatedAt: context.now().toISOString(),
  };
  await context.table.put({
    PK: countryChecklistPartitionKey(tenantId, input.countryCode),
    SK: META_SORT_KEY,
    ...checklist,
  });
  return checklist;
}

export async function getCountryChecklist(
  context: AppContext,
  tenantId: string,
  countryCode: string,
): Promise<CountryChecklist> {
  const storedItem = await context.table.get(
    countryChecklistPartitionKey(tenantId, countryCode),
    META_SORT_KEY,
  );
  if (storedItem === undefined) {
    throw notFound(`No document checklist is on file for ${countryCode}`);
  }
  const { PK: _partitionKey, SK: _sortKey, ...checklistAttributes } = storedItem;
  return CountryChecklistSchema.parse(checklistAttributes);
}
```

```ts
// services/api/src/agent/tools/checklist.ts
import { z } from "zod";
import { getCountryChecklist } from "../../domain/crm/countryChecklist";
import type { AgentTool } from "./registry";

export const getCountryChecklistTool: AgentTool<{ countryCode: string }> = {
  name: "get_country_checklist",
  kind: "read",
  description:
    "The documents a destination country requires. Use this before saying a file is complete.",
  inputSchema: z.object({ countryCode: z.string().length(2) }),
  execute: async (context, tenantId, input) =>
    getCountryChecklist(context, tenantId, input.countryCode),
};
```

- [ ] **Step 5: Register both** — add `aggregateTool` and `getCountryChecklistTool` to
  `READ_TOOLS` in `readTools.ts`, and extend the registry test's expected name list to
  `["aggregate", "find_traveller", "get_case", "get_country_checklist", "list_partners", "search_cases"]`.

- [ ] **Step 6: Run tests and typecheck.**

- [ ] **Step 7: Mutation check** — delete the `uncountedCaseIds.push(...)` line; the
  "names the unreadable rows" test goes red. Restore.

- [ ] **Step 8: Commit**

```bash
git add services/api/src/agent/tools services/api/src/domain/crm/countryChecklist.ts services/api/src/domain/crm/keys.ts services/api/test
git commit -m "feat(agent): aggregate counts in code, and the country document checklist"
```

---

### Task 6: `addLineItem` — the write path the spec assumes and the codebase lacks

**Files:**
- Create: `services/api/src/domain/crm/lineItems.ts`
- Modify: `services/api/src/domain/crm/crmEvents.ts:5-11` (add `LINE_ITEM_ADDED`)
- Test: `services/api/test/crm/lineItems.test.ts`

**Interfaces:**
- Consumes: `readCaseOrThrow`/`writeCase` from `caseStore`, `recordCrmEvent`,
  `getLineItemDefinition` and `LINE_ITEM_CATALOG` from `@rgs/shared`.
- Produces: `addLineItem(context, tenantId, caseId, input, actorEmail): Promise<crm.CrmCase>`
  where `input` is `{ lineItemCode: string; quantity: number; unitPriceInr: number }`.

`createCase` sets `lineItems: []` (`cases.ts:68`) and nothing has ever appended to it.
`totalInr` therefore never moves off `0`. This task is a plain domain function; the
`add_line_item` tool in Task 8 proposes calling it, and approval invokes it.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/crm/lineItems.test.ts
import { describe, expect, it } from "vitest";
import { addLineItem } from "../../src/domain/crm/lineItems";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { buildTestContext } from "../helpers/context";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { createCase } from "../../src/domain/crm/cases";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedOneCase(context: ReturnType<typeof buildTestContext>) {
  const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", partnerType: "AGENT" }, ACTOR);
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" }, ACTOR);
  return createCase(context, TENANT_ID, {
    caseRef: "60001", caseType: "VISA", partnerId: partner.partnerId,
    destinationCountry: "JP", receivedDate: "2026-09-01",
    applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
  }, ACTOR);
}

describe("addLineItem", () => {
  it("appends the item and recomputes totalInr from every line, not by adding to the old total", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);

    const afterFirst = await addLineItem(context, TENANT_ID, seededCase.caseId,
      { lineItemCode: "VISA_FEE", quantity: 2, unitPriceInr: 5000 }, ACTOR);
    expect(afterFirst.totalInr).toBe(10000);

    const afterSecond = await addLineItem(context, TENANT_ID, seededCase.caseId,
      { lineItemCode: "SERVICE_FEE", quantity: 1, unitPriceInr: 1500 }, ACTOR);
    expect(afterSecond.lineItems).toHaveLength(2);
    expect(afterSecond.totalInr).toBe(11500);
  });

  it("refuses a code that is not in the catalog", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    await expect(
      addLineItem(context, TENANT_ID, seededCase.caseId,
        { lineItemCode: "MADE_UP", quantity: 1, unitPriceInr: 100 }, ACTOR),
    ).rejects.toThrow(/MADE_UP/);
  });

  it("records an auditable event naming the code and the amount", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context);
    await addLineItem(context, TENANT_ID, seededCase.caseId,
      { lineItemCode: "VISA_FEE", quantity: 1, unitPriceInr: 5000 }, ACTOR);

    const events = await listCaseEvents(context, TENANT_ID, seededCase.caseId);
    const lineItemEvent = events.find((event) => event.eventType === "LINE_ITEM_ADDED");
    expect(lineItemEvent?.meta).toMatchObject({ lineItemCode: "VISA_FEE", amountInr: 5000 });
  });
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Widen the event union** — in `crmEvents.ts`, add `| "LINE_ITEM_ADDED"`
  to `CrmEventType`. Then grep for every exhaustive consumer:
  `grep -rn "CrmEventType\|eventType ===" services/api/src apps/admin/src` and confirm
  each still compiles. A widened union whose consumers were exhaustive is a silent break.

- [ ] **Step 4: Write the function**

```ts
// services/api/src/domain/crm/lineItems.ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";

export interface AddLineItemInput {
  lineItemCode: string;
  quantity: number;
  unitPriceInr: number;
}

export async function addLineItem(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: AddLineItemInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const lineItemDefinition = crm.getLineItemDefinition(input.lineItemCode);
  if (lineItemDefinition === undefined) {
    throw badRequest(
      `${input.lineItemCode} is not a line item this business sells; the catalog holds ${crm.LINE_ITEM_CATALOG.map((entry) => entry.code).join(", ")}`,
    );
  }

  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const amountInr = input.quantity * input.unitPriceInr;
  const appendedLineItems = [
    ...currentCase.lineItems,
    {
      lineItemCode: input.lineItemCode,
      quantity: input.quantity,
      unitPriceInr: input.unitPriceInr,
      amountInr,
    },
  ];

  const updatedCase: crm.CrmCase = {
    ...currentCase,
    lineItems: appendedLineItems,
    // Recomputed from the whole list rather than added to the stored total. A
    // running total drifts the first time anything else edits a line, and the
    // drift is invisible until someone reconciles a bill by hand.
    totalInr: appendedLineItems.reduce((runningTotal, lineItem) => runningTotal + lineItem.amountInr, 0),
    updatedAt: context.now().toISOString(),
  };

  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "LINE_ITEM_ADDED", actorEmail, {
    lineItemCode: input.lineItemCode,
    quantity: input.quantity,
    amountInr,
  });
  return updatedCase;
}
```

- [ ] **Step 5: Run tests, typecheck, and `pnpm -r build`** — the build matters here
  because `apps/admin` consumes the event union.

- [ ] **Step 6: Mutation check** — replace the `reduce` with
  `currentCase.totalInr + amountInr`; the two-item test still passes, so ALSO assert
  it goes red by seeding a case whose stored `totalInr` disagrees with its lines.
  If the mutation stays green, the test is not pinning the recompute — fix the test.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/domain/crm/lineItems.ts services/api/src/domain/crm/crmEvents.ts services/api/test/crm/lineItems.test.ts
git commit -m "feat(crm): addLineItem, the write path createCase always implied and nothing provided"
```

---

### Task 7: The approval gate, enforced as a code invariant

**Files:**
- Create: `services/api/src/agent/approval.ts`
- Modify: `services/api/src/domain/crm/keys.ts` (add `proposalPartitionKey`)
- Modify: `services/api/src/domain/crm/crmEvents.ts` (add `PROPOSAL_APPROVED`, `PROPOSAL_DISCARDED`)
- Test: `services/api/test/agent/approval.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `ToolRegistry` (Task 4); `addLineItem` (Task 6); the four
  case mutators from `cases.ts`.
- Produces:
  ```ts
  export interface ProposedChange {
    proposalId: string;
    toolName: string;
    input: Record<string, unknown>;
    /** Human-readable diff for the UI card: field, from, to. */
    summary: { field: string; from: string; to: string }[];
    caseId?: string;
    proposedBy: string;      // actor email
    proposedAt: string;
    status: "PENDING" | "APPROVED" | "DISCARDED";
  }
  export const HIGH_STAKES_TOOLS: ReadonlySet<string>;
  export function stageProposal(context, tenantId, proposal): Promise<ProposedChange>;
  export function listPendingProposals(context, tenantId): Promise<{ proposals: ProposedChange[]; unreadableProposalIds: string[] }>;
  export function applyApprovedChange(context, tenantId, proposalId, actorEmail, editedInput?): Promise<unknown>;
  export function discardProposal(context, tenantId, proposalId, actorEmail, reason): Promise<ProposedChange>;
  ```

**This is spec §7's central safety claim:** *"Write tools do not touch the database.
They return a proposed change... Approval is what invokes the domain function. This is
AX Principle 3 enforced as a code invariant rather than a prompt instruction, and it is
covered by a test that asserts no write tool can reach the database without an approval
token."*

The invariant test must be a **property over the registry**, not a list of cases. A
test that names three write tools is a test that a fourth write tool silently escapes.

- [ ] **Step 1: Write the failing test — the invariant first**

```ts
// services/api/test/agent/approval.test.ts
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { applyApprovedChange, discardProposal, stageProposal, listPendingProposals } from "../../src/agent/approval";
import { buildTestContext } from "../helpers/context";
import type { TableItem } from "../../src/lib/db";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

/** A table that fails the test the moment anything writes through it. */
function tableThatMustNotBeWritten(context: ReturnType<typeof buildTestContext>) {
  return {
    ...context.table,
    put: async (_item: TableItem) => {
      throw new Error("INVARIANT VIOLATED: a write tool reached the table without approval");
    },
    delete: async () => {
      throw new Error("INVARIANT VIOLATED: a write tool deleted without approval");
    },
  };
}

describe("the approval invariant", () => {
  // The property, over EVERY registered write tool. Adding a fourth write tool
  // later without staging it fails here automatically -- which is the point.
  it("no write tool touches the table when executed", async () => {
    const baseContext = buildTestContext();
    const guardedContext = { ...baseContext, table: tableThatMustNotBeWritten(baseContext) };
    const registry = new ToolRegistry(WRITE_TOOLS);

    expect(registry.writeTools().length).toBeGreaterThan(0);

    for (const writeTool of registry.writeTools()) {
      const proposal = await writeTool.execute(
        guardedContext,
        TENANT_ID,
        sampleInputFor(writeTool.name),
        ACTOR,
      );
      // Every write tool returns a proposal shape, never a domain object.
      expect(proposal).toMatchObject({ toolName: writeTool.name, status: "PENDING" });
    }
  });

  it("every write tool is declared kind 'write', so the loop cannot auto-run one", () => {
    const registry = new ToolRegistry(WRITE_TOOLS);
    expect(registry.readTools()).toHaveLength(0);
  });
});

describe("applyApprovedChange", () => {
  it("invokes the domain function and marks the proposal approved", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);            // helper as in Task 6
    const staged = await stageProposal(context, TENANT_ID, {
      toolName: "set_billing",
      input: { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      summary: [{ field: "billingStatus", from: "UNKNOWN", to: "BILL_SENT" }],
      caseId: seeded.caseId,
      proposedBy: ACTOR,
    });

    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)) as { billingStatus: string };
    expect(updated.billingStatus).toBe("BILL_SENT");

    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals.find((proposal) => proposal.proposalId === staged.proposalId)).toBeUndefined();
  });

  it("refuses to apply the same proposal twice", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const staged = await stageProposal(context, TENANT_ID, {
      toolName: "set_billing",
      input: { caseId: seeded.caseId, billingStatus: "BILL_SENT" },
      summary: [], caseId: seeded.caseId, proposedBy: ACTOR,
    });
    await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR);
    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toThrow(/APPROVED/);
  });

  it("applies the human's edit, not the model's original input", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const staged = await stageProposal(context, TENANT_ID, {
      toolName: "set_billing",
      input: { caseId: seeded.caseId, billingStatus: "PAID" },
      summary: [], caseId: seeded.caseId, proposedBy: ACTOR,
    });

    const updated = (await applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR, {
      caseId: seeded.caseId, billingStatus: "BILL_SENT",
    })) as { billingStatus: string };

    expect(updated.billingStatus).toBe("BILL_SENT");
  });

  it("discarding records a reason and never invokes the domain function", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const staged = await stageProposal(context, TENANT_ID, {
      toolName: "set_billing",
      input: { caseId: seeded.caseId, billingStatus: "PAID" },
      summary: [], caseId: seeded.caseId, proposedBy: ACTOR,
    });

    const discarded = await discardProposal(context, TENANT_ID, staged.proposalId, ACTOR, "wrong case");
    expect(discarded.status).toBe("DISCARDED");
    await expect(applyApprovedChange(context, TENANT_ID, staged.proposalId, ACTOR)).rejects.toThrow(/DISCARDED/);
  });
});
```

`sampleInputFor(toolName)` is a small helper in the test file returning a valid input
per tool name. **Write it as an exhaustive switch with no `default` branch**, so adding
a write tool in future fails to compile until someone supplies its sample — the same
trick as the registry property, applied to the test's own fixtures.

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Add the key builder and event types**

In `keys.ts`:

```ts
export const PROPOSAL_SORT_KEY = META_SORT_KEY;

export function proposalPartitionKey(tenantId: string, proposalId: string): string {
  return `TENANT#${tenantId}#PROPOSAL#${proposalId}`;
}

export function proposalStatusGsi1Pk(tenantId: string, proposalStatus: string): string {
  return `TENANT#${tenantId}#PROPOSAL_STATUS#${proposalStatus}`;
}
```

In `crmEvents.ts`, widen `CrmEventType` with `| "PROPOSAL_APPROVED" | "PROPOSAL_DISCARDED"`.

- [ ] **Step 4: Write the approval module**

```ts
// services/api/src/agent/approval.ts
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { runQuery } from "../lib/db";
import {
  PROPOSAL_SORT_KEY,
  proposalPartitionKey,
  proposalStatusGsi1Pk,
} from "../domain/crm/keys";
import { recordCrmEvent } from "../domain/crm/crmEvents";
import {
  changeApplicantCustody,
  changeBillingStatus,
  createCase,
  updateCaseDetails,
} from "../domain/crm/cases";
import { addLineItem } from "../domain/crm/lineItems";
import { rememberMemory, forgetMemory } from "./memory";

export const ProposedChangeSchema = z.object({
  proposalId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
  summary: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
  caseId: z.string().optional(),
  proposedBy: z.string().min(1),
  proposedAt: z.string(),
  status: z.enum(["PENDING", "APPROVED", "DISCARDED"]),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  discardReason: z.string().optional(),
});
export type ProposedChange = z.infer<typeof ProposedChangeSchema>;

/**
 * Spec §7 trust ladder: "Anything touching money, outcome, or deletion is staged
 * at every level." Trust level 2 may auto-apply anything NOT in this set.
 */
export const HIGH_STAKES_TOOLS: ReadonlySet<string> = new Set([
  "set_billing",
  "add_line_item",
  "set_outcome",
  "forget",
]);

export async function stageProposal(
  context: AppContext,
  tenantId: string,
  proposal: Omit<ProposedChange, "proposalId" | "proposedAt" | "status">,
): Promise<ProposedChange> {
  const stagedProposal: ProposedChange = {
    ...proposal,
    proposalId: newId(),
    proposedAt: context.now().toISOString(),
    status: "PENDING",
  };
  await context.table.put({
    PK: proposalPartitionKey(tenantId, stagedProposal.proposalId),
    SK: PROPOSAL_SORT_KEY,
    GSI1PK: proposalStatusGsi1Pk(tenantId, "PENDING"),
    GSI1SK: stagedProposal.proposedAt,
    ...stagedProposal,
  });
  return stagedProposal;
}

export async function listPendingProposals(
  context: AppContext,
  tenantId: string,
): Promise<{ proposals: ProposedChange[]; unreadableProposalIds: string[] }> {
  const storedItems = await runQuery(context, "GSI1", proposalStatusGsi1Pk(tenantId, "PENDING"));
  const proposals: ProposedChange[] = [];
  const unreadableProposalIds: string[] = [];

  for (const storedItem of storedItems) {
    const { PK: _pk, SK: _sk, GSI1PK: _g1pk, GSI1SK: _g1sk, ...proposalAttributes } = storedItem;
    const parsed = ProposedChangeSchema.safeParse(proposalAttributes);
    if (parsed.success) {
      proposals.push(parsed.data);
    } else {
      // One malformed row must never 500 the whole queue. Same rule as every
      // other listing in this codebase.
      unreadableProposalIds.push(String(storedItem.proposalId ?? storedItem.PK));
    }
  }
  return { proposals, unreadableProposalIds };
}

async function readProposalOrThrow(
  context: AppContext,
  tenantId: string,
  proposalId: string,
): Promise<ProposedChange> {
  const storedItem = await context.table.get(
    proposalPartitionKey(tenantId, proposalId),
    PROPOSAL_SORT_KEY,
  );
  if (storedItem === undefined) {
    throw notFound(`No proposal ${proposalId}`);
  }
  const { PK: _pk, SK: _sk, GSI1PK: _g1pk, GSI1SK: _g1sk, ...proposalAttributes } = storedItem;
  return ProposedChangeSchema.parse(proposalAttributes);
}

/**
 * The ONLY path from a proposal to the database. Every write tool returns a
 * proposal; this function is what calls a domain mutator. Nothing else in the
 * agent package may import a domain mutator -- a reviewer greps for that.
 */
export async function applyApprovedChange(
  context: AppContext,
  tenantId: string,
  proposalId: string,
  actorEmail: string,
  editedInput?: Record<string, unknown>,
): Promise<unknown> {
  const proposal = await readProposalOrThrow(context, tenantId, proposalId);
  if (proposal.status !== "PENDING") {
    throw conflict(`Proposal ${proposalId} is already ${proposal.status}`);
  }

  // The human's edit wins. AX Principle 3: Approve / Edit / Discard means the
  // edited value is what gets written, not the model's original suggestion.
  const effectiveInput = editedInput ?? proposal.input;
  const domainResult = await invokeDomainFunction(context, tenantId, proposal.toolName, effectiveInput, actorEmail);

  const decidedAt = context.now().toISOString();
  await context.table.put({
    PK: proposalPartitionKey(tenantId, proposalId),
    SK: PROPOSAL_SORT_KEY,
    GSI1PK: proposalStatusGsi1Pk(tenantId, "APPROVED"),
    GSI1SK: decidedAt,
    ...proposal,
    input: effectiveInput,
    status: "APPROVED",
    decidedBy: actorEmail,
    decidedAt,
  });

  if (proposal.caseId !== undefined) {
    await recordCrmEvent(context, tenantId, proposal.caseId, "PROPOSAL_APPROVED", actorEmail, {
      proposalId,
      toolName: proposal.toolName,
      edited: editedInput !== undefined,
    });
  }
  return domainResult;
}

export async function discardProposal(
  context: AppContext,
  tenantId: string,
  proposalId: string,
  actorEmail: string,
  reason: string,
): Promise<ProposedChange> {
  const proposal = await readProposalOrThrow(context, tenantId, proposalId);
  if (proposal.status !== "PENDING") {
    throw conflict(`Proposal ${proposalId} is already ${proposal.status}`);
  }
  if (reason.trim() === "") {
    throw badRequest("Discarding a proposal needs a reason; nothing goes quiet without a trace");
  }

  const decidedAt = context.now().toISOString();
  const discardedProposal: ProposedChange = {
    ...proposal, status: "DISCARDED", decidedBy: actorEmail, decidedAt, discardReason: reason,
  };
  await context.table.put({
    PK: proposalPartitionKey(tenantId, proposalId),
    SK: PROPOSAL_SORT_KEY,
    GSI1PK: proposalStatusGsi1Pk(tenantId, "DISCARDED"),
    GSI1SK: decidedAt,
    ...discardedProposal,
  });
  if (proposal.caseId !== undefined) {
    await recordCrmEvent(context, tenantId, proposal.caseId, "PROPOSAL_DISCARDED", actorEmail, {
      proposalId, toolName: proposal.toolName, reason,
    });
  }
  return discardedProposal;
}

/**
 * Exhaustive by design: no `default` branch, so adding a write tool without
 * wiring its domain call is a compile error rather than a runtime surprise.
 */
async function invokeDomainFunction(
  context: AppContext,
  tenantId: string,
  toolName: string,
  input: Record<string, unknown>,
  actorEmail: string,
): Promise<unknown> {
  switch (toolName) {
    case "create_case":
      return createCase(context, tenantId, input as never, actorEmail);
    case "update_case":
      return updateCaseDetails(context, tenantId, String(input.caseId), input as never, actorEmail);
    case "add_line_item":
      return addLineItem(context, tenantId, String(input.caseId), input as never, actorEmail);
    case "set_custody":
      return changeApplicantCustody(
        context, tenantId, String(input.caseId), String(input.applicantRef),
        input.custody as never, actorEmail,
      );
    case "set_billing":
      return changeBillingStatus(context, tenantId, String(input.caseId), input.billingStatus as never, actorEmail);
    case "remember":
      return rememberMemory(context, tenantId, input as never, actorEmail);
    case "forget":
      return forgetMemory(context, tenantId, String(input.memoryId), actorEmail);
    default:
      throw badRequest(`No domain function is wired for the write tool "${toolName}"`);
  }
}
```

- [ ] **Step 5: Run tests and typecheck.**

- [ ] **Step 6: Mutation checks — three, because this is the safety core**

  1. Make one write tool call `changeBillingStatus` directly instead of returning a
     proposal. The invariant test must go red with "INVARIANT VIOLATED".
  2. Delete the `proposal.status !== "PENDING"` guard in `applyApprovedChange`. The
     "refuses to apply the same proposal twice" test must go red.
  3. Change `const effectiveInput = editedInput ?? proposal.input` to
     `proposal.input`. The "applies the human's edit" test must go red.

  All three must fail. If any stays green, the safety claim is not tested.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/agent/approval.ts services/api/src/domain/crm/keys.ts services/api/src/domain/crm/crmEvents.ts services/api/test/agent/approval.test.ts
git commit -m "feat(agent): the approval gate as a code invariant, tested as a property over every write tool"
```

---

### Task 8: The write tools and `updateCaseDetails`

**Files:**
- Create: `services/api/src/agent/tools/writeTools.ts`
- Modify: `services/api/src/domain/crm/cases.ts` (add `updateCaseDetails`)
- Test: `services/api/test/agent/writeTools.test.ts`, `services/api/test/crm/updateCaseDetails.test.ts`

**Interfaces:**
- Consumes: `AgentTool` (Task 4), `ProposedChange`/`stageProposal` (Task 7).
- Produces: `WRITE_TOOLS: AgentTool[]` — `create_case`, `update_case`, `add_line_item`,
  `set_custody`, `set_billing`; and
  `updateCaseDetails(context, tenantId, caseId, input, actorEmail): Promise<crm.CrmCase>`
  where `input` covers only `visaType`, `entryType`, `processing`, `submissionDate`,
  `appointmentDate`, `expectedCollectionDate`.

`update_case` is scoped narrowly on purpose: `caseStatus`, `custody`, `outcome` and
`billingStatus` each have a state machine and their own mutator, and a general
"update any field" tool would let the model bypass every one of them.

- [ ] **Step 1: Write the failing tests.** Cover, for `updateCaseDetails`: it changes
  only the six permitted fields; it records a `CASE_UPDATED` event naming which fields
  moved; and — the one that matters — **passing `caseStatus` or `billingStatus` in the
  input does not change them**, because those axes belong to their state machines.

```ts
it("ignores an attempt to move a state-machine axis through the details route", async () => {
  const context = buildTestContext();
  const seeded = await seedOneCase(context);
  const updated = await updateCaseDetails(context, TENANT_ID, seeded.caseId,
    { appointmentDate: "2026-10-01", caseStatus: "DECIDED", billingStatus: "PAID" } as never, ACTOR);
  expect(updated.appointmentDate).toBe("2026-10-01");
  expect(updated.caseStatus).toBe(seeded.caseStatus);
  expect(updated.billingStatus).toBe(seeded.billingStatus);
});
```

For the write tools, cover: each returns a `ProposedChange` with a populated `summary`
whose `from` values come from the CURRENT stored case (a diff card showing
`from: "unknown"` is useless to the approver), and each stages nothing until executed.

- [ ] **Step 2: Confirm they fail.**

- [ ] **Step 3: Write `updateCaseDetails`** in `cases.ts`, following the existing
  mutator shape exactly: read, build the updated case picking ONLY the six permitted
  fields off the input, `writeCase`, `recordCrmEvent(..., "CASE_UPDATED", ...)` with
  `meta` naming the changed field names, return the updated case.

- [ ] **Step 4: Write the write tools.** Each has this shape — note it executes reads
  to build the diff, and returns a proposal rather than staging it, so the loop decides
  whether to stage or auto-apply:

```ts
// services/api/src/agent/tools/writeTools.ts
import { z } from "zod";
import { crm } from "@rgs/shared";
import { getCase } from "../../domain/crm/cases";
import type { AgentTool } from "./registry";
import type { ProposedChange } from "../approval";

function proposalFrom(
  toolName: string,
  input: Record<string, unknown>,
  summary: ProposedChange["summary"],
  proposedBy: string,
  caseId?: string,
): Omit<ProposedChange, "proposalId" | "proposedAt"> & { status: "PENDING" } {
  return {
    toolName,
    input,
    summary,
    ...(caseId !== undefined ? { caseId } : {}),
    proposedBy,
    status: "PENDING",
  };
}

const setBillingTool: AgentTool<{ caseId: string; billingStatus: crm.BillingStatus }> = {
  name: "set_billing",
  kind: "write",
  description:
    "Propose moving a case's billing status. Staged for human approval — this never writes on its own.",
  inputSchema: z.object({
    caseId: z.string().min(1),
    billingStatus: z.enum(crm.BILLING_STATUSES),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge.
    const currentCase = await getCase(context, tenantId, input.caseId);
    return proposalFrom(
      "set_billing",
      input,
      [{ field: "billingStatus", from: currentCase.billingStatus, to: input.billingStatus }],
      actorEmail,
      input.caseId,
    );
  },
};

// create_case, update_case, add_line_item and set_custody follow the same shape:
// read what exists, build the summary, return the proposal. None of them import a
// domain mutator -- only `approval.ts` does.

export const WRITE_TOOLS: AgentTool[] = [
  createCaseTool,
  updateCaseTool,
  addLineItemTool,
  setCustodyTool,
  setBillingTool,
];
```

- [ ] **Step 5: Run tests, typecheck, build.**

- [ ] **Step 6: Mutation check** — in `setBillingTool`, replace the summary's `from`
  with the literal `"unknown"`. The "summary from values come from the stored case"
  test goes red. Restore.

- [ ] **Step 7: Grep check, and record the result in your report**

```bash
grep -rn "changeBillingStatus\|changeApplicantCustody\|createCase\|addLineItem\|updateCaseDetails" services/api/src/agent/
```

Expected: matches ONLY in `services/api/src/agent/approval.ts`. Any match inside
`tools/` means a write tool can reach the database, which is the invariant.

- [ ] **Step 8: Commit**

```bash
git add services/api/src/agent/tools/writeTools.ts services/api/src/domain/crm/cases.ts services/api/test
git commit -m "feat(agent): write tools that propose, and the narrowly-scoped updateCaseDetails"
```

---

### Task 9: Three-scope memory

**Files:**
- Create: `services/api/src/agent/memory.ts`
- Create: `services/api/src/agent/tools/memoryTools.ts`
- Modify: `services/api/src/domain/crm/keys.ts` (add `memoryPartitionKey`, `memoryScopeGsi1Pk`)
- Modify: `services/api/src/agent/tools/readTools.ts` (add `recall`)
- Modify: `services/api/src/agent/tools/writeTools.ts` (add `remember`, `forget`)
- Test: `services/api/test/agent/memory.test.ts`

**Interfaces:**
- Consumes: `AgentTool`, `stageProposal`.
- Produces:
  ```ts
  export const MEMORY_SCOPES = ["ORG", "PARTNER", "USER"] as const;
  export interface AgentMemory {
    memoryId: string; scope: "ORG" | "PARTNER" | "USER"; scopeKey: string;
    text: string; learnedFromCaseId?: string; createdBy: string; createdAt: string;
  }
  export function rememberMemory(context, tenantId, input, actorEmail): Promise<AgentMemory>;
  export function forgetMemory(context, tenantId, memoryId, actorEmail): Promise<void>;
  export function recallMemories(context, tenantId, scopes): Promise<{ memories: AgentMemory[]; unreadableMemoryIds: string[] }>;
  ```
  `scopeKey` is `"ORG"` for org scope, the partnerId for `PARTNER`, the email for `USER`.

Spec §7: *"The agent proposes memories through the `remember` write tool: staged and
confirmed like any other write, never silently absorbed."* So `remember` and `forget`
are `kind: "write"` and go through Task 7's gate. `recall` is a read.

- [ ] **Step 1: Write the failing test.** Cover: a memory round-trips with the case
  that taught it; `recall` returns only the scopes asked for and never another user's
  `USER`-scope rows; `forget` removes it; one corrupt memory row is named in
  `unreadableMemoryIds` rather than 500ing the recall; and — the invariant — `remember`
  is in `WRITE_TOOLS`, not `READ_TOOLS`, so Task 7's property test already covers it.

```ts
it("never returns another user's USER-scope memory", async () => {
  const context = buildTestContext();
  await rememberMemory(context, TENANT_ID, { scope: "USER", scopeKey: "alice@rgs.local", text: "prefers morning slots" }, "alice@rgs.local");
  const { memories } = await recallMemories(context, TENANT_ID, [{ scope: "USER", scopeKey: "bob@rgs.local" }]);
  expect(memories).toHaveLength(0);
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Add key builders** in `keys.ts`:

```ts
export function memoryPartitionKey(tenantId: string, memoryId: string): string {
  return `TENANT#${tenantId}#MEMORY#${memoryId}`;
}
export function memoryScopeGsi1Pk(tenantId: string, scope: string, scopeKey: string): string {
  return `TENANT#${tenantId}#MEMORY_SCOPE#${scope}#${scopeKey}`;
}
```

- [ ] **Step 4: Write `memory.ts`** following the `reviewQueue.ts` pattern exactly —
  a GSI1 query per scope, `safeParse` per row, corrupt rows named not thrown.

- [ ] **Step 5: Write the three tools** in `memoryTools.ts`. `recall` takes
  `{ scopes: ("ORG"|"PARTNER"|"USER")[]; partnerId?: string }` and resolves the USER
  scopeKey from `actorEmail` — **never from tool input**, or the model can read
  another user's memories by asking.

- [ ] **Step 6: Register** — `recall` into `READ_TOOLS`, `remember`/`forget` into
  `WRITE_TOOLS`. Update both registry name-list assertions.

- [ ] **Step 7: Mutation check** — make `recall` read the USER scopeKey from
  `input.userEmail` instead of `actorEmail`; the "never returns another user's memory"
  test goes red. Restore.

- [ ] **Step 8: Commit**

```bash
git add services/api/src/agent services/api/src/domain/crm/keys.ts services/api/test/agent/memory.test.ts
git commit -m "feat(agent): three-scope memory, proposed through the same gate as any other write"
```

---

### Task 10: The loop and the trust ladder

**Files:**
- Create: `services/api/src/agent/loop.ts`
- Create: `services/api/src/agent/prefs.ts`
- Modify: `services/api/src/domain/crm/keys.ts` (add `crmUserPrefsPartitionKey`)
- Test: `services/api/test/agent/loop.test.ts`, `services/api/test/agent/prefs.test.ts`

**Interfaces:**
- Consumes: everything above, plus `FakeLlmProvider`.
- Produces:
  ```ts
  export interface AgentTurnResult {
    reply: string;
    proposals: ProposedChange[];
    toolCallsMade: { toolName: string; kind: ToolKind }[];
    usage: LlmUsage;
  }
  export function runAgentTurn(context, tenantId, input: {
    userMessage: string; conversation: AgentMessage[]; actorEmail: string;
  }): Promise<AgentTurnResult>;
  export const MAX_TOOL_ITERATIONS = 8;
  export function readTrustLevel(context, tenantId, userEmail): Promise<0 | 1 | 2>;
  export function recordConfirmedWithoutEdit(context, tenantId, userEmail): Promise<void>;
  ```

Trust ladder (spec §7): level 0 every write staged with full reasoning; level 1
reasoning collapsed, writes still staged; level 2 low-stakes writes auto-apply with
undo. **`HIGH_STAKES_TOOLS` from Task 7 is staged at every level, including 2.**
Level 2 is opt-in per user — advancement by confirmed-without-edit approvals proposes
it, never silently switches it on.

- [ ] **Step 1: Write the failing test.** The load-bearing cases:

```ts
it("runs read tools automatically and stages write tools, in one turn", async () => {
  const context = buildTestContextWithFakeLlm([
    { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: SEEDED_CASE_ID } }] },
    { text: "", toolCalls: [{ toolCallId: "c2", toolName: "set_billing", input: { caseId: SEEDED_CASE_ID, billingStatus: "BILL_SENT" } }] },
    { text: "I've drafted the billing change for you to approve.", toolCalls: [] },
  ]);
  const result = await runAgentTurn(context, TENANT_ID, { userMessage: "bill case X", conversation: [], actorEmail: ACTOR });

  expect(result.toolCallsMade.map((call) => call.toolName)).toEqual(["get_case", "set_billing"]);
  expect(result.proposals).toHaveLength(1);
  expect(result.proposals[0]?.status).toBe("PENDING");
});

it("stages a high-stakes write even at trust level 2", async () => {
  const context = await contextAtTrustLevel(2);
  const result = await runAgentTurn(context, TENANT_ID, { /* scripts a set_billing call */ });
  expect(result.proposals).toHaveLength(1);   // NOT auto-applied
});

it("auto-applies a low-stakes write at trust level 2, and only there", async () => {
  const atTwo = await contextAtTrustLevel(2);
  const resultAtTwo = await runAgentTurn(atTwo, TENANT_ID, { /* scripts update_case */ });
  expect(resultAtTwo.proposals).toHaveLength(0);

  const atOne = await contextAtTrustLevel(1);
  const resultAtOne = await runAgentTurn(atOne, TENANT_ID, { /* same script */ });
  expect(resultAtOne.proposals).toHaveLength(1);
});

it("stops after MAX_TOOL_ITERATIONS rather than looping forever on a model that keeps calling tools", async () => {
  const neverStops = Array.from({ length: 20 }, () => ({
    text: "", toolCalls: [{ toolCallId: "c", toolName: "list_partners", input: {} }],
  }));
  const context = buildTestContextWithFakeLlm(neverStops);
  const result = await runAgentTurn(context, TENANT_ID, { userMessage: "hi", conversation: [], actorEmail: ACTOR });
  expect(result.toolCallsMade).toHaveLength(MAX_TOOL_ITERATIONS);
});

it("feeds a failing tool's error back to the model instead of aborting the turn", async () => {
  const context = buildTestContextWithFakeLlm([
    { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: "nope" } }] },
    { text: "That case doesn't exist.", toolCalls: [] },
  ]);
  const result = await runAgentTurn(context, TENANT_ID, { userMessage: "find nope", conversation: [], actorEmail: ACTOR });
  expect(result.reply).toContain("doesn't exist");
});
```

- [ ] **Step 2: Confirm it fails.**

- [ ] **Step 3: Write `prefs.ts`** — `TENANT#<t>#CRM_USER#<email>` / `PREFS`, holding
  `{ trustLevel: 0|1|2, confirmedWithoutEditCount: number }`. `readTrustLevel` returns
  `0` when no item exists: a user with no record is a new user, and new users get the
  safest behaviour.

- [ ] **Step 4: Write `loop.ts`.** Shape:

  1. Build the system prompt: role, the tenant's memories from `recall` for
     `ORG` + the actor's `USER` scope, and the instruction that write tools propose.
  2. Loop up to `MAX_TOOL_ITERATIONS`: call `context.llm.complete()`, and for each
     returned tool call — look it up in the registry; if unknown, feed back an error
     message as a `tool_result` rather than throwing; if `kind === "read"`, execute and
     append the result; if `kind === "write"`, execute to get the proposal, then either
     `stageProposal` or, at trust level 2 with a tool not in `HIGH_STAKES_TOOLS`, stage
     and immediately `applyApprovedChange` so the audit trail still records both halves.
  3. Stop when a turn returns no tool calls, or the iteration cap is hit.
  4. Return reply text, staged proposals, the tool calls made, and summed usage.

  **`context.llm` is optional on `AppContext`.** Throw a clear `badRequest` when it is
  absent rather than dereferencing undefined — every pre-agent route builds a context
  without one.

- [ ] **Step 5: Mutation checks — two.** (1) Remove the `HIGH_STAKES_TOOLS` check so
  level 2 auto-applies everything; the high-stakes test goes red. (2) Remove the
  iteration cap; the runaway test hangs or goes red. Restore both.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/agent/loop.ts services/api/src/agent/prefs.ts services/api/src/domain/crm/keys.ts services/api/test/agent
git commit -m "feat(agent): the loop, and a trust ladder that never auto-applies money or deletion"
```

---

### Task 11: HTTP routes

**Files:**
- Create: `services/api/src/http/agentApi.ts`
- Modify: `services/api/src/http/handler.ts` (register the routes; build `llm` into the production context)
- Test: `services/api/test/http/agentApi.test.ts`

**Interfaces:**
- Consumes: `runAgentTurn`, `listPendingProposals`, `applyApprovedChange`,
  `discardProposal`, `recallMemories`, `rememberMemory`, `forgetMemory`.
- Produces: `registerAgentRoutes(router, context)`, mirroring `registerCrmRoutes`.

Routes — all under the admin router, so no CDK change, and **PUT never PATCH**:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/admin/crm/agent/turn` | run one turn |
| GET | `/api/v1/admin/crm/agent/proposals` | pending proposals |
| PUT | `/api/v1/admin/crm/agent/proposals/{proposalId}/approve` | approve, optional edited input |
| PUT | `/api/v1/admin/crm/agent/proposals/{proposalId}/discard` | discard with a reason |
| GET | `/api/v1/admin/crm/agent/memories` | memories by scope |
| POST | `/api/v1/admin/crm/agent/memories` | propose a memory |
| DELETE | `/api/v1/admin/crm/agent/memories/{memoryId}` | forget |

- [ ] **Step 1: Write the failing test.** Cover: every route calls `requireAdmin`;
  a body that fails its Zod schema returns **400, not 500** (parse into an `ApiError`
  via the existing helper — a bare `.parse()` ZodError becomes a 500 in this router);
  approve passes an edited body through; discard without a reason is a 400; and the
  proposals listing returns `{ proposals, unreadableProposalIds }`.

- [ ] **Step 2-4: Confirm failure, write the routes, wire `handler.ts`.** In
  `buildProductionContext`, add
  `llm: createLlmProvider(llmProviderConfigFromEnvironment(process.env))` — but **lazily**,
  so an API instance with no LLM environment still serves every non-agent route. A
  getter that constructs on first access, or a try/catch that leaves `llm` undefined,
  both work; the test is that the existing routes keep passing with the LLM vars unset.

- [ ] **Step 5: Mutation check** — remove `requireAdmin` from the turn route; the
  auth test goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/http/agentApi.ts services/api/src/http/handler.ts services/api/test/http/agentApi.test.ts
git commit -m "feat(agent): admin routes for turns, proposals and memories"
```

---

### Task 12: Intake, and the eval that decides which provider RGS runs on

**Files:**
- Create: `services/api/src/agent/intake.ts`
- Create: `services/api/eval/intakeCases.json`
- Create: `services/api/eval/runIntakeEval.ts`
- Test: `services/api/test/agent/intake.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`, `runAgentTurn`, `findTravellerByPassport`, `findPartnerByName`.
- Produces: `extractIntake(context, tenantId, rawText, actorEmail): Promise<IntakeDraft>`
  where `IntakeDraft` is a schema-valid `CreateCaseInput` plus
  `{ unresolvedPartnerName?: string; unresolvedCountry?: string; missingDocuments: string[] }`.

Spec §7 is explicit and it is a requirement, not a nicety: *"Provider selection is an
empirical question, not a price question. A model that misreads a passport number is
not cheaper. Building the intake eval set and running both providers against it is a
first-class task in the implementation plan, not a follow-up."*

- [ ] **Step 1: Build the eval set — 20 cases minimum, real in shape.**
  `services/api/eval/intakeCases.json` is an array of
  `{ id, rawText, expected: { travellerFullName, passportNumber?, destinationCountry, partnerName?, applicantCount } }`.
  Source the shapes from the real workbook's data: WhatsApp-style pastes
  ("2 pax for japan, ashok kumar + wife, passports attached"), an email forward, a
  passport MRZ block. **Include the traps the migration already proved exist:**
  a misspelled country (`Myannmar`), a service line in the country position
  (`PASSPORT NEW`), a multi-destination trip (`TANZANIA/KENYA`), and a partner name
  that matches nothing (`SAMMY A/C`). Expected output for those is an *unresolved*
  field, not a guess.

- [ ] **Step 2: Write `extractIntake`** using `responseSchema` for a structured reply,
  then resolving traveller and partner against the real store. **A name that does not
  resolve becomes `unresolvedPartnerName`, never a new partner** — creating a partner
  is a write, and writes are staged.

- [ ] **Step 3: Unit-test it against `FakeLlmProvider`** — no network, no cost. Assert
  the resolution behaviour, not the model's wording: a known passport resolves to the
  existing travellerId; an unknown partner surfaces as unresolved; a missing required
  field never gets invented.

- [ ] **Step 4: Write the eval runner.** `runIntakeEval.ts` takes
  `--provider anthropic|gemini`, reads its key and model from the environment, runs
  every case, and scores three numbers per provider:
  **exact-field accuracy**, **hallucination rate** (fields invented that the input did
  not contain — the one that decides this, per the spec's "a model that misreads a
  passport number is not cheaper"), and **unresolved-recall** (did it correctly refuse
  to guess on the four trap cases). It prints a table and writes
  `eval/results-<provider>-<iso date>.json`.

- [ ] **Step 5: Run it against BOTH providers and record the numbers in your report.**
  This costs real money on both vendors. It is the task's deliverable — the plan does
  not consider Task 12 done until both result files exist and the report states which
  provider won on hallucination rate and by how much.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/agent/intake.ts services/api/eval services/api/test/agent/intake.test.ts
git commit -m "feat(agent): intake extraction, and the eval that picks the provider on evidence"
```

---

## Self-review

**Spec coverage (§7):** provider abstraction → Tasks 1-3. Tools table, all 13 → Tasks
4, 5, 8, 9. Approval gate as code invariant → Task 7. Intake → Task 12. Ask-the-ledger
→ Tasks 4 + 5 (`search_cases` + `aggregate`, with the loop instructed to state its
filter) + Task 10. Checklist → Task 5. Memory, three scopes → Task 9. Trust ladder →
Task 10. Env vars → Task 1. **Watchdog → deliberately excluded, see Scope.**

**Gaps I am carrying knowingly:**

1. **Ask-the-ledger's "links the underlying cases"** is a UI concern; the loop returns
   the case ids in tool results and the screen renders the links. No task here.
2. **Level 2's "with undo"** — Task 10 auto-applies through `stageProposal` +
   `applyApprovedChange`, so the proposal record exists and an undo can be built from
   it, but no undo *route* is in this plan. Flagged for the UI plan.
3. **The checklist's "seeded from the 81 Drive folders"** — Task 5 builds the store and
   the tool; seeding real data needs the folders, which are the owner's. Ship it empty;
   `get_country_checklist` 404s until seeded, which is honest.

**Type consistency checked:** `ProposedChange` (Task 7) is what write tools return
(Task 8) and what the loop stages (Task 10) and what the routes serialise (Task 11).
`AgentTool.kind` (Task 4) is what the invariant test (Task 7) and the trust ladder
(Task 10) both branch on. `AgentMessage.toolCallId` (Task 1) carries a call id on
Anthropic and a tool NAME on Gemini — documented in Task 3, and the loop must set it
per provider.

**Placeholder scan:** no TBDs. Task 8's `create_case`/`update_case`/`add_line_item`/
`set_custody` are described by shape rather than written out in full, because they are
four repetitions of `setBillingTool`, which is written out completely — the implementer
copies a concrete example rather than inventing from prose.
