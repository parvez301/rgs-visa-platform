import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { buildTestContext, type TestContext } from "../helpers";
import { Router } from "../../src/http/router";
import { registerAgentRoutes } from "../../src/http/agentApi";
import { FakeLlmProvider } from "../../src/agent/providers/fake";
import { getProposal, listPendingProposals, stageProposal, type ProposedChange } from "../../src/agent/approval";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { WRITE_TOOLS } from "../../src/agent/tools/writeTools";
import { createCase, getCase } from "../../src/domain/crm/cases";
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
      ADMIN_EMAIL,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "my-note", text: "Prefers email over calls", sourceCaseId: seededCase.caseId },
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
      otherUserEmail,
    );
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("USER", ADMIN_EMAIL), memoryKey: "my-note", text: "Only mine", sourceCaseId: seededCase.caseId },
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/agent/memories", undefined, {
      scope: "USER",
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

describe("DELETE /api/v1/admin/crm/agent/memories/{memoryId}", () => {
  it("forgets a memory that exists", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-05");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "office-hours", text: "Desk is open 9-6 IST", sourceCaseId: seededCase.caseId },
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

    const afterDelete = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(afterDelete).toBeUndefined();
  });

  it("rejects an unauthenticated caller and forgets nothing", async () => {
    const context = buildTestContext();
    const seededCase = await seedOneCase(context, "AGT-MEM-06");
    await rememberMemory(
      context,
      TENANT_ID,
      { scope: memoryScope("ORG"), memoryKey: "office-hours", text: "Desk is open 9-6 IST", sourceCaseId: seededCase.caseId },
      ADMIN_EMAIL,
    );

    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "DELETE", "/api/v1/admin/crm/agent/memories/office-hours");
    expect(rejected.statusCode).toBe(403);

    const stillThere = await getMemoryOrUndefined(context, TENANT_ID, memoryScope("ORG"), "office-hours");
    expect(stillThere).toBeDefined();
  });
});
