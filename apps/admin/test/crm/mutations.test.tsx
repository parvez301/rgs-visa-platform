import { act } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { ApiRequestError } from "../../src/lib/adminApi";
import { crmQueryKeys } from "../../src/crm/api/hooks";
import type { LedgerLoad } from "../../src/crm/api/crmClient";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { useLedgerEdit, type LedgerEdit, type UseLedgerEditResult } from "../../src/crm/api/mutations";

vi.mock("../../src/lib/auth", () => ({
  useAuth: () => ({ idToken: "test-id-token" }),
}));

interface RequestLogEntry {
  method: string;
  url: string;
  body: unknown;
}

interface DeferredResponse {
  resolve: (payload: unknown) => void;
  reject: (error: ApiRequestError) => void;
}

function buildLedgerRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_1",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-01",
    totalInr: 10_000,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildLedgerLoad(rows: crm.LedgerRow[]): LedgerLoad {
  return { rows, unreadableCaseIds: [], truncated: false, appliedQuery: { statuses: [], limit: 500 } };
}

const DEFAULT_LEDGER_QUERY_KEY = crmQueryKeys.ledger([], undefined);

/**
 * Renders `useLedgerEdit` inside real providers and surfaces its result via
 * `onReady`, plus a minimal rendering of `pendingConflict` -- enough DOM for
 * the pinned "shows both values on a 409" assertions, without pulling in the
 * whole `LedgerTable`/`EditableCell` machinery this hook is meant to be
 * consumed by. `LedgerTable`'s own conflict dialog is the real one a desk
 * agent sees; this is the hook's own contract.
 */
function LedgerEditHarness({ onReady }: { onReady: (api: UseLedgerEditResult) => void }) {
  const ledgerEdit = useLedgerEdit();
  onReady(ledgerEdit);
  if (ledgerEdit.pendingConflict === undefined) return null;
  const { edit, serverMessage } = ledgerEdit.pendingConflict;
  return (
    <div role="alertdialog">
      <p>This case changed underneath your edit.</p>
      <p>{serverMessage}</p>
      <p>Your value: {edit.nextValue}</p>
      <button onClick={() => ledgerEdit.resolveConflict("keepMine")}>Keep mine</button>
      <button onClick={() => ledgerEdit.resolveConflict("keepTheirs")}>Keep theirs</button>
    </div>
  );
}

function renderLedgerWithDeferredApi(options: { rowCount?: number } = {}) {
  const rowCount = options.rowCount ?? 1;
  const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
    buildLedgerRow({ caseId: `case_${rowIndex + 1}`, caseRef: `RGS-${1001 + rowIndex}` }),
  );

  const requestLog: RequestLogEntry[] = [];
  const pendingDeferreds: DeferredResponse[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
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
    }),
  );

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
  queryClient.setQueryData(DEFAULT_LEDGER_QUERY_KEY, buildLedgerLoad(rows));

  let ledgerEditApi: UseLedgerEditResult | undefined;

  render(
    <QueryClientProvider client={queryClient}>
      <UndoToastProvider>
        <LedgerEditHarness
          onReady={(api) => {
            ledgerEditApi = api;
          }}
        />
      </UndoToastProvider>
    </QueryClientProvider>,
  );

  async function commitEdit(edit: LedgerEdit): Promise<void> {
    if (ledgerEditApi === undefined) throw new Error("useLedgerEdit has not rendered yet");
    await act(async () => {
      await ledgerEditApi!.commitEdit(edit);
    });
  }

  return { queryClient, requestLog, resolveRequest, rejectRequest, commitEdit };
}

function cachedRow(queryClient: QueryClient, caseId: string, queryKey: QueryKey = DEFAULT_LEDGER_QUERY_KEY): crm.LedgerRow {
  const ledgerLoad = queryClient.getQueryData<LedgerLoad>(queryKey);
  const row = ledgerLoad?.rows.find((candidateRow) => candidateRow.caseId === caseId);
  if (row === undefined) throw new Error(`case ${caseId} not found in the cache at ${JSON.stringify(queryKey)}`);
  return row;
}

