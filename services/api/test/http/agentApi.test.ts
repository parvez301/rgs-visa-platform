import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { buildTestContext, type TestContext } from "../helpers";
import { Router } from "../../src/http/router";
import { AGENT_ROUTES, registerAgentRoutes } from "../../src/http/agentApi";
import { buildAdminRouter } from "../../src/http/adminApi";
import { FakeLlmProvider } from "../../src/agent/providers/fake";
import { mapMessagesToAnthropic } from "../../src/agent/providers/anthropic";
import { expectEveryToolResultPaired } from "../pairingWalkers";
import { readUserPrefs } from "../../src/agent/prefs";
import { getProposal, listPendingProposals, stageProposal, type ProposedChange } from "../../src/agent/approval";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { createCase, getCase } from "../../src/domain/crm/cases";
import { memoryPartitionKey } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { getMemoryOrUndefined, memoryScope, rememberMemory } from "../../src/domain/crm/memory";
import { PROPOSAL_SORT_KEY, proposalPartitionKey, proposalStatusGsi1Pk } from "../../src/domain/crm/keys";
import type { AppContext } from "../../src/lib/context";

const TENANT_ID = "rgs";
const ADMIN_EMAIL = "desk-admin@rgs.test";

function buildRouter(context: AppContext): Router {
  return registerAgentRoutes(new Router(), context);
}

function buildEvent(
  method: string,
  path: string,
  body?: unknown,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: "admin_1", email: ADMIN_EMAIL } } },
    },
    ...(queryStringParameters ? { queryStringParameters } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

// Mirrors crmApi.test.ts's buildUnauthenticatedEvent exactly -- no
// `authorizer` key at all, so the router's jwtClaims default to {} and
// callerId becomes "".
function buildUnauthenticatedEvent(
  method: string,
  path: string,
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function call(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEvent(method, path, body, query))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

async function callUnauthenticated(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildUnauthenticatedEvent(method, path, body))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

// A token with `sub` but no `email` claim -- router.ts defaults the missing
// claim to "", exactly as production API Gateway would for a Cognito token
// minted without one. B1/M3 (task-11-fix-1-review.md): the three routes that
// record an actor (turn, approve, discard) must refuse this rather than
// record decidedBy/proposedBy as "".
function buildEventNoEmailClaim(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: "admin_no_email" } } },
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function callNoEmailClaim(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEventNoEmailClaim(method, path, body))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

// {method}/{path} segments filled with an arbitrary non-empty value -- for
// dispatching AGENT_ROUTES generically through the real router without a
// route-by-route switch. What value fills a placeholder never matters to
// these tests: they assert only that the route is reachable/gated, not what
// a specific id resolves to.
function fillPathParams(pathTemplate: string): string {
  return pathTemplate.replace(/\{[^}]+\}/g, "x");
}

// caseRef doubles as the partner's name suffix -- mirrors loop.test.ts's and
// approval.test.ts's own seedOneCase, so two calls in one test do not trip
// createPartner's one-canonical-name-per-partner rule.
async function seedOneCase(context: TestContext, caseRef = "80001") {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: `Ozzy Travels ${caseRef}`, partnerType: "AGENCY" },
    ADMIN_EMAIL,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef,
      caseType: "VISA",
      visaType: "EVISA_TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    },
    ADMIN_EMAIL,
  );
}

function contextWithFakeLlm(context: TestContext, provider: FakeLlmProvider): TestContext & { llm: FakeLlmProvider } {
  return Object.assign(context, { llm: provider });
}

// task-11-fix-1-review.md C1/M4: before this, every describe block below
// dispatched through `buildRouter` -- a bare `registerAgentRoutes(new
// Router(), context)` -- never the real `buildAdminRouter` these routes are
// actually mounted on in production. The entire route table could be
// (and, when probed, was) dropped from `buildAdminRouter` with this whole
// suite staying green. `AGENT_ROUTES` is exported from agentApi.ts itself,
// derived from the same array that builds the router, so a route missing
// from `buildAdminRouter` has no way to also stay off this list.
describe("the agent route table, dispatched through the real buildAdminRouter", () => {
  it.each(AGENT_ROUTES)(
    "$method $path is actually mounted, not just registered on a bare router",
    async ({ method, path }) => {
      const context = buildTestContext();
      const router = buildAdminRouter(context);

      const response = await call(router, method, fillPathParams(path), {});

      // Not a specific status: an empty/placeholder-filled request legitimately
      // 400s on some routes and 404s on others (an unknown proposalId) and
      // 200s on others still. What every one of them must NOT be is the
      // router's OWN "nothing matched" answer -- that is the one signal that
      // would mean this route never actually reached buildAdminRouter.
      expect(response.payload.code).not.toBe("ROUTE_NOT_FOUND");
    },
  );

  // task-11-fix-2-brief.md A1/M4: AGENT_ROUTES is a DECLARATION of what this
  // task's table intends to expose -- fine for the dispatch test above,
  // which is exactly about that intent. It is the wrong thing to drive an
  // "every registered route requires admin" test from: a route registered
  // directly on the router, bypassing AGENT_ROUTE_DEFINITIONS entirely
  // (which is exactly what the re-review's probe did, and which left
  // 547/547 green), would never appear in AGENT_ROUTES and so would never
  // be walked here. Router.registeredRoutes reports what `add` was
  // ACTUALLY called with on a real `buildAdminRouter` -- built fresh here,
  // once, before either table-driven test below runs -- so this walks the
  // real thing, not a stand-in for it.
  const registeredAgentRoutes = buildAdminRouter(buildTestContext())
    .registeredRoutes.filter((route) => route.path.includes("/agent/"));

  it("registered at least the routes this task's own table declares (no silent drift in either direction)", () => {
    // The other half of "no silent drift": AGENT_ROUTES must not omit a
    // route the router actually has, and registeredAgentRoutes must not
    // gain one AGENT_ROUTES never named -- an eighth route added directly
    // via router.add, bypassing AGENT_ROUTE_DEFINITIONS, shows up here as
    // an extra entry.
    const sortKey = (route: { method: string; path: string }) => `${route.method} ${route.path}`;
    expect([...registeredAgentRoutes].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
      [...AGENT_ROUTES].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    );
  });

  it.each(registeredAgentRoutes)(
    "$method $path requires admin authentication on the real admin router",
    async ({ method, path }) => {
      const context = buildTestContext();
      const router = buildAdminRouter(context);

      const rejected = await callUnauthenticated(router, method, fillPathParams(path), {});

      expect(rejected.statusCode).toBe(403);
    },
  );
});

