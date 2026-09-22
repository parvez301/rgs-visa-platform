import { describe, expect, it, vi } from "vitest";
import { crmClient } from "../../src/crm/api/crmClient";

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

function stubFetch(responses: unknown[]): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  let responseIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      recorded.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const payload = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
  return recorded;
}

const oneRow = {
  caseId: "case_1",
  caseRef: "RGS-1001",
  partnerId: "partner_1",
  destinationCountry: "AE",
  caseType: "VISA",
  caseStatus: "NEW",
  billingStatus: "UNBILLED",
  receivedDate: "2026-03-04",
  totalInr: 12000,
  updatedAt: "2026-03-04T10:00:00.000Z",
};

describe("crmClient.loadLedger", () => {
  it("follows the cursor to the end and concatenates every page", async () => {
    const recorded = stubFetch([
      { rows: [oneRow], unreadableCaseIds: [], nextCursor: "cursor-2", appliedQuery: { statuses: [], limit: 500 } },
      { rows: [{ ...oneRow, caseId: "case_2" }], unreadableCaseIds: ["case_bad"], appliedQuery: { statuses: [], limit: 500 } },
    ]);

    const pageSnapshots: string[][] = [];
    const load = await crmClient.loadLedger("token-1", {}, {
      onPage(partialLoad) {
        pageSnapshots.push(partialLoad.rows.map((row) => row.caseId));
      },
    });

    expect(load.rows.map((row) => row.caseId)).toEqual(["case_1", "case_2"]);
    expect(load.unreadableCaseIds).toEqual(["case_bad"]);
    expect(load.truncated).toBe(false);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.url).toContain("cursor=cursor-2");
    expect(recorded[0]!.authorization).toBe("Bearer token-1");
    expect(pageSnapshots).toEqual([["case_1"], ["case_1", "case_2"]]);
  });

  // F4: the `rows` test above proves accumulation because case_1 only exists
  // on page one -- an overwrite bug there would drop it. `unreadableCaseIds`
  // needs the identical shape of proof: both pages must contribute a
  // DIFFERENT id, or an overwrite bug (keep only the last page) would still
  // pass a single-id assertion by coincidence.
  it("accumulates unreadableCaseIds across pages, not just the last one", async () => {
    const recorded = stubFetch([
      { rows: [oneRow], unreadableCaseIds: ["case_bad_1"], nextCursor: "cursor-2", appliedQuery: { statuses: [], limit: 500 } },
      { rows: [{ ...oneRow, caseId: "case_2" }], unreadableCaseIds: ["case_bad_2"], appliedQuery: { statuses: [], limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", {});

    expect(load.unreadableCaseIds).toEqual(["case_bad_1", "case_bad_2"]);
    expect(recorded).toHaveLength(2);
  });

  it("stops at the page cap and says it stopped", async () => {
    // A server that always returns a cursor. Without a cap this loops until
    // the tab dies; without the flag the screen shows part of the ledger and
    // looks complete.
    const recorded = stubFetch([
      { rows: [oneRow], unreadableCaseIds: [], nextCursor: "always", appliedQuery: { statuses: [], limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", {});

    expect(load.truncated).toBe(true);
    expect(recorded.length).toBeLessThanOrEqual(40);
  });

  it("joins repeated statuses with commas, the way API Gateway delivers them", async () => {
    const recorded = stubFetch([{ rows: [], unreadableCaseIds: [], appliedQuery: { statuses: [], limit: 500 } }]);

    await crmClient.loadLedger("token-1", { statuses: ["NEW", "SUBMITTED"] });

    expect(recorded[0]!.url).toContain("status=NEW%2CSUBMITTED");
  });

  // F1: `appliedQuery` is a union, not a both-optional object -- the server
  // sends `partnerId` and `statuses` as mutually exclusive keys
  // (crmApi.ts:251). Status mode must carry `statuses` and MUST NOT carry a
  // `partnerId` key at all.
  it("returns the server's status-mode appliedQuery, with no partnerId key", async () => {
    stubFetch([
      { rows: [], unreadableCaseIds: [], appliedQuery: { statuses: ["NEW"], limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", { statuses: ["NEW"] });

    expect(load.appliedQuery).toEqual({ statuses: ["NEW"], limit: 500 });
    expect("partnerId" in load.appliedQuery).toBe(false);
  });

  // F1: the reverse of the test above -- partner mode must carry `partnerId`
  // and MUST NOT carry a `statuses` key, because the server does not apply
  // (and therefore does not echo back) a status filter in partner mode.
  it("returns the server's partner-mode appliedQuery, with no statuses key", async () => {
    stubFetch([
      { rows: [], unreadableCaseIds: [], appliedQuery: { partnerId: "partner_1", limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", { partnerId: "partner_1" });

    expect(load.appliedQuery).toEqual({ partnerId: "partner_1", limit: 500 });
    expect("statuses" in load.appliedQuery).toBe(false);
  });
});

describe("crmClient write methods", () => {
  it("PUTs case details to the case route, with the edited fields as the body", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.updateCaseDetails("token-1", "case_1", {
      visaType: "TOURIST",
      appointmentDate: "2026-04-01",
    });

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1"),
      method: "PUT",
      body: { visaType: "TOURIST", appointmentDate: "2026-04-01" },
    });
  });

  it("PUTs a case status to the status route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setCaseStatus("token-1", "case_1", "SUBMITTED");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/status"),
      method: "PUT",
      body: { toStatus: "SUBMITTED" },
    });
  });

  it("PUTs a billing status to the billing route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setBillingStatus("token-1", "case_1", "BILL_SENT");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/billing"),
      method: "PUT",
      body: { toBillingStatus: "BILL_SENT" },
    });
  });

  it("PUTs custody to the per-applicant route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setCustody("token-1", "case_1", "A1", "AT_EMBASSY");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/applicants/A1/custody"),
      method: "PUT",
      body: { toCustody: "AT_EMBASSY" },
    });
  });

  it("PUTs outcome to the per-applicant route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setOutcome("token-1", "case_1", "A1", "APPROVED");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/applicants/A1/outcome"),
      method: "PUT",
      body: { toOutcome: "APPROVED" },
    });
  });

  // F3: this used to assert only method and url. The reviewer mutated the
  // client to drop `resolvedValue` from the body and the suite stayed green
  // -- a resolve that silently drops it applies the review item with no
  // value and reports success, discarding the operator's correction.
  it("PUTs a review resolution, not POSTs it, with the full resolution as the body", async () => {
    // Spec §7 says POST; crmApi.ts registers PUT and the API Gateway admin
    // route declares no PATCH. A POST here is a 404 in production that no
    // mocked test would catch, so the method is asserted explicitly.
    const recorded = stubFetch([{ reviewItemId: "rev_1" }]);

    await crmClient.resolveReviewItem("token-1", "rev_1", {
      reviewStatus: "APPLIED",
      resolvedValue: "IN_PROGRESS",
    });

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/review/rev_1/resolve"),
      method: "PUT",
      body: { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" },
    });
  });

  // F3: this used to call approveProposal with no editedInput and assert
  // only method and url. The reviewer renamed `editedInput` to `edited` in
  // the body and the suite stayed green -- a renamed field means an approval
  // silently sends the agent's original proposal instead of the human's
  // edit, the exact failure spec §4's ceremony is built to prevent.
  it("PUTs a proposal approval, not POSTs it, with editedInput as the body", async () => {
    const recorded = stubFetch([{ proposalId: "prop_1" }]);

    await crmClient.approveProposal("token-1", "prop_1", { toStatus: "SUBMITTED" });

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/agent/proposals/prop_1/approve"),
      method: "PUT",
      body: { editedInput: { toStatus: "SUBMITTED" } },
    });
  });

  // F2: discardProposal had zero coverage -- no method, no path, no body --
  // even though it is one of the three routes the route table exists for
  // (spec text says POST, the code registers PUT at agentApi.ts:400).
  it("PUTs a proposal discard, not POSTs it, with the reason as the body", async () => {
    const recorded = stubFetch([{ proposalId: "prop_1", status: "DISCARDED" }]);

    await crmClient.discardProposal("token-1", "prop_1", "Wrong case matched");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/agent/proposals/prop_1/discard"),
      method: "PUT",
      body: { reason: "Wrong case matched" },
    });
  });

  it("POSTs an agent turn with the user message and conversation as the body", async () => {
    const recorded = stubFetch([
      {
        reply: "Understood.",
        proposals: [],
        appliedChanges: [],
        toolCallsMade: [],
        stoppedAtIterationCap: false,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      },
    ]);
    const conversation = [{ role: "user" as const, content: "hi" }];

    await crmClient.runAgentTurn("token-1", { userMessage: "What's the status?", conversation });

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/agent/turn"),
      method: "POST",
      body: { userMessage: "What's the status?", conversation },
    });
  });

  it("surfaces the API's own error code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: "CONFLICT", message: "Cannot move a case from CLOSED to NEW" }),
      }) as Response),
    );

    await expect(crmClient.setCaseStatus("token-1", "case_1", "NEW")).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: "Cannot move a case from CLOSED to NEW",
    });
  });
});

