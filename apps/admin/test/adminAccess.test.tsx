import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { HomeRoute } from "../src/components/HomeRoute";
import { RequireScreen } from "../src/components/RequireScreen";
import { useAdminAccess } from "../src/lib/adminAccess";
import { landingPath } from "../src/lib/navLinks";
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
    ['["Owner"]', ["Owner"]],
    // Kept in step with the API, which sees this bracketed form from the
    // HTTP API JWT authorizer.
    ["[Owner]", ["Owner"]],
    ["[Owner Ops]", ["Owner", "Ops"]],
    [["Finance", "Viewer"], ["Finance", "Viewer"]],
    [[], []],
    ["[]", []],
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

describe("landingPath", () => {
  it.each(["Owner", "Ops", "Viewer"] as const)(
    "keeps %s on the queue, which it can reach",
    (role) => {
      expect(landingPath(role)).toBe("/");
    },
  );

  it("sends Finance to its first reachable screen rather than the queue", () => {
    expect(landingPath("Finance")).toBe("/activity");
  });

  it("has nowhere to send a session with no admin role", () => {
    expect(landingPath(null)).toBe("/no-access");
  });
});

describe("HomeRoute", () => {
  function renderHome(state: AuthState) {
    return render(
      <AuthContext.Provider value={state}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={
                <HomeRoute>
                  <p>Queue content</p>
                </HomeRoute>
              }
            />
            <Route path="/activity" element={<p>Activity destination</p>} />
            <Route path="/no-access" element={<p>No access destination</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
  }

  it("renders the queue for a role that can see it", () => {
    renderHome(authState());

    expect(screen.getByText("Queue content")).toBeInTheDocument();
  });

  it("redirects Finance to a reachable screen instead of the no-access dead end", () => {
    renderHome(authState({ roles: ["Finance"], primaryRole: "Finance" }));

    expect(screen.getByText("Activity destination")).toBeInTheDocument();
    expect(screen.queryByText("No access destination")).not.toBeInTheDocument();
  });

  it("still sends a role-less session to no-access", () => {
    renderHome(authState({ roles: [], primaryRole: null }));

    expect(screen.getByText("No access destination")).toBeInTheDocument();
  });
});