describe("POST /api/v1/admin/crm/agent/turn", () => {
  it("runs a full turn: reads a case, stages a write proposal, and returns every field of the result", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-TURN-01");
    const provider = new FakeLlmProvider([
      { text: "", toolCalls: [{ toolCallId: "c1", toolName: "get_case", input: { caseId: seededCase.caseId } }] },
      {
        text: "",
        toolCalls: [
          {
            toolCallId: "c2",
            toolName: "set_billing",
            input: { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
          },
        ],
      },
      {
        text: "Drafted the billing change for you to approve.",
        toolCalls: [],
        // Non-zero and distinct per field, deliberately -- a route that
        // always answered the zero default usage would pass a test that
        // only checked usage was present.
        usage: { inputTokens: 12, outputTokens: 7, cachedTokens: 2 },
      },
    ]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    // The body also carries a spoofed actorEmail -- proving the loop ran
    // under the verified admin caller, never this value (the same identity
    // rule controller-notes §1 states for approve, applied here too since
    // runAgentTurn's actorEmail drives who a staged proposal is filed
    // under).
    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "bill this case",
      actorEmail: "attacker@rgs.local",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.reply).toBe("Drafted the billing change for you to approve.");
    expect(response.payload.appliedChanges).toEqual([]);
    expect(response.payload.toolCallsMade).toEqual([
      { toolName: "get_case", kind: "read" },
      { toolName: "set_billing", kind: "write" },
    ]);
    expect(response.payload.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedTokens: 2 });
    expect(response.payload.proposals).toHaveLength(1);
    expect(response.payload.proposals[0].toolName).toBe("set_billing");
    expect(response.payload.proposals[0].status).toBe("PENDING");
    expect(response.payload.proposals[0].proposedBy).toBe(ADMIN_EMAIL);

    // Read the staged proposal back through the approval module directly,
    // independent of the HTTP response, so a route that merely echoed a
    // fabricated payload without actually staging anything cannot pass.
    const { proposals } = await listPendingProposals(context, TENANT_ID);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposedBy).toBe(ADMIN_EMAIL);
  });

  it("threads prior conversation into the messages sent to the model", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "continuing", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "continue",
      conversation: [
        { role: "user", content: "earlier message" },
        { role: "assistant", content: "earlier reply" },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(provider.receivedRequests).toHaveLength(1);
    expect(provider.receivedRequests[0]!.messages).toEqual([
      { role: "user", content: "earlier message" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "continue" },
    ]);
  });

  it("400s a conversation tool_result message that has no toolName, rather than crashing the provider adapter", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      conversation: [{ role: "tool_result", content: "some result", toolCallId: "c1" }],
    });

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  // Branch review C1, the route half. The loop now transmits the assistant
  // turn that MADE the tool calls, but a client replays history through this
  // route, and Zod's default "strip" mode silently drops any field the schema
  // does not declare -- so a schema with no `toolCalls` would quietly discard
  // the assistant turn's calls and hand the provider exactly the orphaned
  // tool_result the loop was fixed for. Asserted by the CONSEQUENCE (the
  // real Anthropic mapper produces a paired request), not merely by the
  // field surviving.
  it("carries a replayed assistant turn's toolCalls through to the model, so replayed results still pair", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "continuing", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "and now?",
      conversation: [
        { role: "user", content: "how many cases are open?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_replayed", toolName: "aggregate", input: { groupBy: "caseStatus" } }],
        },
        { role: "tool_result", content: '{"total":3}', toolCallId: "toolu_replayed", toolName: "aggregate" },
      ],
    });

    expect(response.statusCode).toBe(200);
    const sentMessages = provider.receivedRequests[0]!.messages;
    expect(sentMessages[1]).toMatchObject({
      role: "assistant",
      toolCalls: [{ toolCallId: "toolu_replayed", toolName: "aggregate", input: { groupBy: "caseStatus" } }],
    });

    const anthropicMessages = mapMessagesToAnthropic(sentMessages) as { role?: string; content?: unknown }[];
    const assistantBlocks = anthropicMessages
      .filter((message) => message.role === "assistant" && Array.isArray(message.content))
      .flatMap((message) => message.content as { type?: string; id?: string }[]);
    expect(assistantBlocks).toContainEqual({
      type: "tool_use",
      id: "toolu_replayed",
      name: "aggregate",
      input: { groupBy: "caseStatus" },
    });
  });

  it("400s toolCalls attached to a user message, which neither adapter would map", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      conversation: [
        {
          role: "user",
          content: "earlier",
          toolCalls: [{ toolCallId: "c1", toolName: "aggregate", input: {} }],
        },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("400s a body with no userMessage, not 500", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {});
    expect(response.statusCode).toBe(400);
  });

  it("400s when the context has no llm provider configured, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", { userMessage: "hi" });
    expect(response.statusCode).toBe(400);
  });

  // task-11-fix-1-review.md B1/M3: an admin token with `sub` but no `email`
  // claim used to reach runAgentTurn, which staged proposals under
  // `proposedBy: ""` only by accident (buildSystemPrompt's memoryScope("USER",
  // "") happened to throw). requireAdminEmail now refuses this deliberately,
  // before the model is ever called.
  it("refuses an admin token with no email claim, rather than staging a proposal under an empty actor", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await callNoEmailClaim(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
    });

    expect(response.statusCode).toBe(403);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  // Minor 3 (task-11-fix-1-review.md m3): model input billed by the token,
  // with nothing else in the stack capping message length or replayed
  // history -- MAX_TOOL_ITERATIONS (loop.ts) caps how many times one turn
  // calls the model, not how much is sent on any one call.
  it("400s a userMessage over the length cap, rather than paying to send it to the model", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      // One over MAX_USER_MESSAGE_LENGTH (agentApi.ts).
      userMessage: "x".repeat(8_001),
    });

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("400s a conversation longer than the message cap, rather than replaying it all into the model", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      // One over MAX_TURN_CONVERSATION_MESSAGES (agentApi.ts).
      conversation: Array.from({ length: 201 }, (_, index) => ({ role: "user", content: `msg ${index}` })),
    });

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  // NEW-2 (task-11-fix-2-brief.md B2): before this, `content` shared its cap
  // with `userMessage` (both MAX_TURN_MESSAGE_LENGTH = 8,000). loop.ts hands
  // `completion.text` straight back as `reply` with no cap of its own, and
  // the Anthropic adapter's own completion budget (DEFAULT_MAX_OUTPUT_TOKENS
  // = 4096 tokens, providers/anthropic.ts) can produce a reply well past
  // 8,000 characters. So the server could 200 with a `reply` that the very
  // same route would then 400 on if the caller sent it back as prior
  // conversation -- an un-continuable conversation, with the 400 naming
  // `conversation`, a field the user never typed into. This asserts the
  // invariant directly: generate the longest reply a real max-output
  // completion could plausibly produce, get it back from a live turn, then
  // replay it as conversation history on the next turn and confirm the
  // server accepts its own output.
  it("never emits a reply it will then refuse to accept back as conversation history", async () => {
    const context = buildTestContext();
    // 4096 tokens at roughly 4 characters/token (the brief's own estimate)
    // is ~16,000 characters -- a stand-in for the longest reply the
    // configured provider's completion budget could actually produce.
    const maximalReply = "r".repeat(16_000);
    const firstTurnProvider = new FakeLlmProvider([{ text: maximalReply, toolCalls: [] }]);
    const firstRouter = buildRouter(contextWithFakeLlm(context, firstTurnProvider));

    const firstResponse = await call(firstRouter, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "give me the longest answer you can",
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.payload.reply).toBe(maximalReply);

    const secondTurnProvider = new FakeLlmProvider([{ text: "continuing", toolCalls: [] }]);
    const secondRouter = buildRouter(contextWithFakeLlm(context, secondTurnProvider));

    const secondResponse = await call(secondRouter, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "go on",
      conversation: [{ role: "assistant", content: firstResponse.payload.reply }],
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondTurnProvider.receivedRequests).toHaveLength(1);
  });

  it("accepts a single conversation message's content well past the old shared cap, and still 400s one character over its own cap", async () => {
    const context = buildTestContext();

    // At MAX_CONVERSATION_MESSAGE_LENGTH (agentApi.ts) -- past the old
    // shared 8,000-char cap, proving `content` now has its own, larger
    // limit rather than reusing MAX_USER_MESSAGE_LENGTH.
    const acceptedProvider = new FakeLlmProvider([{ text: "ok", toolCalls: [] }]);
    const acceptedRouter = buildRouter(contextWithFakeLlm(context, acceptedProvider));
    const acceptedResponse = await call(acceptedRouter, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      conversation: [{ role: "user", content: "x".repeat(20_000) }],
    });
    expect(acceptedResponse.statusCode).toBe(200);
    expect(acceptedProvider.receivedRequests).toHaveLength(1);

    // One over that same cap.
    const rejectedProvider = new FakeLlmProvider([]);
    const rejectedRouter = buildRouter(contextWithFakeLlm(context, rejectedProvider));
    const rejectedResponse = await call(rejectedRouter, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      conversation: [{ role: "user", content: "x".repeat(20_001) }],
    });
    expect(rejectedResponse.statusCode).toBe(400);
    expect(rejectedProvider.receivedRequests).toHaveLength(0);
  });

  it("400s a conversation whose total content length exceeds the transcript-wide cap, even with every message under its own per-message cap", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    // 6 messages x 20,000 chars = 120,000, over MAX_TURN_CONVERSATION_TOTAL_LENGTH
    // (100,000) -- each individual message is at exactly the per-message cap,
    // so only a total-size check catches this.
    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
      conversation: Array.from({ length: 6 }, () => ({ role: "user" as const, content: "x".repeat(20_000) })),
    });

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  // Minor 4 (task-11-fix-1-review.md m4): router.ts's own JSON.parse failure
  // path (a malformed body, not merely a schema-violating one) had no test
  // anywhere in this file. `call`'s helper always JSON.stringifies its body
  // argument, so this constructs the event by hand to send a body that isn't
  // valid JSON at all.
  it("400s a malformed JSON body, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const event = {
      rawPath: "/api/v1/admin/crm/agent/turn",
      requestContext: {
        http: { method: "POST" },
        authorizer: { jwt: { claims: { sub: "admin_1", email: ADMIN_EMAIL } } },
      },
      body: "{not valid json",
    } as unknown as APIGatewayProxyEventV2;

    const response = (await router.dispatch(event)) as { statusCode: number; body: string };
    const payload = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(payload.message).toBe("Request body must be valid JSON");
  });

  it("rejects an unauthenticated caller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "hi",
    });
    expect(rejected.statusCode).toBe(403);
  });
});

