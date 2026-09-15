import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, Link } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { CrmLayout } from "../../src/crm/CrmLayout";
import { AgentPanel } from "../../src/crm/agent/AgentPanel";
import { AgentPanelProvider } from "../../src/crm/agent/AgentPanelProvider";
import type { AgentTurnResponse, ProposalView } from "../../src/crm/api/crmClient";

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

interface RequestLogEntry {
  method: string;
  url: string;
  body: any;
}

function buildTurnResult(reply: string, overrides: Partial<AgentTurnResponse> = {}): AgentTurnResponse {
  return {
    reply,
    proposals: [],
    appliedChanges: [],
    toolCallsMade: [{ toolName: "get_case", kind: "read" }],
    stoppedAtIterationCap: false,
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    ...overrides,
  };
}

function buildMemory(overrides: Partial<crm.CrmMemory> = {}): crm.CrmMemory {
  return {
    tenantId: "tenant_1",
    scope: "ORG",
    memoryKey: "billing_cutoff",
    text: "Skyline Travels is billed on the 1st of the month.",
    createdBy: "human",
    createdAt: "2026-03-01T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * Real hooks, real client, stubbed `fetch` -- `CasePage.test.tsx`'s pattern.
 * What this file is about is request PATHS and BODIES (the transcript that
 * goes back to the turn route, the scope a forget names), and a mocked hook
 * cannot be wrong about either, so it cannot prove either.
 */
function stubPanelFetch(
  options: {
    proposals?: ProposalView[];
    orgMemories?: crm.CrmMemory[];
    userMemories?: crm.CrmMemory[];
    turnOutcomes?: ({ ok: true; result: AgentTurnResponse } | { ok: false; status: number; message: string })[];
  } = {},
): RequestLogEntry[] {
  const requestLog: RequestLogEntry[] = [];
  const turnOutcomes = [...(options.turnOutcomes ?? [])];

  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({
      method: requestMethod,
      url: requestUrl,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    if (requestUrl.includes("/agent/turn")) {
      const nextOutcome = turnOutcomes.shift() ?? { ok: true as const, result: buildTurnResult("Alright.") };
      if (!nextOutcome.ok) {
        return Promise.resolve({
          ok: false,
          status: nextOutcome.status,
          json: async () => ({ code: "INTERNAL", message: nextOutcome.message }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => nextOutcome.result });
    }
    if (requestUrl.includes("/agent/proposals")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ proposals: options.proposals ?? [], unreadableProposalIds: [] }),
      });
    }
    if (requestUrl.includes("/agent/memories")) {
      if (requestMethod === "DELETE") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ forgotten: true }) });
      }
      const memories = requestUrl.includes("scope=USER")
        ? (options.userMemories ?? [])
        : (options.orgMemories ?? []);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ memories, unreadableMemoryKeys: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requestLog;
}

function renderUnderProviders(element: ReactElement, initialRoute = "/crm") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>
        <UndoToastProvider>
          <AgentPanelProvider>
            <MemoryRouter initialEntries={[initialRoute]}>{element}</MemoryRouter>
          </AgentPanelProvider>
        </UndoToastProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

