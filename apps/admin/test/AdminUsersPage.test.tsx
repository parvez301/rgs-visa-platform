import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUsersPage } from "../src/pages/AdminUsersPage";
import { ApiRequestError, adminApi } from "../src/lib/adminApi";
import { AuthContext, type AuthState } from "../src/lib/auth";

vi.mock("../src/lib/adminApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/adminApi")>();
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listStaff: vi.fn(),
      inviteStaff: vi.fn(),
      setStaffRole: vi.fn(),
      disableStaff: vi.fn(),
      enableStaff: vi.fn(),
    },
  };
});

const ownerAuth: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "owner@rgs.test",
  idToken: "test-token",
  roles: ["Owner"],
  primaryRole: "Owner",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

const staff = [
  {
    username: "ops-user",
    email: "ops@rgs.test",
    role: "Ops" as const,
    status: "CONFIRMED",
    enabled: true,
  },
  {
    username: "viewer-user",
    email: "viewer@rgs.test",
    role: "Viewer" as const,
    status: "FORCE_CHANGE_PASSWORD",
    enabled: false,
  },
];

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuth}>
        <MemoryRouter>
          <AdminUsersPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(adminApi.listStaff).mockResolvedValue(staff);
  vi.mocked(adminApi.inviteStaff).mockResolvedValue({
    username: "new-user",
    email: "new@rgs.test",
    role: "Finance",
    status: "FORCE_CHANGE_PASSWORD",
    enabled: true,
  });
  vi.mocked(adminApi.setStaffRole).mockResolvedValue({ updated: true });
  vi.mocked(adminApi.disableStaff).mockResolvedValue({ disabled: true });
  vi.mocked(adminApi.enableStaff).mockResolvedValue({ enabled: true });
});

describe("AdminUsersPage", () => {
  it("lists staff and supports invite, role, disable, and enable actions", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    expect(await screen.findByText("ops@rgs.test")).toBeInTheDocument();
    expect(screen.getByText("viewer@rgs.test")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "new@rgs.test");
    await user.selectOptions(screen.getByLabelText("Invite role"), "Finance");
    await user.click(screen.getByRole("button", { name: "Invite staff" }));
    await waitFor(() =>
      expect(adminApi.inviteStaff).toHaveBeenCalledWith("test-token", {
        email: "new@rgs.test",
        role: "Finance",
      }),
    );

    await user.selectOptions(screen.getByLabelText("Role for ops@rgs.test"), "Finance");
    await waitFor(() =>
      expect(adminApi.setStaffRole).toHaveBeenCalledWith(
        "test-token",
        "ops-user",
        "Finance",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Disable ops@rgs.test" }));
    expect(window.confirm).toHaveBeenCalledWith("Disable ops@rgs.test?");
    await waitFor(() =>
      expect(adminApi.disableStaff).toHaveBeenCalledWith("test-token", "ops-user"),
    );

    await user.click(screen.getByRole("button", { name: "Enable viewer@rgs.test" }));
    expect(window.confirm).toHaveBeenCalledWith("Enable viewer@rgs.test?");
    await waitFor(() =>
      expect(adminApi.enableStaff).toHaveBeenCalledWith("test-token", "viewer-user"),
    );
  });

  it("shows API error text for rejected writes", async () => {
    const user = userEvent.setup();
    vi.mocked(adminApi.inviteStaff).mockRejectedValue(
      new ApiRequestError(403, "FORBIDDEN", "Only Owners can invite staff"),
    );
    renderPage();

    await screen.findByText("ops@rgs.test");
    await user.type(screen.getByLabelText("Email"), "blocked@rgs.test");
    await user.click(screen.getByRole("button", { name: "Invite staff" }));

    expect(
      await screen.findByText("Only Owners can invite staff"),
    ).toBeInTheDocument();
  });

  it("shows a 400 response when an account cannot be disabled", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(adminApi.disableStaff).mockRejectedValue(
      new ApiRequestError(
        400,
        "BAD_REQUEST",
        "The last enabled Owner cannot be demoted or disabled",
      ),
    );
    renderPage();

    await screen.findByText("ops@rgs.test");
    await user.click(screen.getByRole("button", { name: "Disable ops@rgs.test" }));

    expect(
      await screen.findByText(
        "The last enabled Owner cannot be demoted or disabled",
      ),
    ).toBeInTheDocument();
  });
});