describe("GET /api/v1/admin/crm/agent/proposals", () => {
  it("returns pending proposals and names unreadableProposalIds, never dropping a row that will not parse", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-PROP-01");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const healthy = await stageProposal(context, TENANT_ID, proposal);

    // A PENDING-indexed row whose body has lost `proposedBy` -- required by
    // ProposedChangeSchema, so this row cannot reassemble. Mirrors
    // approval.test.ts's own "prop_ghost" fixture.
    await context.table.put({
      PK: proposalPartitionKey(TENANT_ID, "prop_ghost"),
      SK: PROPOSAL_SORT_KEY,
      GSI1PK: proposalStatusGsi1Pk(TENANT_ID, "PENDING"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      proposalId: "prop_ghost",
      toolName: "set_billing",
      input: {},
      summary: [],
      status: "PENDING",
    });

    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/proposals");

    expect(response.statusCode).toBe(200);
    expect(response.payload.proposals.map((p: ProposedChange) => p.proposalId)).toEqual([healthy.proposalId]);
    expect(response.payload.unreadableProposalIds).toEqual(["prop_ghost"]);
  });

  it("rejects an unauthenticated caller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "GET", "/api/v1/admin/crm/agent/proposals");
    expect(rejected.statusCode).toBe(403);
  });
});