describe("crmClient.forgetMemory", () => {
  it("encodes the memory key into one path segment, so a key with a slash still reaches its route (R80)", async () => {
    // Finding #9. `memoryKey` is the one free-text segment in this client --
    // `CrmMemorySchema` declares it `z.string().min(1)` and the agent's own
    // `remember` tool authors it. Unencoded, "billing/cutoff#1" adds a path
    // segment (which `Router.match`'s segment-count guard drops) and truncates
    // the rest at the "#", so the Forget button 404s in deployed API Gateway
    // and never in a test, where every fixture key is `billing_cutoff`.
    const recorded = stubFetch([{ forgotten: true }]);

    await crmClient.forgetMemory("token-1", "billing/cutoff#1", "ORG");

    const requestedUrl = recorded[0]!.url;
    expect(requestedUrl).toContain("/agent/memories/billing%2Fcutoff%231");
    // Named separately, because each is a different failure: an extra segment
    // is a route miss, and a fragment is a silently truncated URL.
    expect(requestedUrl).not.toContain("/agent/memories/billing/cutoff");
    expect(requestedUrl).not.toContain("#");
    // The query string still has to arrive -- the route reads `scope` from it,
    // and encoding the segment must not have swallowed the "?".
    expect(requestedUrl).toContain("?scope=ORG");
    expect(recorded[0]!.method).toBe("DELETE");
  });
});

describe("crmClient.listMemories", () => {
  // F5: `recallMemories` (memory.ts) returns `{ memories, unreadableMemoryKeys }`
  // and the client's own type used to narrow that down to `{ memories }`,
  // making this the only listing in the client that could not surface an
  // unreadable-row warning the way listPartners/listProposals/
  // fetchReviewSummary all can.
  it("passes unreadableMemoryKeys through, not just memories", async () => {
    stubFetch([{ memories: [], unreadableMemoryKeys: ["mem_bad"] }]);

    const listing = await crmClient.listMemories("token-1", "ORG");

    expect(listing.unreadableMemoryKeys).toEqual(["mem_bad"]);
  });
});
