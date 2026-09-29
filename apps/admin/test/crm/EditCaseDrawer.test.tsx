import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import type { CaseView } from "../../src/crm/api/crmClient";
import { EditCaseDrawer } from "../../src/crm/case/EditCaseDrawer";

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

const CASE_VIEW: CaseView = {
  tenantId: "tenant_1",
  caseId: "case_1",
  caseRef: "38017",
  caseType: "VISA",
  partnerId: "ptn_1",
  destinationCountry: "JP",
  visaType: "TOURIST",
  caseStatus: "IN_PROGRESS",
  billingStatus: "UNBILLED",
  receivedDate: "2026-09-01",
  expectedCollectionDate: "2026-09-20",
  remarks: "call first",
  lineItems: [],
  totalInr: 0,
  applicants: [
    { applicantRef: "A1", travellerId: "trv_1", passportNumber: "P1111111", custody: "WITH_RGS", outcome: "PENDING" },
    { applicantRef: "A2", travellerId: "trv_2", custody: "WITH_RGS", outcome: "PENDING" },
  ],
  documentChecklist: [],
  watchdogOverrides: {},
  mutedRules: [],
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  travellers: { trv_1: { fullName: "ANIL SHARMA", passportNumber: "P1111111" }, trv_2: { fullName: "SITA SHARMA" } },
};

interface LoggedRequest {
  method: string;
  url: string;
  body: unknown;
}

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

/**
 * A URL-routed `fetch` stub. What matters here is which writes the drawer
 * makes, in what order, and with what body -- so every request is logged.
 */
function renderEditDrawer(options: { caseWriteStatus?: number; caseWriteMessage?: string } = {}) {
  const requestLog: LoggedRequest[] = [];
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const requestMethod = init.method ?? "GET";
    const requestUrl = String(url);
    requestLog.push({
      method: requestMethod,
      url: requestUrl,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (requestUrl.endsWith("/config/countries")) {
      return jsonResponse(200, {
        countryProducts: [{ countryCode: "JP", countryName: "Japan" }],
        unreadableCountryProductIds: [],
      });
    }
    if (requestMethod === "GET" && requestUrl.endsWith("/crm/partners")) {
      return jsonResponse(200, {
        partners: [{ partnerId: "ptn_1", canonicalName: "Skyline Travels" }],
        unreadablePartnerIds: [],
      });
    }
    if (requestMethod === "PUT" && requestUrl.endsWith("/cases/case_1") && options.caseWriteStatus !== undefined) {
      return jsonResponse(options.caseWriteStatus, {
        code: "CONFLICT",
        message: options.caseWriteMessage ?? "Refused",
      });
    }
    if (requestMethod === "PUT" || requestMethod === "POST" || requestMethod === "DELETE") {
      return jsonResponse(200, CASE_VIEW);
    }
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <AuthContext.Provider value={TEST_AUTH_STATE}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <EditCaseDrawer caseRecord={CASE_VIEW} onClose={onClose} />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { requestLog, onClose };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EditCaseDrawer", () => {
  it("pre-fills the form from the case", async () => {
    renderEditDrawer();
    expect(screen.getByLabelText("REF")).toHaveValue("38017");
    expect(screen.getByLabelText("Applicant 1 name")).toHaveValue("ANIL SHARMA");
  });

  it("saves only what changed: PUT case, then PUT applicant, in that order", async () => {
    const { requestLog, onClose } = renderEditDrawer();
    fireEvent.change(screen.getByLabelText("REF"), { target: { value: "38017-B" } });
    fireEvent.change(screen.getByLabelText("Applicant 1 REF NO"), { target: { value: "R-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const writes = requestLog.filter((request) => request.method !== "GET");
    expect(writes.map((request) => `${request.method} ${new URL(request.url, "http://x").pathname}`)).toEqual([
      "PUT /api/v1/admin/crm/cases/case_1",
      "PUT /api/v1/admin/crm/cases/case_1/applicants/A1",
    ]);
    expect(writes[0]?.body).toEqual({ caseRef: "38017-B" });
  });

  it("shows the server's 409 message and stays open when the REF is taken", async () => {
    const { onClose } = renderEditDrawer({
      caseWriteStatus: 409,
      caseWriteMessage: 'REF "38018" is already used by another case.',
    });
    fireEvent.change(screen.getByLabelText("REF"), { target: { value: "38018" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/REF "38018" is already used by another case\./)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing and says so when no field changed", async () => {
    const { requestLog } = renderEditDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
    expect(requestLog.filter((request) => request.method !== "GET")).toHaveLength(0);
  });
});