describe("PUT /api/v1/admin/crm/agent/proposals/{proposalId}/approve", () => {
  it("passes an edited body through to the applied change", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-01");
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, visaType: "TOURIST" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      // Deliberately a different visaType than what was staged (BUSINESS,
      // not the staged TOURIST) -- the edited value, not the model's
      // original proposal, must be what lands.
      { editedInput: { caseId: seededCase.caseId, visaType: "BUSINESS" } },
    );

    expect(response.statusCode).toBe(200);

    // Read the case back independently of the route's own response payload
    // -- the fixture (visaType) starts at EVISA_TOURIST, moves to BUSINESS
    // only if the edit really applied, so a route that silently used the
    // model's original TOURIST value (or did nothing) cannot pass this.
    const updatedCase = await getCase(context, TENANT_ID, seededCase.caseId);
    expect(updatedCase.visaType).toBe("BUSINESS");
  });

  it("never records the actor from the request body, only the verified admin caller", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-02");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      { actorEmail: "attacker@rgs.local" },
    );

    expect(response.statusCode).toBe(200);

    // Read the STORED row back through the approval module, not the HTTP
    // response, and assert it is neither undefined nor the spoofed value --
    // controller-notes §1's load-bearing test.
    const storedProposal = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(storedProposal?.decidedBy).toBe(ADMIN_EMAIL);
    expect(storedProposal?.decidedBy).not.toBe("attacker@rgs.local");
  });

  it("404s an approval of a proposal that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "PUT", "/api/v1/admin/crm/agent/proposals/prop_missing/approve", {});
    expect(response.statusCode).toBe(404);
  });

  // Branch review I4. `confirmedWithoutEditCount` was added to the shared
  // schema in this branch specifically to be the trust-ladder advancement
  // signal, and nothing anywhere wrote it -- Plan 5 would have inherited a
  // counter permanently at 0 and a "propose advancing this user" screen with
  // nothing to propose from. Asserted through the real route against the
  // stored prefs row, not against the counter function directly.
  it("counts an approval the human did not edit, as the trust-ladder advancement signal", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-COUNT-1");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    expect((await readUserPrefs(context, TENANT_ID, ADMIN_EMAIL)).confirmedWithoutEditCount).toBe(0);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      {},
    );
    expect(response.statusCode).toBe(200);

    const prefsAfterApproval = await readUserPrefs(context, TENANT_ID, ADMIN_EMAIL);
    expect(prefsAfterApproval.confirmedWithoutEditCount).toBe(1);
    // Counting a confirmation is NOT the same act as raising trust
    // (task-10-controller-notes.md §6): advancement stays opt-in and never
    // silent, so neither of these may move.
    expect(prefsAfterApproval.trustLevel).toBe(0);
    expect(prefsAfterApproval.autoApplyOptIn).toBe(false);
  });

  // The other direction, which is what makes the counter mean anything: an
  // approval carrying an edit is evidence the agent got it WRONG, and must
  // not be counted as evidence for trusting it more.
  it("does not count an approval the human edited", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-COUNT-2");
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, visaType: "TOURIST" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      { editedInput: { caseId: seededCase.caseId, visaType: "BUSINESS" } },
    );
    expect(response.statusCode).toBe(200);

    expect((await readUserPrefs(context, TENANT_ID, ADMIN_EMAIL)).confirmedWithoutEditCount).toBe(0);
  });

  it("rejects an unauthenticated caller and applies nothing", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-03");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const rejected = await callUnauthenticated(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      {},
    );
    expect(rejected.statusCode).toBe(403);

    // The second half of the claim: refused AND nothing moved. Read the
    // proposal back and confirm it is still exactly PENDING.
    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");
  });

  // task-11-fix-1-review.md B1/M3: the real security defect -- an admin
  // token with `sub` but no `email` claim used to approve with
  // `decidedBy: ""`, and the schema let that round-trip as a valid decision.
  it("refuses an admin token with no email claim, rather than approving with decidedBy \"\"", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-04");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await callNoEmailClaim(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      {},
    );

    expect(response.statusCode).toBe(403);

    // The second half: refused AND nothing moved.
    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");
  });

  // task-11-fix-1-review.md B3/M2: applyApprovedChange validates
  // editedInput/proposal.input unconditionally and answers badRequest on a
  // schema-violating shape -- but nothing at the HTTP layer had ever sent one
  // to prove the route actually surfaces that as a 400, not a 500.
  it("400s a non-object editedInput, rather than 500ing", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-05");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      { editedInput: "oops" },
    );

    expect(response.statusCode).toBe(400);

    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");
  });

  // task-11-fix-2-brief.md: the two-layer defense-in-depth question. Layer B
  // (approval.ts's applyApprovedChange, which builds `effectiveInput` as
  // `editedInput ?? proposal.input`) is already independently pinned -- `??`
  // treats `null` as nullish, so a Layer-B-only defect silently discards a
  // `null` edit and falls back to the model's original proposal.input rather
  // than refusing the request. This test pins Layer A instead: the HTTP body
  // schema itself (ApproveProposalBody's `editedInput`) must refuse `null`
  // as a 400, before applyApprovedChange is ever reached, so Layer A owns
  // its own pin rather than riding on Layer B's.
  it("400s an editedInput of null, rather than silently discarding the edit and applying the model's original proposal", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-APPR-06");
    const tool = new ToolRegistry(WRITE_TOOLS).get("update_case")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, visaType: "TOURIST" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/approve`,
      { editedInput: null },
    );

    expect(response.statusCode).toBe(400);

    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");

    // Nothing applied under the original proposal.input either -- a
    // Layer-A-only defect would still 400 (Layer B backstops it), but the
    // discriminating half of THIS test is the 400 itself: it must come from
    // parsing the body, not from applyApprovedChange ever running.
    const caseAfter = await getCase(context, TENANT_ID, seededCase.caseId);
    expect(caseAfter.visaType).toBe("EVISA_TOURIST");
  });
});

describe("PUT /api/v1/admin/crm/agent/proposals/{proposalId}/discard", () => {
  it("400s a discard with no reason, and leaves the proposal PENDING", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-DISC-01");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/discard`,
      {},
    );
    expect(response.statusCode).toBe(400);

    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");
  });

  it("discards a proposal with a reason, and records the reason on the stored row", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-DISC-02");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/discard`,
      { reason: "Billing already sent manually via email" },
    );
    expect(response.statusCode).toBe(200);

    const discarded = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(discarded?.status).toBe("DISCARDED");
    expect(discarded?.discardReason).toBe("Billing already sent manually via email");
    expect(discarded?.decidedBy).toBe(ADMIN_EMAIL);
  });

  // task-11-fix-1-review.md B2/M1: the approve route already pinned this
  // (the "never records the actor from the request body" test above);
  // discard had the identical hazard and no equivalent test.
  it("never records the actor from the request body, only the verified admin caller", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-DISC-04");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/discard`,
      { reason: "Billing already sent manually via email", actorEmail: "attacker@rgs.local" },
    );
    expect(response.statusCode).toBe(200);

    const discarded = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(discarded?.decidedBy).toBe(ADMIN_EMAIL);
    expect(discarded?.decidedBy).not.toBe("attacker@rgs.local");
  });

  // task-11-fix-1-review.md B1/M3.
  it("refuses an admin token with no email claim, rather than discarding with decidedBy \"\"", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-DISC-05");
    const tool = new ToolRegistry(WRITE_TOOLS).get("set_billing")!;
    const proposal = (await tool.execute(
      context,
      TENANT_ID,
      { caseId: seededCase.caseId, billingStatus: "BILL_SENT" },
      ADMIN_EMAIL,
    )) as ProposedChange;
    const staged = await stageProposal(context, TENANT_ID, proposal);

    const router = buildRouter(context);
    const response = await callNoEmailClaim(
      router,
      "PUT",
      `/api/v1/admin/crm/agent/proposals/${staged.proposalId}/discard`,
      { reason: "trying to sneak this through" },
    );

    expect(response.statusCode).toBe(403);

    const stillPending = await getProposal(context, TENANT_ID, staged.proposalId);
    expect(stillPending?.status).toBe("PENDING");
  });

  it("rejects an unauthenticated caller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(
      router,
      "PUT",
      "/api/v1/admin/crm/agent/proposals/prop_x/discard",
      { reason: "no" },
    );
    expect(rejected.statusCode).toBe(403);
  });
});