function cachedRows(queryClient: QueryClient, queryKey: QueryKey = DEFAULT_LEDGER_QUERY_KEY): crm.LedgerRow[] {
  const ledgerLoad = queryClient.getQueryData<LedgerLoad>(queryKey);
  if (ledgerLoad === undefined) throw new Error(`no ledger cache entry at ${JSON.stringify(queryKey)}`);
  return ledgerLoad.rows;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("useLedgerEdit", () => {
  it("writes the new value into the cache before the request resolves", async () => {
    // The whole point of optimistic: the cell must not wait for a round trip.
    const { queryClient, commitEdit, resolveRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });

    expect(cachedRow(queryClient, "case_1").caseStatus).toBe("IN_PROGRESS");
    resolveRequest({ caseStatus: "IN_PROGRESS" });
  });

  it("puts the old value back when the request fails", async () => {
    const { queryClient, commitEdit, rejectRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    await act(async () => {
      rejectRequest(new ApiRequestError(500, "INTERNAL", "Something went wrong"));
    });

    await waitFor(() => expect(cachedRow(queryClient, "case_1").caseStatus).toBe("NEW"));
  });

  it("restores the whole row list, not one row, so a rollback cannot resurrect a case", async () => {
    const { queryClient, commitEdit, rejectRequest } = renderLedgerWithDeferredApi({ rowCount: 3 });

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    await act(async () => {
      rejectRequest(new ApiRequestError(500, "INTERNAL", "boom"));
    });

    await waitFor(() => expect(cachedRows(queryClient)).toHaveLength(3));
  });

  it("R34: an edit under one filter also lands on a DIFFERENT filter's cache entry, not just the guessed key", async () => {
    // The regression this guards against: `onMutate` computing
    // `crmQueryKeys.ledger(callersOwnFilter, ...)` instead of writing over
    // the `["crm", "ledger"]` prefix. That bug would pass every other test
    // in this file (they all only ever look at one filter) and still leave
    // a desk agent looking at a second, unfiltered tab with a stale value.
    const { queryClient, commitEdit, resolveRequest } = renderLedgerWithDeferredApi();
    const secondFilterQueryKey = crmQueryKeys.ledger(["NEW"], undefined);
    queryClient.setQueryData(secondFilterQueryKey, buildLedgerLoad([buildLedgerRow()]));

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });

    expect(cachedRow(queryClient, "case_1", secondFilterQueryKey).caseStatus).toBe("IN_PROGRESS");
    resolveRequest({ caseStatus: "IN_PROGRESS" });
  });

  it("R34: a failed write rolls back EVERY matching filter's cache entry, not just the guessed key", async () => {
    // The inverse of the test above, and the one R34 calls out by name: a
    // rollback keyed off the wrong computed key restores a snapshot nobody
    // ever wrote to, leaving the second filter's tab showing the failed
    // edit's value with no error state at all.
    const { queryClient, commitEdit, rejectRequest } = renderLedgerWithDeferredApi();
    const secondFilterQueryKey = crmQueryKeys.ledger(["NEW"], undefined);
    queryClient.setQueryData(secondFilterQueryKey, buildLedgerLoad([buildLedgerRow()]));

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    await act(async () => {
      rejectRequest(new ApiRequestError(500, "INTERNAL", "boom"));
    });

    await waitFor(() => expect(cachedRow(queryClient, "case_1", secondFilterQueryKey).caseStatus).toBe("NEW"));
  });

  it("shows both values on a 409 and writes nothing until the human picks", async () => {
    const { commitEdit, rejectRequest, requestLog } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "CLOSED" });
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));
    });

    await screen.findByText(/changed underneath/i);
    expect(screen.getByText(/Cannot move a case from SUBMITTED to CLOSED/)).toBeInTheDocument();
    // The second half of the claim, asserted separately against the request
    // log rather than inferred from the dialog being on screen. Spec §10's
    // second named trap.
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
  });

  it("keepMine retries the human's own value as a fresh, optimistic write", async () => {
    const user = userEvent.setup();
    const { queryClient, commitEdit, rejectRequest, requestLog } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "CLOSED" });
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));
    });
    await screen.findByText(/changed underneath/i);

    await user.click(screen.getByRole("button", { name: /keep mine/i }));

    // Retried, not auto-picked: a second PUT only exists because the human
    // clicked a button naming their own value.
    await waitFor(() => expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(2));
    expect(cachedRow(queryClient, "case_1").caseStatus).toBe("CLOSED");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keepTheirs writes nothing further and closes the prompt", async () => {
    const user = userEvent.setup();
    const { commitEdit, rejectRequest, requestLog } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "CLOSED" });
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));
    });
    await screen.findByText(/changed underneath/i);

    await user.click(screen.getByRole("button", { name: /keep theirs/i }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
  });

  it("offers undo, and the undo is a real inverse write", async () => {
    // NOT the brief's own literal NEW -> IN_PROGRESS example: nothing in
    // CASE_STATUS_FORWARD_TRANSITIONS ever transitions TO "NEW" (it is only
    // ever a starting state), so IN_PROGRESS -> NEW is illegal and that pair
    // would always land on "cannot be undone" once the guard is wired up --
    // see the report for this finding in full. SUBMITTED <-> DECIDED is the
    // brief's own cited example of a legal round trip (spec §9: "an outcome
    // went back to SENT_BACK"), so it is what exercises this branch.
    const user = userEvent.setup();
    const { commitEdit, resolveRequest, requestLog } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "SUBMITTED", nextValue: "DECIDED" });
    await act(async () => {
      resolveRequest({ caseStatus: "DECIDED" });
    });

    await user.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => {
      const writes = requestLog.filter((entry) => entry.method === "PUT");
      expect(writes).toHaveLength(2);
      expect(writes[1]!.body).toEqual({ toStatus: "SUBMITTED" });
    });
  });

  it("says an undo is impossible rather than offering one that will 409", async () => {
    const { commitEdit, resolveRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "SUBMITTED", nextValue: "CLOSED" });
    await act(async () => {
      resolveRequest({ caseStatus: "CLOSED" });
    });

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });

  it("says an undo of an impossible billing reversal is impossible too", async () => {
    // Not literally pinned by the brief's pseudocode, but the same reasoning
    // (spec §9) applies to billingStatus: PAID has no reverse transition in
    // BILLING_TRANSITIONS, so an undo back to UNBILLED would also 409.
    const { commitEdit, resolveRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "billingStatus", previousValue: "UNBILLED", nextValue: "PAID" });
    await act(async () => {
      resolveRequest({ billingStatus: "PAID" });
    });

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });

  it("tells the human when the undo itself fails, rather than silently disappearing", async () => {
    const user = userEvent.setup();
    const { commitEdit, resolveRequest, rejectRequest, queryClient } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "SUBMITTED", nextValue: "DECIDED" });
    await act(async () => {
      resolveRequest({ caseStatus: "DECIDED" });
    });

    await user.click(await screen.findByRole("button", { name: /undo/i }));
    await act(async () => {
      rejectRequest(new ApiRequestError(500, "INTERNAL", "The database is unavailable"));
    });

    expect(await screen.findByText(/undo failed/i)).toBeInTheDocument();
    expect(screen.getByText(/database is unavailable/i)).toBeInTheDocument();
    // The undo mutation's own onError already rolled the cache back to the
    // value the failed undo attempted to leave in place -- the original
    // edit, still applied, exactly as if the undo attempt had never
    // happened.
    expect(cachedRow(queryClient, "case_1").caseStatus).toBe("DECIDED");
    // Retryable, not a dead end.
    expect(screen.getByRole("button", { name: /retry undo/i })).toBeInTheDocument();
  });
});
