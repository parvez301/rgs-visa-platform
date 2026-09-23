import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPanelProvider } from "../../src/crm/agent/AgentPanelProvider";
import { ReviewPage } from "../../src/crm/review/ReviewPage";
import { AuthContext, type AuthState } from "../../src/lib/auth";

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  roles: ["Ops"],
  primaryRole: "Ops",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

interface LoggedRequest {
  method: string;
  url: string;
  body: any;
}

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

const GROUPS = [
  {
    reason: "UNMAPPED_PARTNER",
    fieldName: "REFRENCE",
    rawValue: "GALAXY",
    itemCount: 120,
    sampleCaseRefs: ["38001", "38002"],
  },
  {
    reason: "UNMAPPED_PARTNER",
    fieldName: "REFRENCE",
    rawValue: "C/A",
    itemCount: 3,
    sampleCaseRefs: ["38309"],
  },
  {
    reason: "PROPOSED_GROUP",
    fieldName: "REF NO.",
    rawValue: "38317, 38318",
    itemCount: 1,
    sampleCaseRefs: ["38317"],
  },
];

/**
 * A URL-routed `fetch` stub. `resolveResponses` are handed out in order to the
 * POSTs the apply loop makes, so a test can script "50 done, 70 left" and
 * watch the page keep going.
 */
function renderReviewPage(resolveResponses: unknown[] = []) {
  const requestLog: LoggedRequest[] = [];
  const remainingResolveResponses = [...resolveResponses];
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({
      method: requestMethod,
      url: requestUrl,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (requestUrl.endsWith("/review/groups")) {
      return jsonResponse(200, { groups: GROUPS, unreadableReviewItemIds: [] });
    }
    if (requestUrl.endsWith("/review/groups/resolve")) {
      return jsonResponse(200, remainingResolveResponses.shift() ?? { code: "UNEXPECTED" });
    }
    if (requestUrl.endsWith("/crm/partners")) {
      return jsonResponse(200, {
        partners: [{ partnerId: "partner_galaxy", canonicalName: "Galaxy Travels" }],
        unreadablePartnerIds: [],
      });
    }
    // The agent panel's own reads; nothing here asserts on them.
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>
        <AgentPanelProvider>
          <MemoryRouter initialEntries={["/crm/review"]}>
            <ReviewPage />
          </MemoryRouter>
        </AgentPanelProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { requestLog };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewPage", () => {
  it("lists reasons with their item counts and marks the ones the Ledger no longer badges", async () => {
    renderReviewPage();
    const partnerReason = await screen.findByRole("button", { name: /Partner not recognised/ });
    const reasonRail = screen.getByRole("navigation", { name: "Review reasons" });
    expect(partnerReason).toHaveTextContent("123");
    expect(partnerReason).toHaveAttribute("aria-pressed", "true");
    const groupReason = within(reasonRail).getByRole("button", { name: /May belong with another case/ });
    expect(groupReason).toHaveTextContent("Not shown on the Ledger");
    expect(partnerReason).not.toHaveTextContent("Not shown on the Ledger");
    expect(screen.getByText("124 open items, 3 distinct values")).toBeInTheDocument();
  });

  it("shows one row per raw value under the chosen reason, biggest first", async () => {
    renderReviewPage();
    await screen.findByText("GALAXY");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("GALAXY");
    expect(rows[0]).toHaveTextContent("120");
    expect(rows[1]).toHaveTextContent("C/A");
    expect(screen.queryByText("38317, 38318")).toBeNull();
  });

  it("applies a partner to the whole group in chunks until the server says nothing is left, then reports the total", async () => {
    const { requestLog } = renderReviewPage([
      { matchedCount: 120, resolvedCount: 50, appliedCount: 50, remainingCount: 70, failures: [] },
      { matchedCount: 70, resolvedCount: 50, appliedCount: 50, remainingCount: 20, failures: [] },
      { matchedCount: 20, resolvedCount: 20, appliedCount: 20, remainingCount: 0, failures: [] },
    ]);
    await screen.findByText("GALAXY");
    // One partner select per row, so the option appears once per group.
    expect((await screen.findAllByRole("option", { name: "Galaxy Travels" })).length).toBeGreaterThan(0);

    const applyButton = screen.getByRole("button", { name: "Apply to 120 cases" });
    expect(applyButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Value for GALAXY"), { target: { value: "partner_galaxy" } });
    fireEvent.click(applyButton);
    // A second click is the confirmation; nothing has been sent yet.
    expect(requestLog.filter((request) => request.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Yes, apply" }));

    await screen.findByText("Applied to 120 cases.");
    const resolveCalls = requestLog.filter((request) => request.method === "POST");
    expect(resolveCalls).toHaveLength(3);
    expect(resolveCalls[0]!.body).toEqual({
      reason: "UNMAPPED_PARTNER",
      fieldName: "REFRENCE",
      rawValue: "GALAXY",
      reviewStatus: "APPLIED",
      resolvedValue: "partner_galaxy",
      limit: 50,
    });
  });

  it("stops looping when a chunk makes no progress and names the cases that stay open", async () => {
    const { requestLog } = renderReviewPage([
      {
        matchedCount: 3,
        resolvedCount: 2,
        appliedCount: 0,
        remainingCount: 1,
        failures: [{ reviewItemId: "rev_1", caseRef: "38309", message: "No case is filed under REF 38309" }],
      },
      {
        matchedCount: 1,
        resolvedCount: 0,
        appliedCount: 0,
        remainingCount: 1,
        failures: [{ reviewItemId: "rev_1", caseRef: "38309", message: "No case is filed under REF 38309" }],
      },
    ]);
    await screen.findByText("C/A");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, dismiss" }));

    await screen.findByText("Dismissed 2 cases.");
    expect(screen.getAllByText(/stays open: No case is filed under REF 38309/).length).toBeGreaterThan(0);
    await waitFor(() => expect(requestLog.filter((request) => request.method === "POST")).toHaveLength(2));
  });

  it("never offers to dismiss a duplicate REF in bulk; those go to the ledger", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const groupsWithDuplicate = [
      { reason: "DUPLICATE_REF", fieldName: "REF NO.", rawValue: "38300", itemCount: 2, sampleCaseRefs: ["38300"] },
    ];
    const fetchMock = vi.fn((url: string) =>
      String(url).endsWith("/review/groups")
        ? jsonResponse(200, { groups: groupsWithDuplicate, unreadableReviewItemIds: [] })
        : jsonResponse(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AuthContext.Provider value={TEST_AUTH_STATE}>
        <QueryClientProvider client={queryClient}>
          <AgentPanelProvider>
            <MemoryRouter initialEntries={["/crm/review"]}>
              <ReviewPage />
            </MemoryRouter>
          </AgentPanelProvider>
        </QueryClientProvider>
      </AuthContext.Provider>,
    );
    expect(await screen.findByRole("link", { name: "Open on the ledger" })).toHaveAttribute("href", "/crm");
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });
});