describe("GET /api/v1/admin/crm/agent/memories", () => {
  it("returns memories for the requested scope only", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-01");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "office-hours", text: "Desk is open 9-6 IST", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "my-note", text: "Prefers email over calls", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const orgResponse = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "ORG",
    });

    expect(orgResponse.statusCode).toBe(200);
    expect(orgResponse.payload.memories.map((m: { memoryKey: string }) => m.memoryKey)).toEqual([
      "office-hours",
    ]);
    expect(orgResponse.payload.unreadableMemoryKeys).toEqual([]);
  });

  it("resolves USER scope to the verified caller's own identity, isolating it from another user's", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-02");
    const otherUserEmail = "someone-else@rgs.test";
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", otherUserEmail), memoryKey: "their-note", text: "Only theirs", sourceCaseId: seededCase.caseId },
      "agent",
      otherUserEmail,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "my-note", text: "Only mine", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "USER",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.memories.map((m: { memoryKey: string }) => m.memoryKey)).toEqual(["my-note"]);
  });

  // task-11-fix-1-review.md C2/A2: the test above ("isolating it from another
  // user's") never sent a competing identity at all -- it proves the
  // partitioning works, not that identity can't be spoofed. recallMemories
  // deliberately trusts whatever scope it's handed (memory.ts's own comment),
  // so resolveAdminMemoryScope is the ENTIRE security boundary on this path.
  // Every plausible alias for "which user" is planted in the query string,
  // all pointed at the attacker's own scope.
  it("ignores a competing identity in the query string, and resolves USER scope to the verified caller regardless", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-07");
    const attackerEmail = "attacker@rgs.local";
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", attackerEmail), memoryKey: "their-note", text: "Not yours", sourceCaseId: seededCase.caseId },
      "agent",
      attackerEmail,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "my-note", text: "Really mine", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "USER",
      userEmail: attackerEmail,
      scopeKey: attackerEmail,
      actorEmail: attackerEmail,
      email: attackerEmail,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.memories.map((m: { memoryKey: string }) => m.memoryKey)).toEqual(["my-note"]);
  });

  it("400s an unrecognized scope kind rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "TENANT",
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s a PARTNER scope with no partnerId, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "PARTNER",
    });
    expect(response.statusCode).toBe(400);
  });

  // Minor 1 (task-11-fix-1-review.md m1): the only unreadableMemoryKeys
  // assertion in this file checked an empty default -- never a row that
  // actually names something. Mirrors memory.test.ts's own domain-level
  // "names a corrupt memory row" fixture, at the HTTP layer.
  it("names a corrupt memory row in unreadableMemoryKeys instead of 500ing the response", async () => {
    const context = buildTestContext();
    const scope = memoryScope("ORG");
    // A row DynamoDB could hold but CrmMemorySchema refuses -- no `text`, no
    // `createdAt`.
    await context.table.put({
      PK: memoryPartitionKey(TENANT_ID, scope),
      SK: "half-written",
      tenantId: TENANT_ID,
      scope,
      memoryKey: "half-written",
      createdBy: "agent",
    });

    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, { scope: "ORG" });

    expect(response.statusCode).toBe(200);
    expect(response.payload.memories).toEqual([]);
    expect(response.payload.unreadableMemoryKeys).toEqual(["half-written"]);
  });

  it("rejects an unauthenticated caller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "GET", "/api/v1/admin/crm/agent/memories");
    expect(rejected.statusCode).toBe(403);
  });
});

