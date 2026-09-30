import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { StatusEmailsPage } from "../../src/crm/statusEmails/StatusEmailsPage";
import { AuthContext, type AuthState } from "../../src/lib/auth";

function authStateFor(primaryRole: "Owner" | "Viewer"): AuthState {
  return {
    isLoading: false,
    isSignedIn: true,
    email: "agent@example.com",
    idToken: "test-id-token",
    roles: [primaryRole],
    primaryRole,
    needsNewPassword: false,
    signIn: async () => "signedIn",
    completeNewPassword: async () => {},
    signOut: () => {},
  };
}

interface LoggedRequest {
  method: string;
  url: string;
  body: any;
}

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

function templateFor(caseStatus: crm.CaseStatus, overrides: Partial<crm.StatusEmailTemplate> = {}) {
  return {
    tenantId: "tenant_1",
    caseStatus,
    subject: `{{applicationId}} – ${caseStatus} – {{clientName}}`,
    body: "Dear {{clientName}},\n\nYour {{countryVisaType}} application {{applicationId}} moved on.\n\nCall {{phone}}",
    enabled: true,
    updatedAt: "1970-01-01T00:00:00.000Z",
    updatedBy: "",
    ...overrides,
  };
}

function renderStatusEmailsPage(primaryRole: "Owner" | "Viewer" = "Owner") {
  const requestLog: LoggedRequest[] = [];
  const templates = crm.CASE_STATUSES.map((caseStatus) =>
    caseStatus === "SUBMITTED" ? templateFor(caseStatus, { enabled: false }) : templateFor(caseStatus),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      const requestUrl = String(url);
      const requestMethod = init.method ?? "GET";
      requestLog.push({
        method: requestMethod,
        url: requestUrl,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (requestUrl.endsWith("/status-email-templates")) return jsonResponse(200, { templates });
      if (requestUrl.endsWith("/reset")) {
        return jsonResponse(200, templateFor("NEW", { subject: "Default subject", body: "Default body" }));
      }
      if (requestMethod === "PUT") {
        return jsonResponse(200, templateFor("NEW", { updatedBy: "agent@example.com" }));
      }
      return jsonResponse(200, {});
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <AuthContext.Provider value={authStateFor(primaryRole)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/crm/status-emails"]}>
          <StatusEmailsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { requestLog };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StatusEmailsPage", () => {
  it("lists every case status by its label with whether the email is on", async () => {
    renderStatusEmailsPage();
    const submittedRow = (await screen.findByText("Application Submitted")).closest("tr")!;
    expect(submittedRow).toHaveTextContent("Off");
    const newRow = screen.getByText("Application Received").closest("tr")!;
    expect(newRow).toHaveTextContent("On");
    expect(screen.getAllByRole("row")).toHaveLength(crm.CASE_STATUSES.length + 1);
  });

  it("opens a row in a drawer with a preview filled from sample values", async () => {
    renderStatusEmailsPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open Application Received" }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByLabelText("Subject")).toHaveValue("{{applicationId}} – NEW – {{clientName}}");
    expect(within(drawer).getByText("{{appointmentTime}}")).toBeInTheDocument();
    expect(screen.getByTestId("status-email-preview-subject")).toHaveTextContent("38017 – NEW – Anil Sharma");
    expect(screen.getByTestId("status-email-preview-body")).toHaveTextContent(
      "Your Japan Tourist Visa application 38017 moved on.",
    );
    expect(screen.getByTestId("status-email-preview-body")).not.toHaveTextContent("{{");
  });

  it("re-renders the preview as the body is edited, and PUTs the edit on Save", async () => {
    const { requestLog } = renderStatusEmailsPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open Application Received" }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hello {{clientName}}" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hi {{clientName}}, ref {{applicationId}}" } });
    expect(screen.getByTestId("status-email-preview-body")).toHaveTextContent("Hi Anil Sharma, ref 38017");
    fireEvent.click(screen.getByLabelText("Send this email when a case reaches this status"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(requestLog.some((request) => request.method === "PUT")).toBe(true));
    const saveRequest = requestLog.find((request) => request.method === "PUT")!;
    expect(saveRequest.url).toContain("/status-email-templates/NEW");
    expect(saveRequest.body).toEqual({
      subject: "Hello {{clientName}}",
      body: "Hi {{clientName}}, ref {{applicationId}}",
      enabled: false,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses to save an empty subject without calling the API", async () => {
    const { requestLog } = renderStatusEmailsPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open Application Received" }));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Give the email a subject.")).toBeInTheDocument();
    expect(requestLog.some((request) => request.method === "PUT")).toBe(false);
  });

  it("resets to the default through the reset route and shows the default text", async () => {
    const { requestLog } = renderStatusEmailsPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open Application Received" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue("Default subject"));
    expect(screen.getByLabelText("Body")).toHaveValue("Default body");
    const resetRequest = requestLog.find((request) => request.url.endsWith("/status-email-templates/NEW/reset"))!;
    expect(resetRequest.method).toBe("POST");
  });

  it("hides Save and Reset from a read-only role and locks the fields", async () => {
    renderStatusEmailsPage("Viewer");
    fireEvent.click(await screen.findByRole("button", { name: "Open Application Received" }));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Body")).toHaveAttribute("readonly");
    expect(screen.getByTestId("status-email-preview-subject")).toBeInTheDocument();
  });
});
