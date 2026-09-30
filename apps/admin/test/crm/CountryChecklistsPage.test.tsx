import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { CountryChecklistsPage } from "../../src/crm/countryChecklists/CountryChecklistsPage";

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "owner@example.com",
  idToken: "test-id-token",
  roles: ["Owner"],
  primaryRole: "Owner",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

function jsonResponse(status: number, payload: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => payload });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CountryChecklistsPage", () => {
  it("lists destinations with full names and saves a checklist via PUT", async () => {
    const putBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        const requestUrl = String(url);
        const method = init.method ?? "GET";
        if (requestUrl.endsWith("/crm/destination-countries")) {
          return jsonResponse(200, {
            countries: [{ countryCode: "AE", countryName: "United Arab Emirates" }],
          });
        }
        if (requestUrl.endsWith("/crm/country-checklists") && method === "GET") {
          return jsonResponse(200, { checklists: [] });
        }
        if (requestUrl.includes("/crm/country-checklists/AE") && method === "PUT") {
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
      <AuthContext.Provider value={TEST_AUTH_STATE}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <CountryChecklistsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    );

    expect(await screen.findByText("United Arab Emirates")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Required documents"), {
      target: { value: "Passport bio page\nPassport-size photo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      requiredDocuments: ["Passport bio page", "Passport-size photo"],
    });
  });
});
