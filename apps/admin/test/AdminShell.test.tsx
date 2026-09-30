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

function renderShell(primaryRole: AuthState["primaryRole"], initialPath = "/") {
  return render(
    <AuthContext.Provider value={authState(primaryRole)}>
      <MemoryRouter initialEntries={[initialPath]}>
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

  it("hides a Cases child the role cannot reach while keeping Cases itself", () => {
    // Viewer has crm read (so Cases and Doc checklists stay) but crmReview
    // "none", which is the only thing that hides the Review child.
    renderShell("Viewer");

    expect(screen.getByRole("link", { name: "Cases" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Doc checklists" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Config" })).not.toBeInTheDocument();
  });

  it("marks Cases as the current page on a case detail route, not just in red", () => {
    renderShell("Owner", "/crm/cases/case_1");

    // Cases owns /crm/cases/:id, but NavLink's own isActive is false there
    // because a link with children renders with `end`.
    expect(screen.getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Review" })).not.toHaveAttribute("aria-current");
  });

  it("leaves aria-current on the child, not on Cases, under a sibling route", () => {
    renderShell("Owner", "/crm/review");

    expect(screen.getByRole("link", { name: "Cases" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("aria-current", "page");
  });
});