function renderPanel(panel: ReactElement = <AgentPanel />) {
  return renderUnderProviders(panel);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentPanel", () => {
  it("says the trust level and that auto-apply is off, truthfully", () => {
    // Nothing in production writes CrmUserPrefs: trustLevel is 0 and
    // autoApplyOptIn is false for every user, and the panel says exactly that
    // rather than implying a ladder that has been climbed.
    stubPanelFetch();
    renderPanel();
    expect(screen.getByText(/level 0/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-apply is off/i)).toBeInTheDocument();
  });

  it("shows which remembered facts it used, each deletable in place (Memory in Motion)", async () => {
    // R58: the turn response carries NO per-turn citation list, so the panel
    // lists what is TRUE -- every ORG and USER memory, which `runAgentTurn`
    // injects into the system prompt on every turn (loop.ts:84-86) -- under a
    // heading that says so.
    const requestLog = stubPanelFetch({
      orgMemories: [buildMemory()],
      userMemories: [buildMemory({ scope: "USER#agent@example.com", memoryKey: "my_shorthand", text: "REF means case reference." })],
    });
    renderPanel();

    expect(await screen.findByText(/Skyline Travels is billed on the 1st of the month\./)).toBeInTheDocument();
    expect(await screen.findByText(/REF means case reference\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /forget billing_cutoff/i }));

    await waitFor(() =>
      expect(
        requestLog.some(
          (entry) =>
            entry.method === "DELETE" && entry.url.includes("/agent/memories/billing_cutoff?scope=ORG"),
        ),
      ).toBe(true),
    );
  });

  it("says what the remembered facts actually are, not that the turn cited them", async () => {
    // The wrong sentence here ("the agent used these on this turn") is a claim
    // the response cannot support. R58 pins the honest one.
    stubPanelFetch({ orgMemories: [buildMemory()] });
    renderPanel();
    expect(await screen.findByText(/on every turn/i)).toBeInTheDocument();
  });

  it("says the turn was cut short when the loop hit its cap", () => {
    stubPanelFetch();
    renderPanel(<AgentPanel initialResult={{ ...buildTurnResult(""), stoppedAtIterationCap: true }} />);
    expect(screen.getByText(/stopped after 8 rounds/i)).toBeInTheDocument();
  });

  it("shows what the agent was attempting when a turn fails, not a bare error", async () => {
    stubPanelFetch({
      turnOutcomes: [
        { ok: true, result: buildTurnResult("412 are open.") },
        { ok: false, status: 500, message: "The agent provider is unavailable" },
      ],
    });
    renderPanel();

    await userEvent.type(screen.getByLabelText(/ask the agent/i), "how many cases are open?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("412 are open.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/ask the agent/i), "and how many are overdue?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // The message that failed, still on screen, with the failure attached to
    // it -- and the tools the agent had already used this session named, so a
    // desk agent can see how far it got before the turn died.
    expect(await screen.findByText("and how many are overdue?")).toBeInTheDocument();
    expect(await screen.findByText(/The agent provider is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/get_case/)).toBeInTheDocument();
  });

  it("sends the pending user turn once, as userMessage, never also inside conversation", async () => {
    // The transcript contract, end to end through the real client: the route
    // takes `userMessage` separately from `conversation`, so a panel that put
    // the pending turn in both would replay it to the model twice.
    const requestLog = stubPanelFetch({
      turnOutcomes: [
        { ok: true, result: buildTurnResult("412 are open.") },
        { ok: true, result: buildTurnResult("19 are overdue.") },
      ],
    });
    renderPanel();

    await userEvent.type(screen.getByLabelText(/ask the agent/i), "how many cases are open?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("412 are open.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/ask the agent/i), "and how many are overdue?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("19 are overdue.")).toBeInTheDocument();

    const turnRequests = requestLog.filter((entry) => entry.url.includes("/agent/turn"));
    expect(turnRequests[0]!.body).toEqual({ userMessage: "how many cases are open?", conversation: [] });
    expect(turnRequests[1]!.body).toEqual({
      userMessage: "and how many are overdue?",
      conversation: [
        { role: "user", content: "how many cases are open?" },
        { role: "assistant", content: "412 are open." },
      ],
    });
  });

  it("is never a modal: the ledger stays interactive while the panel is open", async () => {
    stubPanelFetch();
    const ledgerClick = vi.fn();
    const { container } = renderUnderProviders(
      <CrmLayout agentPanel={<AgentPanel />}>
        <button type="button" onClick={ledgerClick}>
          A ledger control
        </button>
      </CrmLayout>,
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("[aria-modal]")).toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "A ledger control" }));
    expect(ledgerClick).toHaveBeenCalledTimes(1);
  });

  it("inherits the current selection", () => {
    stubPanelFetch();
    renderPanel(<AgentPanel selectedCaseIds={["case_1", "case_2"]} />);
    expect(screen.getByText(/2 cases selected/i)).toBeInTheDocument();
  });

  it("keeps the conversation when the desk agent walks from the Ledger to a case (R63)", async () => {
    // `CrmLayout` is rendered per page, so a transcript owned by the panel
    // would be wiped by every REF click. It lives in the provider above the
    // routes instead, and this is what proves it.
    stubPanelFetch({ turnOutcomes: [{ ok: true, result: buildTurnResult("412 are open.") }] });
    renderUnderProviders(
      <Routes>
        <Route
          path="/crm"
          element={
            <div>
              <Link to="/crm/cases/case_1">Open case</Link>
              <AgentPanel />
            </div>
          }
        />
        <Route path="/crm/cases/:caseId" element={<AgentPanel selectedCaseIds={["case_1"]} />} />
      </Routes>,
    );

    await userEvent.type(screen.getByLabelText(/ask the agent/i), "how many cases are open?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText("412 are open.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Open case" }));

    expect(screen.getByText("412 are open.")).toBeInTheDocument();
    expect(screen.getByText("how many cases are open?")).toBeInTheDocument();
  });
});

describe("CrmLayout's agent column", () => {
  it("renders the panel it is given instead of a placeholder", () => {
    stubPanelFetch();
    renderUnderProviders(
      <CrmLayout agentPanel={<AgentPanel />}>
        <p>The ledger</p>
      </CrmLayout>,
    );
    expect(screen.queryByText(/arrives in a later task/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/ask the agent/i)).toBeInTheDocument();
  });

  it("collapses the column and keeps the toggle reachable", async () => {
    stubPanelFetch();
    renderUnderProviders(
      <CrmLayout agentPanel={<AgentPanel />}>
        <p>The ledger</p>
      </CrmLayout>,
    );

    await userEvent.click(screen.getByRole("button", { name: /hide the agent panel/i }));
    expect(screen.queryByLabelText(/ask the agent/i)).not.toBeInTheDocument();

    const showAgain = screen.getByRole("button", { name: /show the agent panel/i });
    await userEvent.click(showAgain);
    expect(screen.getByLabelText(/ask the agent/i)).toBeInTheDocument();
  });
});

describe("the panel's proposal wiring", () => {
  it("approves through the route the client actually calls, and clears the card", async () => {
    const pendingProposal: ProposalView = {
      proposalId: "prop_1",
      toolName: "set_custody",
      input: { caseId: "case_1", applicantRef: "A1", custody: "AT_EMBASSY" },
      summary: [{ field: "applicants.A1.custody", from: "WITH_RGS", to: "AT_EMBASSY" }],
      caseId: "case_1",
      proposedBy: "agent@example.com",
      proposedAt: "2026-03-04T10:00:00.000Z",
      status: "PENDING",
    };
    const requestLog = stubPanelFetch({ proposals: [pendingProposal] });
    renderPanel();

    const card = await screen.findByLabelText("Proposed changes");
    await userEvent.click(within(card).getByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(
        requestLog.some(
          (entry) =>
            entry.method === "PUT" && entry.url.includes("/agent/proposals/prop_1/approve"),
        ),
      ).toBe(true),
    );
  });

  it("names the proposals that could not be read rather than dropping them silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/agent/proposals")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ proposals: [], unreadableProposalIds: ["prop_9"] }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ memories: [], unreadableMemoryKeys: [] }) });
      }),
    );
    renderPanel();

    expect(await screen.findByText(/1 proposal could not be read/i)).toBeInTheDocument();
  });
});