describe("POST /api/v1/admin/crm/agent/memories", () => {
  it("remembers a memory and stores it under the resolved scope", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-03");
    const router = buildRouter(context);

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/memories", {
      scope: "ORG",
      memoryKey: "office-hours",
      text: "Desk is open 9-6 IST",
      sourceCaseId: seededCase.caseId,
    });

    expect(response.statusCode).toBe(200);

    // Read back through the domain module directly, independent of the
    // route's own response payload.
    const stored = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(stored?.text).toBe("Desk is open 9-6 IST");
    expect(stored?.createdByEmail).toBe(ADMIN_EMAIL);
  });

  it("files a USER-scope memory under the verified caller's own identity, never a body-supplied one", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-04");
    const router = buildRouter(context);

    await call(router, "POST", "/api/v1/admin/crm/agent/memories", {
      scope: "USER",
      memoryKey: "my-note",
      text: "Prefers email over calls",
      sourceCaseId: seededCase.caseId,
    });

    const storedUnderCaller = await getMemoryOrUndefined(
      context,
      TENANT_ID,
      memoryScope("USER", ADMIN_EMAIL),
      "my-note",
    );
    expect(storedUnderCaller?.text).toBe("Prefers email over calls");

    const storedUnderSomeoneElse = await getMemoryOrUndefined(
      context,
      TENANT_ID,
      memoryScope("USER", "someone-else@rgs.test"),
      "my-note",
    );
    expect(storedUnderSomeoneElse).toBeUndefined();
  });

  // task-11-fix-1-review.md C2/A2: the test above never sent a competing
  // identity, so it never actually attempted the spoof. This one plants an
  // attacker identity under every plausible alias, in BOTH the body and the
  // query string, and proves both halves: the write lands under the verified
  // caller, and NOTHING is written under the spoofed identity's scope at all.
  it("ignores a competing identity in the body and query string, and files the memory under the verified caller only", async () => {
    const context = buildTestContext();
    const attackerEmail = "attacker@rgs.local";
    const router = buildRouter(context);

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/memories",
      {
        scope: "USER",
        memoryKey: "my-note",
        text: "Prefers email over calls",
        userEmail: attackerEmail,
        scopeKey: attackerEmail,
        actorEmail: attackerEmail,
        email: attackerEmail,
      },
      { userEmail: attackerEmail, scopeKey: attackerEmail, actorEmail: attackerEmail, email: attackerEmail },
    );

    expect(response.statusCode).toBe(200);

    const storedUnderCaller = await getMemoryOrUndefined(
      context,
      TENANT_ID,
      memoryScope("USER", ADMIN_EMAIL),
      "my-note",
    );
    expect(storedUnderCaller?.text).toBe("Prefers email over calls");

    // The other half of the claim: nothing at all landed under the spoofed
    // identity's own scope.
    const storedUnderAttacker = await getMemoryOrUndefined(
      context,
      TENANT_ID,
      memoryScope("USER", attackerEmail),
      "my-note",
    );
    expect(storedUnderAttacker).toBeUndefined();
  });

  // Group D / P62 (task-11-fix-1-review.md): rememberMemory now takes the
  // author kind as a required positional argument, and this route passes
  // "human" -- so an admin can file an org-wide policy note with no case to
  // cite it against. memory.test.ts already proves this at the domain layer;
  // this is the HTTP-level regression proving the fix actually reaches the
  // route.
  it("remembers an ORG-scope memory with no sourceCaseId, now that a human author does not need one", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/memories", {
      scope: "ORG",
      memoryKey: "no-case-policy",
      text: "Refunds always route through finance@rgs.test",
    });

    expect(response.statusCode).toBe(200);

    const stored = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "no-case-policy");
    expect(stored?.text).toBe("Refunds always route through finance@rgs.test");
    expect(stored?.createdBy).toBe("human");
    expect(stored?.sourceCaseId).toBeUndefined();
  });

  it("400s a body missing required fields, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "POST", "/api/v1/admin/crm/agent/memories", { scope: "ORG" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unauthenticated caller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "POST", "/api/v1/admin/crm/agent/memories", {
      scope: "ORG",
      memoryKey: "x",
      text: "y",
    });
    expect(rejected.statusCode).toBe(403);
  });
});

