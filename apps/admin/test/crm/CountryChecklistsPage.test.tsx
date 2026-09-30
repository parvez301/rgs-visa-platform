import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { CountryChecklistsPage } from "../../src/crm/countryChecklists/CountryChecklistsPage";

function authStateFor(primaryRole: "Owner" | "Viewer"): AuthState {
  return {
    isLoading: false,
    isSignedIn: true,
    email: "owner@example.com",
    idToken: "test-id-token",
    roles: [primaryRole],
    primaryRole,
    needsNewPassword: false,
    signIn: async () => "signedIn",
    completeNewPassword: async () => {},
    signOut: () => {},
  };
}

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

function renderChecklistsPage(primaryRole: "Owner" | "Viewer" = "Owner") {
  const putBodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      const requestUrl = String(url);
      const method = init.method ?? "GET";
      if (requestUrl.endsWith("/crm/destination-countries")) {
        return jsonResponse(200, {
          countries: [
            { countryCode: "AE", countryName: "United Arab Emirates" },
            { countryCode: "JP", countryName: "Japan" },
          ],
        });
      }
      if (requestUrl.endsWith("/crm/country-checklists") && method === "GET") {
        return jsonResponse(200, {
          checklists: [
            {
              countryCode: "AE",
              requiredDocuments: ["Passport bio page", "Passport-size photo"],
              notes: "Original passport required",
              updatedAt: "2026-09-30T12:00:00.000Z",
              updatedBy: "owner@example.com",
            },
          ],
        });
      }
      if (requestUrl.includes("/crm/country-checklists/") && method === "PUT") {
        putBodies.push(init.body === undefined ? undefined : JSON.parse(String(init.body)));
        return jsonResponse(200, {
          countryCode: "AE",
          requiredDocuments: ["Passport bio page"],
          updatedAt: "2026-09-30T12:00:00.000Z",
          updatedBy: "owner@example.com",
        });
      }
      return jsonResponse(500, { message: `unexpected ${method} ${requestUrl}` });
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <AuthContext.Provider value={authStateFor(primaryRole)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CountryChecklistsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return { putBodies };
}

function chipLabels(): (string | null)[] {
  return screen.getAllByTestId("checklist-doc-chip").map((node) => node.textContent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CountryChecklistsPage", () => {
  it("lists destinations on the left with full names and no back-to-ledger button", async () => {
    renderChecklistsPage();
    expect(await screen.findByText("United Arab Emirates")).toBeInTheDocument();
    expect(screen.getByText("Japan")).toBeInTheDocument();
    expect(screen.getAllByTestId("checklist-country-row")).toHaveLength(2);
    expect(screen.queryByText(/back to ledger/i)).toBeNull();
    expect(screen.queryByTestId("checklist-doc-chip")).toBeNull();
  });

  it("shows the selected country's required documents as separate chips and marks the row active", async () => {
    renderChecklistsPage();
    fireEvent.click(await screen.findByRole("button", { name: /United Arab Emirates/ }));
    expect(chipLabels()).toEqual(expect.arrayContaining(["Passport bio page", "Passport-size photo"]));
    expect(screen.getAllByTestId("checklist-doc-chip")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /United Arab Emirates/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Japan/ })).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: /Japan/ }));
    expect(screen.queryByTestId("checklist-doc-chip")).toBeNull();
    expect(screen.getByRole("button", { name: /Japan/ })).toHaveAttribute("aria-current", "true");
  });

  it("adds a document from the field, removes a chip, and PUTs the chip labels on Save", async () => {
    const { putBodies } = renderChecklistsPage();
    fireEvent.click(await screen.findByRole("button", { name: /United Arab Emirates/ }));

    fireEvent.change(screen.getByLabelText("Add document"), { target: { value: "  Hotel booking " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(chipLabels()).toEqual(expect.arrayContaining(["Hotel booking"]));
    expect(screen.getByLabelText("Add document")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Remove Passport-size photo" }));
    expect(chipLabels()).not.toContain("Passport-size photo");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      requiredDocuments: ["Passport bio page", "Hotel booking"],
      notes: "Original passport required",
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.getAllByTestId("checklist-doc-chip").length).toBeGreaterThan(0);
  });

  it("adds a document with Enter and ignores a duplicate label", async () => {
    renderChecklistsPage();
    fireEvent.click(await screen.findByRole("button", { name: /United Arab Emirates/ }));
    const addField = screen.getByLabelText("Add document");
    fireEvent.change(addField, { target: { value: "Passport bio page" } });
    fireEvent.keyDown(addField, { key: "Enter" });
    expect(screen.getAllByTestId("checklist-doc-chip")).toHaveLength(2);
    fireEvent.change(addField, { target: { value: "Bank statement" } });
    fireEvent.keyDown(addField, { key: "Enter" });
    expect(chipLabels()).toContain("Bank statement");
  });

  it("refuses to save an empty checklist without calling the API", async () => {
    const { putBodies } = renderChecklistsPage();
    fireEvent.click(await screen.findByRole("button", { name: /Japan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add at least one document.")).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it("shows chips read-only, without add, remove or Save, for a read-only role", async () => {
    renderChecklistsPage("Viewer");
    fireEvent.click(await screen.findByRole("button", { name: /United Arab Emirates/ }));
    expect(chipLabels()).toEqual(expect.arrayContaining(["Passport bio page"]));
    expect(screen.queryByLabelText("Add document")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Passport bio page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
