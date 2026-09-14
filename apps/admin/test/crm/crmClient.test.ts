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

    const load = await crmClient.loadLedger("token-1", {});

    expect(load.rows.map((row) => row.caseId)).toEqual(["case_1", "case_2"]);
    expect(load.unreadableCaseIds).toEqual(["case_bad"]);
    expect(load.truncated).toBe(false);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.url).toContain("cursor=cursor-2");
    expect(recorded[0]!.authorization).toBe("Bearer token-1");
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
});

describe("crmClient write methods", () => {
  it("PUTs a case status to the status route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setCaseStatus("token-1", "case_1", "SUBMITTED");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/status"),
      method: "PUT",
      body: { toStatus: "SUBMITTED" },
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

  it("PUTs a review resolution, not POSTs it", async () => {
    // Spec §7 says POST; crmApi.ts registers PUT and the API Gateway admin
    // route declares no PATCH. A POST here is a 404 in production that no
    // mocked test would catch, so the method is asserted explicitly.
    const recorded = stubFetch([{ reviewItemId: "rev_1" }]);

    await crmClient.resolveReviewItem("token-1", "rev_1", { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" });

    expect(recorded[0]!.method).toBe("PUT");
    expect(recorded[0]!.url).toContain("/api/v1/admin/crm/review/rev_1/resolve");
  });

  it("PUTs a proposal approval, not POSTs it", async () => {
    const recorded = stubFetch([{ proposalId: "prop_1" }]);

    await crmClient.approveProposal("token-1", "prop_1");

    expect(recorded[0]!.method).toBe("PUT");
    expect(recorded[0]!.url).toContain("/api/v1/admin/crm/agent/proposals/prop_1/approve");
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
