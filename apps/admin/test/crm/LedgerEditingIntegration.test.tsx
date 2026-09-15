import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { ApiRequestError } from "../../src/lib/adminApi";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { mountedCell } from "./virtual";

/**
 * These tests render the real `LedgerTable`, not `EditableCell` or the
 * `useLedgerEdit` hook in isolation -- the review that opened this fix round
 * found that isolation is exactly what hid `visaType` editing being wired to
 * no column at all (F1), a focus-stealing re-render silently firing
 * unconfirmed writes (F2), and a direct click on a non-REF cell not
 * focusing it for editing (F3). Every assertion here goes through the
 * rendered grid: a real click, a real keypress, a real (stubbed) fetch.
 */

interface RequestLogEntry {
  method: string;
  url: string;
  body: unknown;
}

interface DeferredResponse {
  resolve: (payload: unknown) => void;
  reject: (error: ApiRequestError) => void;
}

const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_0000",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-01",
    totalInr: 10_000,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Wraps `LedgerTable` in the same providers `LedgerPage` gives it in
 * production, with a stubbed, deferred `fetch` -- the same shape
 * `mutations.test.tsx` uses -- and a `rerenderWithSameRows` escape hatch for
 * F2's test, which needs to force `LedgerTable` itself to re-render (not
 * just `EditableCell`) without changing anything an editing desk agent
 * would notice.
 */