// Renamed from {memoryId} (task-11-fix-1-review.md rename): the path
// param's own name now matches what it actually carries.
describe("DELETE /api/v1/admin/crm/agent/memories/{memoryKey}", () => {
  it("forgets a memory that exists, and honestly reports { forgotten: true }", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-05");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "office-hours", text: "Desk is open 9-6 IST", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );
    // Prove it exists before deleting -- otherwise "gone afterwards" proves
    // nothing (forgetMemory is idempotent on a key that was never there).
    const beforeDelete = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(beforeDelete).toBeDefined();

    const router = buildRouter(context);
    const response = await call(
      router,
      "DELETE",
      "/api/v1/admin/crm/agent/memories/office-hours",
      undefined,
      { scope: "ORG" },
    );
    expect(response.statusCode).toBe(200);
    // Minor 2 (task-11-fix-1-review.md m2): this used to only check
    // statusCode, never the payload's own `.forgotten` value.
    expect(response.payload).toEqual({ forgotten: true });

    const afterDelete = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(afterDelete).toBeUndefined();
  });

  // Minor 2's other half: forgetMemory is deliberately idempotent, but the
  // response must say honestly that nothing changed rather than claim a
  // deletion that never happened.
  it("returns { forgotten: false } for a memory key nothing was ever remembered under", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);

    const response = await call(
      router,
      "DELETE",
      "/api/v1/admin/crm/agent/memories/never-remembered",
      undefined,
      { scope: "ORG" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ forgotten: false });
  });

  // task-11-fix-2-brief.md B1/NEW-1: m2's read-before-delete used to call
  // getMemoryOrUndefined, which THROWS on a row that will not parse -- so
  // GET named a corrupt row in unreadableMemoryKeys, and DELETE 409'd on
  // that exact same row, leaving it standing. Deleting is the remedy for a
  // corrupt row; it must not require the row to be readable first.
  it("deletes a corrupt memory row instead of 409ing on it, and the row is really gone afterward", async () => {
    const context = buildTestContext();
    const scope = memoryScope("ORG");
    // Same "half-written" fixture the m1 test uses -- no `text`, no
    // `createdAt`, so CrmMemorySchema refuses it.
    await context.table.put({
      PK: memoryPartitionKey(TENANT_ID, scope),
      SK: "half-written",
      tenantId: TENANT_ID,
      scope,
      memoryKey: "half-written",
      createdBy: "agent",
    });

    const router = buildRouter(context);
    const response = await call(
      router,
      "DELETE",
      "/api/v1/admin/crm/agent/memories/half-written",
      undefined,
      { scope: "ORG" },
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ forgotten: true });

    // Gone for good, not merely un-thrown-on: a direct raw read (never
    // parses, so it cannot itself throw on what should now be nothing)
    // confirms the row is actually removed.
    const rawRowAfterDelete = await context.table.get(memoryPartitionKey(TENANT_ID, scope), "half-written");
    expect(rawRowAfterDelete).toBeUndefined();
  });

  // task-11-fix-1-review.md C2/A2: same spoofing threat as GET/POST, on the
  // delete path. Proves both halves -- the caller's own copy is gone, and
  // the attacker's own copy (same memoryKey, different USER scope) survives
  // completely untouched.
  it("ignores a competing identity in the query string, and forgets only from the verified caller's own scope", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-08");
    const attackerEmail = "attacker@rgs.local";
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", attackerEmail), memoryKey: "shared-key", text: "Attacker's own note", sourceCaseId: seededCase.caseId },
      "agent",
      attackerEmail,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "shared-key", text: "Caller's own note", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const response = await call(
      router,
      "DELETE",
      "/api/v1/admin/crm/agent/memories/shared-key",
      undefined,
      { scope: "USER", userEmail: attackerEmail, scopeKey: attackerEmail, actorEmail: attackerEmail, email: attackerEmail },
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ forgotten: true });

    const callerCopy = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("USER", ADMIN_EMAIL), "shared-key");
    expect(callerCopy).toBeUndefined();

    const attackerCopy = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("USER", attackerEmail), "shared-key");
    expect(attackerCopy?.text).toBe("Attacker's own note");
  });

  // task-11-fix-1-review.md B3/M2.
  it("400s a missing scope query param, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "DELETE", "/api/v1/admin/crm/agent/memories/office-hours");
    expect(response.statusCode).toBe(400);
  });

  it("400s an invalid scope query param, rather than 500ing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "DELETE", "/api/v1/admin/crm/agent/memories/office-hours", undefined, {
      scope: "TENANT",
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unauthenticated caller and forgets nothing", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-06");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "office-hours", text: "Desk is open 9-6 IST", sourceCaseId: seededCase.caseId },
      "agent",
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "DELETE", "/api/v1/admin/crm/agent/memories/office-hours");
    expect(rejected.statusCode).toBe(403);

    const stillThere = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(stillThere).toBeDefined();
  });
});

/**
 * branch-fix re-review N1/N2/N6. The round that closed C1 widened
 * `AgentMessageBody` so a client CAN replay the assistant turn that made a
 * call. These are the three things that widening left open: an uncapped,
 * uncounted id; a replayed transcript that walks C1 straight back in through
 * the door the field opened; and the safety property nobody pinned -- that a
 * call a client puts in the transcript is history, never an instruction.
 */
