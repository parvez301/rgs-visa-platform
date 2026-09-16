import { act } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { ApiRequestError } from "../../src/lib/adminApi";
import { crmQueryKeys, useCase, useLedgerRows } from "../../src/crm/api/hooks";
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
  /**
   * Rejects the `fetch` PROMISE itself rather than resolving it with a
   * not-ok `Response` -- a dropped connection, a DNS failure, a CORS refusal.
   * G4: no stub on this branch could produce one, which is why the only
   * failure the suite had ever seen was an HTTP status.
   */
  failAtTheNetwork: (networkError: Error) => void;
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
      return new Promise((resolvePromise, rejectPromise) => {
        pendingDeferreds.push({
          resolve: (payload) => resolvePromise({ ok: true, status: 200, json: async () => payload }),
          reject: (error) =>
            resolvePromise({
              ok: false,
              status: error.statusCode,
              json: async () => ({ code: error.code, message: error.message }),
            }),
          failAtTheNetwork: (networkError) => rejectPromise(networkError),
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

  function failRequestAtTheNetwork(networkError: Error): void {
    const deferred = pendingDeferreds.shift();
    if (deferred === undefined) throw new Error("No pending request to fail");
    deferred.failAtTheNetwork(networkError);
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

  return { queryClient, requestLog, resolveRequest, rejectRequest, failRequestAtTheNetwork, commitEdit };
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

/**
 * A second harness, for R76 only: the one with LIVE queries.
 *
 * Every other test in this file seeds the ledger cache with `setQueryData`,
 * which leaves the query INACTIVE -- no observers -- and an inactive query is
 * not refetched by `invalidateQueries` at any `refetchType`. A refetch
 * assertion against that harness could therefore never fail, whichever way the
 * code went. So this one mounts the real `useLedgerRows` and `useCase`
 * alongside `useLedgerEdit`, answers their GETs from a URL-routed stub, and
 * counts what actually went out.
 */
function LiveLedgerQueriesHarness({ onReady }: { onReady: (api: UseLedgerEditResult) => void }) {
  useLedgerRows([], undefined);
  useCase("case_1");
  onReady(useLedgerEdit());
  return null;
}

function renderLedgerEditWithLiveQueries() {
  const requestLog: RequestLogEntry[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const requestUrl = String(url);
      const requestMethod = init.method ?? "GET";
      requestLog.push({
        method: requestMethod,
        url: requestUrl,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (requestMethod === "GET" && requestUrl.includes("/cases/ledger")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rows: [buildLedgerRow()],
            unreadableCaseIds: [],
            appliedQuery: { statuses: [], limit: 500 },
          }),
        };
      }
      // The case GET and the axis PUT both answer with the case record; only
      // the request COUNTS matter here, never the payloads.
      return { ok: true, status: 200, json: async () => ({ caseId: "case_1", caseStatus: "IN_PROGRESS" }) };
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  let ledgerEditApi: UseLedgerEditResult | undefined;

  render(
    <QueryClientProvider client={queryClient}>
      <UndoToastProvider>
        <LiveLedgerQueriesHarness
          onReady={(api) => {
            ledgerEditApi = api;
          }}
        />
      </UndoToastProvider>
    </QueryClientProvider>,
  );

  function countGetsMatching(urlFragment: string): number {
    return requestLog.filter(
      (entry) => entry.method === "GET" && entry.url.includes(urlFragment),
    ).length;
  }

  async function commitEdit(edit: LedgerEdit): Promise<void> {
    if (ledgerEditApi === undefined) throw new Error("useLedgerEdit has not rendered yet");
    await act(async () => {
      await ledgerEditApi!.commitEdit(edit);
    });
  }

  return { queryClient, requestLog, countGetsMatching, commitEdit };
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
    //
    // Fix round 1, F5: the version of this test without the assertion right
    // below stayed green against exactly the regression it is named for.
    // Under a single-computed-key `LEDGER_CACHE_KEY_PREFIX`, the optimistic
    // write in `commitEdit` above never reaches `secondFilterQueryKey` in the
    // first place (see the sibling "lands on a DIFFERENT filter" test) -- so
    // its value was never "NEW, correctly rolled back", it was "NEW,
    // untouched the whole time", and the final `waitFor` below could not
    // tell those two apart. Asserting the optimistic write actually landed
    // here BEFORE rejecting closes that gap: under the regression, execution
    // never reaches the rejection at all, and the test reddens on the line
    // below instead of passing vacuously. Verified by hand (see
    // task-12-report.md, "Fix round 1"): reverting `LEDGER_CACHE_KEY_PREFIX`
    // to `crmQueryKeys.ledger([], undefined)` fails this test at this exact
    // assertion; restoring the prefix makes it pass again.
    const { queryClient, commitEdit, rejectRequest } = renderLedgerWithDeferredApi();
    const secondFilterQueryKey = crmQueryKeys.ledger(["NEW"], undefined);
    queryClient.setQueryData(secondFilterQueryKey, buildLedgerLoad([buildLedgerRow()]));

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });

    expect(cachedRow(queryClient, "case_1", secondFilterQueryKey).caseStatus).toBe("IN_PROGRESS");

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
    // Fix round 1, F4's "keep it for other failures" half: a plain 500 is not
    // a conflict, so the retry affordance below must survive unchanged. The
    // sibling 409 case is the next test.
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

  it("R77: shows the server's own words when a write fails with something other than a 409", async () => {
    // Finding #4 / G4. A 400 from a malformed body, a 403 from an expired
    // token and a 500 all used to look identical to a desk agent: the value
    // flickered and reverted, and `mutations.test.tsx`'s own 500 test asserted
    // the CACHE rolled back and nothing about what the human was told, because
    // nothing was told. The 400 is not hypothetical -- an empty
    // `appointmentDate` produces exactly this (finding #3).
    const { commitEdit, rejectRequest, queryClient } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    await act(async () => {
      rejectRequest(new ApiRequestError(400, "BAD_REQUEST", "appointmentDate must look like 2026-03-09"));
    });

    // The server's own words, not a paraphrase -- rule 4's reasoning about a
    // 409 applies just as well to a 400: the server is the one that knows why.
    expect(await screen.findByText("appointmentDate must look like 2026-03-09")).toBeInTheDocument();
    // And the rollback still happened -- the message is in ADDITION to rule 2,
    // never instead of it.
    await waitFor(() => expect(cachedRow(queryClient, "case_1").caseStatus).toBe("NEW"));
  });

  it("R77: says the edit did not save when the request never reached a server at all", async () => {
    // The branch that has no server words to borrow. G4 again: every fetch
    // stub on this branch resolved with `{ ok, status, json }`, so a dropped
    // connection -- the failure a desk agent on hotel wifi actually hits --
    // could not be produced at all until `failRequestAtTheNetwork` existed.
    const { commitEdit, failRequestAtTheNetwork } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    await act(async () => {
      failRequestAtTheNetwork(new TypeError("Failed to fetch"));
    });

    expect(
      await screen.findByText("Your edit did not save. Check your connection and try again."),
    ).toBeInTheDocument();
    // Never the raw exception: "Failed to fetch" is a browser's words about a
    // promise, not a sentence for a desk agent.
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });

  it("R77: a 409 still gets the conflict prompt and no toast beside it", async () => {
    // The prompt asks a question. A toast next to it would be a second,
    // quieter answer to the same question, and rule 4 gives the human exactly
    // one place to decide.
    const { commitEdit, rejectRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "CLOSED" });
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));
    });

    await screen.findByRole("alertdialog");
    // `UndoToast` renders one `role="status"` per toast, so an empty list is
    // "no toast on screen" and not merely "no toast with these words".
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("suppresses 'Retry undo' when the undo itself hits a 409, leaving the conflict prompt as the only recovery UI", async () => {
    // Fix round 1, F4. `onErrorForEdit` is shared, unmodified, by every axis
    // mutation including the one `performUndo` drives -- so a 409 here opens
    // the SAME conflict dialog a normal edit's 409 would, via the same code
    // path. Before this fix, that dialog and "Retry undo" rendered at once:
    // two contradictory answers to one question, and retrying is exactly
    // what rule 4 forbids.
    const user = userEvent.setup();
    const { commitEdit, resolveRequest, rejectRequest } = renderLedgerWithDeferredApi();

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "SUBMITTED", nextValue: "DECIDED" });
    await act(async () => {
      resolveRequest({ caseStatus: "DECIDED" });
    });

    await user.click(await screen.findByRole("button", { name: /undo/i }));
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from DECIDED to SUBMITTED"));
    });

    await screen.findByRole("alertdialog");
    expect(screen.queryByRole("button", { name: /retry undo/i })).not.toBeInTheDocument();
  });

  it("R76: marks the ledger stale after a write without re-reading the GSI, while the case is refetched", async () => {
    // Finding #7. `listLedgerRows` reads GSI1, and a GSI read is always
    // eventually consistent -- so a refetch fired the instant the PUT settles
    // can be answered with the PRE-write projection and overwrite the
    // optimistic value, which then sticks for the ledger's five-minute
    // `staleTime`. `getCase` is a strongly consistent GetItem, so it has no
    // race to lose and keeps refetching actively.
    //
    // G5 is explicit that no test can observe the race itself
    // (`InMemoryTableClient` is strongly consistent), so what is pinned here is
    // the MECHANISM: invalidated, but no second ledger GET.
    const { queryClient, countGetsMatching, commitEdit } = renderLedgerEditWithLiveQueries();

    // Both queries really are live and really did fetch -- without this the
    // "no second GET" assertion below would also hold for a harness whose
    // queries never ran at all.
    await waitFor(() => {
      expect(countGetsMatching("/cases/ledger")).toBe(1);
      expect(countGetsMatching("/crm/cases/case_1")).toBe(1);
    });

    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });

    // The case query IS refetched, which is what proves `onSettled` ran at all.
    await waitFor(() => expect(countGetsMatching("/crm/cases/case_1")).toBe(2));

    // No second ledger GET: the index is never re-read on the write's own
    // heels, which is the whole of R76.
    expect(countGetsMatching("/cases/ledger")).toBe(1);
    // Marked stale all the same, so the next natural read picks it up.
    expect(queryClient.getQueryState(DEFAULT_LEDGER_QUERY_KEY)?.isInvalidated).toBe(true);
  });
});
