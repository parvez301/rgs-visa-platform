import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { RequireScreen } from "../src/components/RequireScreen";
import { useAdminAccess } from "../src/lib/adminAccess";
import { AuthContext, parseGroups, type AuthState } from "../src/lib/auth";

function authState(overrides: Partial<AuthState> = {}): AuthState {
  return {
    isLoading: false,
    isSignedIn: true,
    email: "admin@example.com",
    idToken: "test-token",
    roles: ["Ops"],
    primaryRole: "Ops",
    needsNewPassword: false,
    signIn: async () => "signedIn",
    completeNewPassword: async () => {},
    signOut: () => {},
    ...overrides,
  };
}

function AccessProbe() {
  const access = useAdminAccess();
  return (
    <output>
      {access.primaryRole}:{String(access.canAccess("queue"))}:{String(access.canWrite("portalUser"))}
    </output>
  );
}

function renderWithAuth(children: React.ReactNode, state = authState()) {
  return render(
    <AuthContext.Provider value={state}>
      <MemoryRouter initialEntries={["/protected"]}>{children}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("parseGroups", () => {
  it.each([
    [undefined, []],
    ['["Ops"]', ["Ops"]],
    [["Finance", "Viewer"], ["Finance", "Viewer"]],
  ])("normalizes Cognito groups from %j", (groups, expected) => {
    expect(parseGroups(groups)).toEqual(expected);
  });

  it("ignores malformed Cognito group values", () => {
    expect(parseGroups("Ops")).toEqual([]);
    expect(parseGroups([42, "Ops"])).toEqual([]);
    expect(parseGroups({ role: "Ops" })).toEqual([]);
  });
});

describe("useAdminAccess", () => {
  it("exposes role-based read and write checks", () => {
    renderWithAuth(<AccessProbe />);

    expect(screen.getByText("Ops:true:false")).toBeInTheDocument();
  });
});

describe("RequireScreen", () => {
  it("renders children when role has requested access", () => {
    renderWithAuth(
      <RequireScreen screen="queue">
        <p>Allowed content</p>
      </RequireScreen>,
    );

    expect(screen.getByText("Allowed content")).toBeInTheDocument();
  });

  it("redirects when role lacks requested write access", () => {
    renderWithAuth(
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireScreen screen="queue" write>
              <p>Protected content</p>
            </RequireScreen>
          }
        />
        <Route path="/no-access" element={<p>No access destination</p>} />
      </Routes>,
      authState({ roles: ["Viewer"], primaryRole: "Viewer" }),
    );

    expect(screen.getByText("No access destination")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("redirects signed-in users without an admin role", () => {
    renderWithAuth(
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireScreen screen="queue">
              <p>Protected content</p>
            </RequireScreen>
          }
        />
        <Route path="/no-access" element={<p>No access destination</p>} />
      </Routes>,
      authState({ roles: [], primaryRole: null }),
    );

    expect(screen.getByText("No access destination")).toBeInTheDocument();
  });
});