function renderLedgerForEditing(rows: crm.LedgerRow[]) {
  const requestLog: RequestLogEntry[] = [];
  const pendingDeferreds: DeferredResponse[] = [];

  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    requestLog.push({
      method: init.method ?? "GET",
      url: String(url),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Promise((resolvePromise) => {
      pendingDeferreds.push({
        resolve: (payload) => resolvePromise({ ok: true, status: 200, json: async () => payload }),
        reject: (error) =>
          resolvePromise({
            ok: false,
            status: error.statusCode,
            json: async () => ({ code: error.code, message: error.message }),
          }),
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  function resolveRequest(payload: unknown): void {
    const deferred = pendingDeferreds.shift();
    if (deferred === undefined) throw new Error("No pending request to resolve");
    deferred.resolve(payload);
  }

  function rejectRequest(error: ApiRequestError): void {
    const deferred = pendingDeferreds.shift();
    if (deferred === undefined) throw new Error("No pending request to reject");
    deferred.reject(error);
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function tree(tableRows: crm.LedgerRow[]) {
    return createElement(
      AuthContext.Provider,
      { value: TEST_AUTH_STATE },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(UndoToastProvider, null, createElement(LedgerTable, { rows: tableRows, partnerNamesById: {} })),
      ),
    );
  }

  const result = render(tree(rows));

  /** Re-renders the exact same rows -- a re-render `LedgerTable` did not ask for and has no editing-relevant reason to react to. */
  function rerenderWithSameRows(): void {
    result.rerender(tree(rows));
  }

  return { ...result, requestLog, resolveRequest, rejectRequest, rerenderWithSameRows, fetchMock };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("LedgerTable: visaType editing on the Type column (fix round 1, F1)", () => {
  it("opens the visaType editor from the Type column on a VISA case, and commits a real write", async () => {
    const user = userEvent.setup();
    const row = buildRow({ caseType: "VISA", visaType: "TOURIST" });
    const { container, requestLog } = renderLedgerForEditing([row]);

    // Closed state shows the combined case-type + visa-type label -- proof
    // that wiring `editable: "visaType"` onto this column did not regress it
    // to EditableCell's own bare visa-type display (which would show just
    // "Tourist", not "Visa · Tourist").
    expect(mountedCell(container, "case_0000", "caseType").textContent).toBe("Visa · Tourist");

    await user.click(mountedCell(container, "case_0000", "caseType"));
    await user.keyboard("{Enter}");

    const select = screen.getByRole("combobox");
    expect(select).not.toBeDisabled();
    expect(screen.getAllByRole("option")).toHaveLength(crm.VISA_TYPES.length);

    await user.selectOptions(select, "WORK");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const writes = requestLog.filter((entry) => entry.method === "PUT");
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body).toEqual({ visaType: "WORK" });
    });
  });

  it("opens the visaType editor disabled, with a reason, on a non-VISA case -- reachable through the grid, not just in isolation", async () => {
    const user = userEvent.setup();
    const row = buildRow({ caseType: "ATTESTATION", visaType: undefined });
    const { container } = renderLedgerForEditing([row]);

    expect(mountedCell(container, "case_0000", "caseType").textContent).toBe("Attestation");

    await user.click(mountedCell(container, "case_0000", "caseType"));
    await user.keyboard("{Enter}");

    const select = screen.getByRole("combobox");
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("title", expect.stringContaining("VISA"));
  });
});

describe("LedgerTable: an unrelated re-render must not steal focus from an open editor (fix round 1, F2)", () => {
  it("does not commit and does not close the editor when something else forces LedgerTable to re-render", async () => {
    const user = userEvent.setup();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    const { container, requestLog, rerenderWithSameRows } = renderLedgerForEditing([row]);

    await user.click(mountedCell(container, "case_0000", "caseStatus"));
    await user.keyboard("{Enter}");

    const select = screen.getByRole("combobox");
    // Picks a value but deliberately never confirms it (no Enter, no Tab) --
    // the only thing that follows is an unrelated re-render.
    await user.selectOptions(select, "SUBMITTED");

    // This is the reproduction from the review: the focus-sync effect
    // (LedgerTable.tsx) used to run unconditionally on every render and call
    // `.focus()` on the gridcell wrapper, stealing DOM focus away from this
    // open <select> and firing its `onBlur` commit for a value the human
    // never confirmed.
    act(() => {
      rerenderWithSameRows();
    });

    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(0);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });
});

describe("LedgerTable: clicking a non-REF cell focuses it for editing (fix round 1, F3)", () => {
  it("opens the clicked cell's own editor on Enter, not the REF column's", async () => {
    const user = userEvent.setup();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    const { container } = renderLedgerForEditing([row]);

    // Before the fix, a click anywhere in the row only ever moved row focus;
    // column focus stayed wherever it was (column 0, the REF cell), so
    // Enter here opened the REF cell's (non-existent) editor instead of this
    // one's.
    await user.click(mountedCell(container, "case_0000", "caseStatus"));
    await user.keyboard("{Enter}");

    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    // Confirms it is genuinely *this* cell's editor: caseStatus's options are
    // state-machine-filtered from "IN_PROGRESS", never the full enum.
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(optionLabels.length).toBeGreaterThan(0);
    expect(optionLabels).not.toContain("New");
  });

  it("still reaches the real conflict dialog when driven the intended way -- click REF, then arrow across", async () => {
    // The reviewer's own confirmation that the seam works once driven this
    // way; pinned here so a future change to the click-to-focus fix cannot
    // silently regress the path that already worked.
    const user = userEvent.setup();
    const row = buildRow({ caseStatus: "SUBMITTED" });
    const { container, rejectRequest, resolveRequest } = renderLedgerForEditing([row]);

    await user.click(mountedCell(container, "case_0000", "caseRef"));
    // caseRef(0) -> partner(1) -> destinationCountry(2) -> caseType(3) ->
    // applicants(4) -> caseStatus(5): five moves right lands on caseStatus,
    // except the REF column's first → expands the row instead of moving
    // (see useGridKeyboard.ts's "overloaded →"), so six are needed here.
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");

    // Task 13: that first → also expanded the row, which mounts
    // `<ApplicantSubRows>` and fires its own GET for the case -- settle it
    // now, before it can sit ahead of the PUT below in `pendingDeferreds`'s
    // FIFO queue and steal the `rejectRequest` call meant for that PUT.
    await act(async () => {
      resolveRequest({ ...row, applicants: [{ applicantRef: "A1", travellerId: "T1" }] });
    });

    await user.keyboard("{Enter}");

    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "CLOSED");
    await user.keyboard("{Enter}");

    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));
    });

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Cannot move a case from SUBMITTED to CLOSED/)).toBeInTheDocument();
  });
});
