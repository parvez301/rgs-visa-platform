import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AdminShell } from "../src/components/AdminShell";
import { AuthContext, type AuthState } from "../src/lib/auth";

function authState(primaryRole: AuthState["primaryRole"]): AuthState {
  return {
    isLoading: false,
    isSignedIn: true,
    email: "staff@example.com",
    idToken: "test-token",
    roles: primaryRole ? [primaryRole] : [],
    primaryRole,
    needsNewPassword: false,
    signIn: async () => "signedIn",
    completeNewPassword: async () => {},
    signOut: () => {},
  };
}

function renderShell(primaryRole: AuthState["primaryRole"]) {
  return render(
    <AuthContext.Provider value={authState(primaryRole)}>
      <MemoryRouter>
        <AdminShell>
          <p>Page content</p>
        </AdminShell>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("AdminShell navigation", () => {
  it("shows every permitted destination, including Users, to Owners", () => {
    renderShell("Owner");

    expect(screen.getByRole("link", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Config" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "href",
      "/admin/users",
    );
  });

  it("omits destinations the current role cannot access", () => {
    renderShell("Viewer");

    expect(screen.getByRole("link", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "CRM" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Leads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Notices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });
});
