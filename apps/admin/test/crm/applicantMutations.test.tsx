import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { ApiRequestError } from "../../src/lib/adminApi";
import { crmQueryKeys } from "../../src/crm/api/hooks";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import {
  describeApplicantEditValue,
  useApplicantEdit,
  type ApplicantEdit,
  type UseApplicantEditResult,
} from "../../src/crm/api/applicantMutations";

/**
 * Fix round 1, F2. `useApplicantEdit` is the only new write path Task 14 adds,
 * and spec line 333 ("Every write: optimistic, rollback on failure, visible
 * undo") was claimed for it but proven nowhere: `CasePage.test.tsx`'s applicant
 * test asserts the request PATH against a stub that always succeeds, so the
 * rollback, the undo and the 409 prompt were all deletable without turning the
 * suite red.
 *
 * Same shape as `mutations.test.tsx`, deliberately: R49 asked for "the same
 * contract shape" as `useLedgerEdit`, and a hook with the same contract should
 * be held to the same tests. The one structural difference is the cache this
 * watches -- a per-applicant write patches `crmQueryKeys.case(caseId)` and
 * leaves the ledger's server-computed `applicantSummary` roll-up to the
 * invalidation in `onSettled`.
 */
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

function buildCase(overrides: Partial<crm.CrmCase> = {}): crm.CrmCase {
  return {
    tenantId: "tenant_1",
    caseId: "case_1",
    caseRef: "RGS-1001",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "AE",
    visaType: "TOURIST",
    caseStatus: "SUBMITTED",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-01",
    lineItems: [],
    totalInr: 0,
    applicants: [
      { applicantRef: "A1", travellerId: "trv_1", custody: "WITH_RGS", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "trv_2", custody: "WITH_RGS", outcome: "PENDING" },
    ],
    watchdogOverrides: {},
    mutedRules: [],
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * Renders the hook inside real providers and surfaces its result through
 * `onReady`, plus the minimum DOM for the 409 assertions -- the same bargain
 * `mutations.test.tsx`'s own harness strikes. `CasePage`'s `<ConflictPrompt>`
 * is the real thing a desk agent sees; this is the hook's own contract.
 */
function ApplicantEditHarness({ onReady }: { onReady: (api: UseApplicantEditResult) => void }) {
  const applicantEdit = useApplicantEdit();
  onReady(applicantEdit);
  if (applicantEdit.pendingConflict === undefined) return null;
  const { edit, serverMessage } = applicantEdit.pendingConflict;
  return (
    <div role="alertdialog">
      <p>This case changed underneath your edit.</p>
      <p>{serverMessage}</p>
      <p>Your value: {describeApplicantEditValue(edit)}</p>
      <button onClick={() => applicantEdit.resolveConflict("keepMine")}>Keep mine</button>
      <button onClick={() => applicantEdit.resolveConflict("keepTheirs")}>Keep theirs</button>
    </div>
  );
}

function renderApplicantEditWithDeferredApi(seededCase: crm.CrmCase = buildCase()) {
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
  queryClient.setQueryData(crmQueryKeys.case(seededCase.caseId), seededCase);

  let applicantEditApi: UseApplicantEditResult | undefined;

  render(
    <QueryClientProvider client={queryClient}>
      <UndoToastProvider>
        <ApplicantEditHarness
          onReady={(api) => {
            applicantEditApi = api;
          }}
        />
      </UndoToastProvider>
    </QueryClientProvider>,
  );

  async function commitEdit(edit: ApplicantEdit): Promise<void> {
    if (applicantEditApi === undefined) throw new Error("useApplicantEdit has not rendered yet");
    await act(async () => {
      await applicantEditApi!.commitEdit(edit);
    });
  }

  return { queryClient, requestLog, resolveRequest, rejectRequest, commitEdit };
}

function cachedApplicant(
  queryClient: QueryClient,
  caseId: string,
  applicantRef: string,
): crm.CaseApplicant {
  const caseRecord = queryClient.getQueryData<crm.CrmCase>(crmQueryKeys.case(caseId));
  const applicant = caseRecord?.applicants.find(
    (candidateApplicant) => candidateApplicant.applicantRef === applicantRef,
  );
  if (applicant === undefined) throw new Error(`applicant ${applicantRef} is not in the cached case ${caseId}`);
  return applicant;
}

const CUSTODY_EDIT: ApplicantEdit = {
  caseId: "case_1",
  applicantRef: "A2",
  axis: "custody",
  fromValue: "WITH_RGS",
  toValue: "AT_EMBASSY",
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("useApplicantEdit", () => {
  it("writes the new custody into the case cache before the request resolves", async () => {
    const { queryClient, commitEdit, resolveRequest } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);

    expect(cachedApplicant(queryClient, "case_1", "A2").custody).toBe("AT_EMBASSY");
    // Its sibling is untouched -- the same claim `CasePage.test.tsx` makes
    // about the request path, made here about the optimistic cache write.
    expect(cachedApplicant(queryClient, "case_1", "A1").custody).toBe("WITH_RGS");
    // Settled inside `act` before the test ends: the success path calls
    // `showUndo`, and a `setToasts` that lands after the assertions -- outside
    // any act() -- is a React warning on stderr, not a failure, which is
    // exactly the kind of noise that hides a real one.
    await act(async () => {
      resolveRequest(buildCase());
    });
  });

  it("puts the old custody back when the request fails", async () => {
    const { queryClient, commitEdit, rejectRequest } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);
    expect(cachedApplicant(queryClient, "case_1", "A2").custody).toBe("AT_EMBASSY");

    await act(async () => {
      rejectRequest(new ApiRequestError(500, "INTERNAL", "The database is unavailable"));
    });

    await waitFor(() => expect(cachedApplicant(queryClient, "case_1", "A2").custody).toBe("WITH_RGS"));
  });

  it("shows both values on a 409 and writes nothing until the human picks", async () => {
    const { commitEdit, rejectRequest, requestLog } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move custody from RETURNED to AT_EMBASSY"));
    });

    await screen.findByText(/changed underneath/i);
    // The server's own words, not a paraphrase (rule 4).
    expect(screen.getByText(/Cannot move custody from RETURNED to AT_EMBASSY/)).toBeInTheDocument();
    // The human's value through its label map -- never the raw enum.
    expect(screen.getByText("Your value: At embassy")).toBeInTheDocument();
    // Asserted against the request log rather than inferred from the dialog:
    // nothing was written while the prompt waits.
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
  });

  it("keepMine retries the human's own value as a fresh, optimistic write", async () => {
    const user = userEvent.setup();
    const { queryClient, commitEdit, rejectRequest, requestLog } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move custody from RETURNED to AT_EMBASSY"));
    });
    await screen.findByText(/changed underneath/i);

    await user.click(screen.getByRole("button", { name: /keep mine/i }));

    await waitFor(() => expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(2));
    // The retry goes to the SAME applicant's route, not the case's.
    expect(requestLog.filter((entry) => entry.method === "PUT")[1]!.url).toContain(
      "/cases/case_1/applicants/A2/custody",
    );
    expect(cachedApplicant(queryClient, "case_1", "A2").custody).toBe("AT_EMBASSY");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keepTheirs writes nothing further and closes the prompt", async () => {
    const user = userEvent.setup();
    const { commitEdit, rejectRequest, requestLog } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);
    await act(async () => {
      rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move custody from RETURNED to AT_EMBASSY"));
    });
    await screen.findByText(/changed underneath/i);

    await user.click(screen.getByRole("button", { name: /keep theirs/i }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
  });

  it("offers undo, and the undo is a real inverse write through the same applicant route", async () => {
    // WITH_RGS -> AT_EMBASSY is reversible (`CUSTODY_TRANSITIONS` has
    // AT_EMBASSY -> WITH_RGS), which is what makes this the undoable branch.
    const user = userEvent.setup();
    const { commitEdit, resolveRequest, requestLog } = renderApplicantEditWithDeferredApi();

    await commitEdit(CUSTODY_EDIT);
    await act(async () => {
      resolveRequest(buildCase());
    });

    expect(await screen.findByText(/Custody for applicant A2 changed to At embassy/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => {
      const writes = requestLog.filter((entry) => entry.method === "PUT");
      expect(writes).toHaveLength(2);
      expect(writes[1]!.url).toContain("/cases/case_1/applicants/A2/custody");
      expect(writes[1]!.body).toEqual({ toCustody: "WITH_RGS" });
    });
  });

  it("undoes an outcome edit through the outcome route, not the custody one", async () => {
    // PENDING -> SENT_BACK, and SENT_BACK -> PENDING is the one legal reverse
    // edge in `OUTCOME_TRANSITIONS`. Pinned separately because
    // `mutationForAxis` is the only thing standing between these two routes.
    const user = userEvent.setup();
    const { commitEdit, resolveRequest, requestLog } = renderApplicantEditWithDeferredApi();

    await commitEdit({
      caseId: "case_1",
      applicantRef: "A1",
      axis: "outcome",
      fromValue: "PENDING",
      toValue: "SENT_BACK",
    });
    await act(async () => {
      resolveRequest(buildCase());
    });

    await user.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => {
      const writes = requestLog.filter((entry) => entry.method === "PUT");
      expect(writes).toHaveLength(2);
      expect(writes[1]!.url).toContain("/cases/case_1/applicants/A1/outcome");
      expect(writes[1]!.body).toEqual({ toOutcome: "PENDING" });
    });
  });

  it("says an undo is impossible rather than offering one that will 409", async () => {
    // `RETURNED` has no outgoing custody edge at all, so an undo back to
    // WITH_RGS would be refused by the same state machine the server enforces.
    const { commitEdit, resolveRequest } = renderApplicantEditWithDeferredApi();

    await commitEdit({
      caseId: "case_1",
      applicantRef: "A2",
      axis: "custody",
      fromValue: "WITH_RGS",
      toValue: "RETURNED",
    });
    await act(async () => {
      resolveRequest(buildCase());
    });

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/custody for applicant A2 is now Returned/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });

  it("says an undo of a decided outcome is impossible too", async () => {
    // APPROVED is terminal in `OUTCOME_TRANSITIONS` -- the correction path
    // APPROVED <-> REJECTED was deliberately left out of the shared state
    // machine, so there is nothing to undo to.
    const { commitEdit, resolveRequest } = renderApplicantEditWithDeferredApi();

    await commitEdit({
      caseId: "case_1",
      applicantRef: "A1",
      axis: "outcome",
      fromValue: "PENDING",
      toValue: "APPROVED",
    });
    await act(async () => {
      resolveRequest(buildCase());
    });

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });
});