describe("agent turn route: the replayed transcript is untrusted input", () => {
  function orphanReplayBody(conversation: unknown[]): Record<string, unknown> {
    return { userMessage: "and now?", conversation };
  }

  it("400s a tool_result naming a call no preceding assistant message carries -- C1, arriving from the client", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        { role: "user", content: "how many cases are open?" },
        { role: "tool_result", content: '{"total":3}', toolCallId: "toolu_orphan", toolName: "aggregate" },
      ]),
    );

    // Two halves, asserted separately: refused, AND nothing reached the model.
    // A 400 that still spent a provider call would not be a fix.
    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("400s a tool_result whose preceding assistant turn made a DIFFERENT call", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_one", toolName: "aggregate", input: { groupBy: "caseStatus" } }],
        },
        { role: "tool_result", content: '{"total":3}', toolCallId: "toolu_two", toolName: "aggregate" },
      ]),
    );

    expect(response.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("400s a tool_result with no toolCallId at all, rather than throwing out of the mapper as a 500", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_one", toolName: "aggregate", input: {} }],
        },
        { role: "tool_result", content: '{"total":3}', toolName: "aggregate" },
      ]),
    );

    expect(response.statusCode).toBe(400);
    // Named, not just refused: with only a status assertion this test passed
    // identically when the missing-toolCallId guard was deleted, because the
    // membership check below it refuses `undefined` too. Two guards, one
    // assertion, no way to tell them apart.
    expect(JSON.stringify(response.payload)).toContain("must carry toolCallId");
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("still accepts a well-formed replay, including two results batched behind one assistant turn", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "continuing", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        { role: "user", content: "how many cases are open?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { toolCallId: "toolu_a", toolName: "aggregate", input: { groupBy: "caseStatus" } },
            { toolCallId: "toolu_b", toolName: "aggregate", input: { groupBy: "billingStatus" } },
          ],
        },
        { role: "tool_result", content: '{"total":3}', toolCallId: "toolu_a", toolName: "aggregate" },
        { role: "tool_result", content: '{"total":4}', toolCallId: "toolu_b", toolName: "aggregate" },
      ]),
    );

    expect(response.statusCode).toBe(200);
    // N3: judged by the same walker the loop's own transcripts are judged by,
    // not by asserting a tool_use block is present -- presence is a weaker
    // claim than pairing, and it was the weaker one this route had.
    expectEveryToolResultPaired(provider.receivedRequests[0]!.messages, 2);
  });

  it("400s a toolCallId longer than the cap, on the call side and on the result side", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));
    // Just over the 256-character cap, and nowhere near the 100,000-character
    // total bound -- so the cap is the ONLY rule that can refuse this. At
    // 500,000 the total bound refused it too, and deleting the cap reddened
    // nothing.
    const oversizedId = "x".repeat(300);

    const onTheCall = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: oversizedId, toolName: "aggregate", input: {} }],
        },
      ]),
    );
    expect(onTheCall.statusCode).toBe(400);

    const onTheResult = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_a", toolName: "aggregate", input: {} }],
        },
        { role: "tool_result", content: "{}", toolCallId: oversizedId, toolName: "aggregate" },
      ]),
    );
    expect(onTheResult.statusCode).toBe(400);
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("counts toolCallId toward the conversation cost bound, not only content and input", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "should not be reached", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    // Every id is inside the per-id cap and every `content` is empty, so the
    // ONLY thing that can carry this conversation past the 100,000-character
    // total bound is the ids themselves being counted. 30 messages x 32 calls
    // x 256 chars = 245,760.
    const paddedId = (messageIndex: number, callIndex: number) =>
      `toolu_${messageIndex}_${callIndex}_`.padEnd(256, "x");
    const conversation = Array.from({ length: 30 }, (_unused, messageIndex) => ({
      role: "assistant",
      content: "",
      toolCalls: Array.from({ length: 32 }, (_alsoUnused, callIndex) => ({
        toolCallId: paddedId(messageIndex, callIndex),
        toolName: "aggregate",
        input: {},
      })),
    }));

    const response = await call(router, "POST", "/api/v1/admin/crm/agent/turn", orphanReplayBody(conversation));

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.payload)).toContain("total conversation content length");
    expect(provider.receivedRequests).toHaveLength(0);
  });

  it("counts a tool_result's own toolCallId too -- the call side alone stays under the bound", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "under the bound", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    // 11 messages x 32 calls x (256 id + 9 name + 2 input) = 93,984: under the
    // 100,000 bound on the call side alone. Echoing 24 of the last message's
    // ids back as results adds 24 x 256 = 6,144, which tips it to 100,128.
    // Pairing forces a result's id to equal its call's, so this two-step shape
    // is the only way to isolate the result side of the accounting at all.
    const paddedId = (messageIndex: number, callIndex: number) =>
      `toolu_${messageIndex}_${callIndex}_`.padEnd(256, "x");
    const assistantMessages = Array.from({ length: 11 }, (_unused, messageIndex) => ({
      role: "assistant",
      content: "",
      toolCalls: Array.from({ length: 32 }, (_alsoUnused, callIndex) => ({
        toolCallId: paddedId(messageIndex, callIndex),
        toolName: "aggregate",
        input: {},
      })),
    }));

    const withoutResults = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody(assistantMessages),
    );
    expect(withoutResults.statusCode).toBe(200);

    const echoedResults = Array.from({ length: 24 }, (_unused, callIndex) => ({
      role: "tool_result",
      content: "",
      toolCallId: paddedId(10, callIndex),
      toolName: "aggregate",
    }));
    const withResults = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([...assistantMessages, ...echoedResults]),
    );

    expect(withResults.statusCode).toBe(400);
    expect(JSON.stringify(withResults.payload)).toContain("total conversation content length");
  });

  it("treats a client-supplied toolCall as transcript only -- it is history, never an instruction to run anything", async () => {
    const context = buildTestContext();
    const provider = new FakeLlmProvider([{ text: "nothing to do", toolCalls: [] }]);
    const router = buildRouter(contextWithFakeLlm(context, provider));

    const response = await call(
      router,
      "POST",
      "/api/v1/admin/crm/agent/turn",
      orphanReplayBody([
        {
          role: "assistant",
          content: "",
          // A WRITE tool, replayed by the client as though the model had
          // already asked for it. The loop must read this as history and
          // dispatch nothing: no proposal staged, no write attempted.
          toolCalls: [
            {
              toolCallId: "toolu_write",
              toolName: "create_case",
              input: { partnerId: "p_injected", caseType: "VISA", destinationCountry: "AE" },
            },
          ],
        },
        { role: "tool_result", content: "ok", toolCallId: "toolu_write", toolName: "create_case" },
      ]),
    );

    expect(response.statusCode).toBe(200);
    const pendingProposals = await listPendingProposals(context, TENANT_ID);
    expect(pendingProposals.proposals).toHaveLength(0);
    const turnResult = response.payload as { proposals?: unknown[]; appliedChanges?: unknown[] };
    expect(turnResult.proposals ?? []).toHaveLength(0);
    expect(turnResult.appliedChanges ?? []).toHaveLength(0);
  });
});
