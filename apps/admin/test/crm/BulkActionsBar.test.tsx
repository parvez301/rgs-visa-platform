import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { BulkActionsBar } from "../../src/crm/ledger/BulkActionsBar";
import { crmClient } from "../../src/crm/api/crmClient";

vi.mock("../../src/lib/auth", () => ({
  useAuth: () => ({
    isLoading: false,
    isSignedIn: true,
    email: "agent@example.com",
    idToken: "test-id-token",
    needsNewPassword: false,
    signIn: vi.fn(),
    completeNewPassword: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock("../../src/crm/api/crmClient", () => ({
  crmClient: {
    setCaseStatus: vi.fn(),
    setBillingStatus: vi.fn(),
  },
}));

const mockedSetBillingStatus = vi.mocked(crmClient.setBillingStatus);

function renderBar(selectedCaseIds: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BulkActionsBar selectedCaseIds={selectedCaseIds} onClearSelection={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("BulkActionsBar", () => {
  it("applies billing to each selected case and names the ones that failed", async () => {
    mockedSetBillingStatus.mockImplementation(async (_token, caseId) => {
      if (caseId === "case_b") throw new Error("Cannot move billing from PAID to BILL_SENT");
      return { caseId } as never;
    });

    renderBar(["case_a", "case_b"]);

    fireEvent.change(screen.getByLabelText("Bulk billing status"), { target: { value: "BILL_SENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply billing" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 applied, 1 failed: case_b");
    });
    expect(mockedSetBillingStatus).toHaveBeenCalledTimes(2);
    expect(mockedSetBillingStatus.mock.calls.map((call) => call[1])).toEqual(["case_a", "case_b"]);
  });
});
