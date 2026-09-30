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
    expect(screen.getByRole("link", { name: "Cases" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Leads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Notices" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows Doc checklists as a top-level link and nests Status emails under Cases", () => {
    renderShell("Owner");

    expect(screen.getByRole("link", { name: "Cases" })).toHaveAttribute("href", "/crm");
    expect(screen.getByRole("link", { name: "Doc checklists" })).toHaveAttribute(
      "href",
      "/crm/country-checklists",
    );
    expect(screen.getByRole("link", { name: "Status emails" })).toHaveAttribute(
      "href",
      "/crm/status-emails",
    );
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/crm/review");
    expect(screen.queryByRole("link", { name: "CRM" })).not.toBeInTheDocument();
  });

  it("hides Cases children when the role cannot access crm", () => {
    // Viewer keeps Cases (crm read) but not Config; children follow each child's own screen.
    renderShell("Viewer");

    expect(screen.getByRole("link", { name: "Cases" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Doc checklists" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Config" })).not.toBeInTheDocument();
  });
});
