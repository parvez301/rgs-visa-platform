import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerPage } from "../../src/crm/ledger/LedgerPage";
import { useLedgerRows, usePartners } from "../../src/crm/api/hooks";
import type { LedgerLoad, OpenReviewSummaryEntry } from "../../src/crm/api/crmClient";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { AgentPanelProvider } from "../../src/crm/agent/AgentPanelProvider";
import { mountedCell } from "./virtual";

/**
 * `AdminShell` renders a react-router `<Link>`/`<NavLink>` in its header.
 * `LedgerTable` (Task 12) calls `useLedgerEdit()` unconditionally, which
 * needs a `QueryClientProvider` and an `UndoToastProvider` as ancestors even
 * though this file mocks `useLedgerRows`/`usePartners` themselves away.
 */
function renderLedgerPage(element: ReactElement = <LedgerPage />) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UndoToastProvider>
        <AgentPanelProvider>
          <MemoryRouter>{element}</MemoryRouter>
        </AgentPanelProvider>
      </UndoToastProvider>
    </QueryClientProvider>,
  );
}

/**
 * `LedgerPage` reacts to a load result -- it does not fetch one. Mocking at
 * the hook boundary (Task 10 fix round 1, F1) keeps this file about that
 * reaction: whether the partial-ledger banner shows the right thing at the
 * right time, and whether the filter bar's mutual exclusion ever leaves an
 * agent stuck in one mode. `crmClient` and `useLedgerRows`'s own query-key
 * behaviour already have their own tests (crmClient.test.ts, hooks.test.ts).
 */
vi.mock("../../src/crm/api/hooks", async (importOriginal) => {
  const actualHooksModule = await importOriginal<typeof import("../../src/crm/api/hooks")>();
  return {
    ...actualHooksModule,
    useLedgerRows: vi.fn(),
    usePartners: vi.fn(),
    // Task 15: `CrmLayout`'s right column renders `AgentPanel`, which runs
    // these three queries on mount. Pinned to "still loading" rather than left
    // real, because this file stubs no `fetch` at all -- a real query here
    // would reach `.env.local`'s VITE_API_URL from a unit test. Nothing below
    // asserts anything about the panel.
    useProposals: () => STILL_LOADING_QUERY,
    useMemories: () => STILL_LOADING_QUERY,
    // Task 16: `LedgerPage` reads the open-review summary once for the whole
    // screen. Served from a variable rather than a `vi.fn` so the default
    // survives `test/setup.ts`'s `vi.restoreAllMocks()` -- every test that
    // says nothing about review markers gets "still loading" and therefore no
    // markers, exactly as it did before this hook existed.
    useReviewSummary: () => currentReviewSummaryQuery,
  };
});

/** Shared by the agent hooks the mock above pins; see its comment. */
const STILL_LOADING_QUERY = { data: undefined, isLoading: true, isError: false, error: null };

let currentReviewSummaryQuery: unknown = STILL_LOADING_QUERY;

/**
 * G6: `unreadableReviewItemIds` was hard-coded to `[]` here, which made the one
 * field nothing READ look exactly like the three that are read. It is a real
 * parameter now, defaulted so every existing caller keeps its meaning.
 */
function stubReviewSummary(
  entries: OpenReviewSummaryEntry[],
  unreadableReviewItemIds: string[] = [],
): void {
  currentReviewSummaryQuery = {
    data: { entries, unreadableReviewItemIds },
    isLoading: false,
    isError: false,
    error: null,
  };
}

afterEach(() => {
  currentReviewSummaryQuery = STILL_LOADING_QUERY;
});

/**
 * `AdminShell` (rendered inside `CrmLayout`) reads `useAuth` for the header's
 * email and sign-out button. Mocked rather than wrapped in a real
 * `AuthProvider`, so this file never touches Cognito or `localStorage` --
 * this page's own tests have nothing to say about auth.
 */
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

const mockedUseLedgerRows = vi.mocked(useLedgerRows);
const mockedUsePartners = vi.mocked(usePartners);

/**
 * `useLedgerRows`/`usePartners` are typed as `UseQueryResult<...>`, a large
 * discriminated union covering every fetch state react-query can be in. This
 * page reads only `data`, `isLoading` and `isError`/`error` from either
 * query, so the double assertion confines the "this is not really the full
 * union" lie to one place rather than repeating it at every call site.
 */
function fakeQueryResult<QueryData>(
  overrides: Partial<UseQueryResult<QueryData, Error>> & { isFetchingMore?: boolean },
): UseQueryResult<QueryData, Error> & { isFetchingMore: boolean } {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetchingMore: false,
    ...overrides,
  } as unknown as UseQueryResult<QueryData, Error> & { isFetchingMore: boolean };
}

function buildLedgerRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_0001",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  };
}

function stubLedgerLoad(overrides: Partial<LedgerLoad> = {}): LedgerLoad {
  const ledgerLoad: LedgerLoad = {
    rows: [buildLedgerRow()],
    unreadableCaseIds: [],
    truncated: false,
    appliedQuery: { statuses: [], limit: 500 },
    ...overrides,
  };
  mockedUseLedgerRows.mockReturnValue(fakeQueryResult<LedgerLoad>({ data: ledgerLoad }));
  return ledgerLoad;
}

const onePartner: crm.Partner = {
  tenantId: "tenant_1",
  partnerId: "partner_1",
  canonicalName: "Skyline Travels",
  aliases: [],
  partnerType: "AGENCY",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function stubPartners(partners: crm.Partner[] = [onePartner]): void {
  mockedUsePartners.mockReturnValue(fakeQueryResult<crm.Partner[]>({ data: partners }));
}

describe("LedgerPage — the partial-ledger banner", () => {
  it("renders no banner on a clean load", () => {
    stubLedgerLoad({ truncated: false, unreadableCaseIds: [] });
    stubPartners();
    // Explicitly clean on BOTH axes now that the banner has a third reason to
    // appear: a summary with no unreadable items must still produce silence.
    stubReviewSummary([{ caseRef: "RGS-1001", openReasons: [], fieldItemIds: ["rev_1"], mergeItemIds: [] }], []);

    renderLedgerPage();

    // A banner that always shows is exactly as useless as one that never
    // does -- this case is as load-bearing as the other three.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says when import-review items could not be read, so a marked row is not silently clean (D40)", () => {
    // Finding #5. `summariseOpenReviewItems` goes out of its way to name the
    // items it could not parse and `LedgerPage` read `entries` alone, so a case
    // whose review items are unreadable rendered as a clean row -- which
    // inverts the markers' entire purpose (spec §7). The ledger itself is
    // complete here, which is the point: this banner has to appear on a screen
    // that has no OTHER reason to show one.
    stubLedgerLoad({ truncated: false, unreadableCaseIds: [] });
    stubPartners();
    stubReviewSummary([], ["rev_bad_1", "rev_bad_2"]);

    renderLedgerPage();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("2 import-review items could not be read");
    // The ledger's own two sentences stay out of it -- neither condition holds.
    expect(banner.textContent).not.toContain("Loaded the first");
    expect(banner.textContent).not.toContain("could not be read from storage");
  });

  it("says all three things at once, and none hides the others", () => {
    const shownRows = Array.from({ length: 4 }, (_unused, rowIndex) =>
      buildLedgerRow({ caseId: `case_${rowIndex}` }),
    );
    stubLedgerLoad({ rows: shownRows, truncated: true, unreadableCaseIds: ["case_x"] });
    stubPartners();
    stubReviewSummary([], ["rev_bad_1"]);

    renderLedgerPage();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Loaded the first 4 cases");
    expect(banner.textContent).toContain("1 case could not be read from storage");
    // Singular, and still its own sentence rather than a clause appended to
    // the one above it.
    expect(banner.textContent).toContain("1 import-review item could not be read");
  });

  it("names how many rows ARE shown when truncated, never a fabricated missing count", () => {
    const shownRows = Array.from({ length: 5 }, (_unused, rowIndex) =>
      buildLedgerRow({ caseId: `case_${rowIndex}` }),
    );
    stubLedgerLoad({ rows: shownRows, truncated: true, unreadableCaseIds: [] });
    stubPartners();

    renderLedgerPage();

    const banner = screen.getByRole("status");
    // F2: the count of MISSING rows is unknowable client-side once the walk
    // stops at MAX_LEDGER_PAGES -- the banner must say how many loaded
    // instead, never fabricate a total. R48 (fix round 1, F6): "Loaded", not
    // "Showing" -- the number counts rows the client HOLDS, which is not the
    // same as the rows on screen the moment any client-side filter is on.
    expect(banner.textContent).toContain("Loaded the first 5 cases");
    expect(banner.textContent).not.toContain("could not be read");
  });

  it("states the exact unreadable-case count when that is the only problem", () => {
    stubLedgerLoad({ truncated: false, unreadableCaseIds: ["case_a", "case_b"] });
    stubPartners();

    renderLedgerPage();

    const banner = screen.getByRole("status");
    // Unlike the truncated count, this one IS known exactly -- it is
    // unreadableCaseIds.length -- so the banner states it precisely.
    expect(banner.textContent).toContain("2 cases could not be read from storage");
    expect(banner.textContent).not.toContain("Loaded the first");
  });

  it("says both things when both are true, and neither hides the other", () => {
    const shownRows = Array.from({ length: 10 }, (_unused, rowIndex) =>
      buildLedgerRow({ caseId: `case_${rowIndex}` }),
    );
    stubLedgerLoad({ rows: shownRows, truncated: true, unreadableCaseIds: ["case_x"] });
    stubPartners();

    renderLedgerPage();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Loaded the first 10 cases");
    expect(banner.textContent).toContain("1 case could not be read from storage");
  });


  it("names the LOADED count, not the filtered count, when a client-side filter is also on (R48)", async () => {
    const user = userEvent.setup();
    const fiveDistinctRows = Array.from({ length: 5 }, (_unused, rowIndex) =>
      buildLedgerRow({ caseId: `case_${rowIndex}`, caseRef: `RGS-100${rowIndex}` }),
    );
    stubLedgerLoad({ rows: fiveDistinctRows, truncated: true, unreadableCaseIds: [] });
    stubPartners();

    const { container } = renderLedgerPage();
    // The whole term. Round 1 could only type ONE character here: the grid's
    // focus-sync effect pulled DOM focus out of this input on the re-render
    // the first keystroke caused, and the rest of the term went to the grid
    // as keymap input. Fix round 2's F7 guard is what makes a real search
    // term typable, and this line would go back to holding "R" without it.
    await user.type(screen.getByLabelText("Search"), "RGS-1004");

    // The filter really is in force -- without this the assertion below is
    // about a table that never filtered anything.
    expect(container.querySelectorAll("[data-testid='ledger-row']")).toHaveLength(1);

    const banner = screen.getByRole("status");
    // The number names the LOAD BOUNDARY: how much of the ledger this client
    // holds, which is what tells a desk agent whether the case they are
    // hunting for could be past the edge of what was fetched. A client-side
    // filter does not move that boundary, so the number must not follow it
    // down to 1 -- and the verb must not claim to describe what is on screen.
    expect(banner.textContent).toContain("Loaded the first 5 cases");
    expect(banner.textContent).not.toContain("Showing");
    expect(banner.textContent).not.toContain("Loaded the first 1 case");
  });
});

describe("LedgerPage — the status/partner filter exclusion", () => {
  it("clears the status selection when a partner is chosen, and back again", async () => {
    const user = userEvent.setup();
    stubLedgerLoad();
    stubPartners();

    renderLedgerPage();

    await user.click(screen.getByRole("button", { name: /Status ·/ }));
    // Live work is the default open view, so New starts pressed.
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "true");

    await user.selectOptions(screen.getByRole("combobox", { name: "Partner" }), "partner_1");
    // Selecting a partner must clear the status filter -- the server only
    // ever honors one of the two (LedgerAppliedQuery is a union), so a
    // status chip left highlighted here would be lying about what is
    // actually being filtered.
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "false");
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith([], "partner_1");

    // Not stuck: choosing "All partners" clears the partner filter and
    // leaves status filtering selectable again.
    await user.selectOptions(screen.getByRole("combobox", { name: "Partner" }), "");
    expect(screen.getByRole("combobox", { name: "Partner" })).toHaveValue("");
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith([], undefined);

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "true");
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith(["NEW"], undefined);
  });

  it("clears the partner selection the moment a status is chosen -- the reverse direction", async () => {
    const user = userEvent.setup();
    stubLedgerLoad();
    stubPartners();

    renderLedgerPage();

    await user.selectOptions(screen.getByRole("combobox", { name: "Partner" }), "partner_1");
    expect(screen.getByRole("combobox", { name: "Partner" })).toHaveValue("partner_1");
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith([], "partner_1");

    // The reverse of the first test's transition, starting from partner mode
    // rather than ending there: a status button must not be a dead end.
    // Nothing else in this component disables it while a partner is
    // selected, so this click alone must both select the status and drop
    // the partner filter in the same step.
    await user.click(screen.getByRole("button", { name: /Status ·/ }));
    await user.click(screen.getByRole("button", { name: "In progress" }));
    expect(screen.getByRole("combobox", { name: "Partner" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "In progress" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith(["IN_PROGRESS"], undefined);
  });
});

describe("LedgerPage — review markers on the row (spec §7)", () => {
  it("marks only the rows whose case has open review items, from one summary read", () => {
    stubLedgerLoad({
      rows: [
        buildLedgerRow({ caseId: "case_0001", caseRef: "RGS-1001" }),
        buildLedgerRow({ caseId: "case_0002", caseRef: "RGS-1002" }),
      ],
    });
    stubPartners();
    // Joined on `caseRef` (R66): the summary is built from review items, which
    // name a workbook ref and never a caseId.
    stubReviewSummary([{ caseRef: "RGS-1002", openReasons: [], fieldItemIds: ["rev_1"], mergeItemIds: ["rev_9"] }]);

    const { container } = renderLedgerPage();

    // Through the harness helper, never a hand-rolled selector (fix round 1,
    // F3): `mountedCell` throws when the virtualizer mounted nothing, which is
    // the one thing that would make every assertion below pass vacuously --
    // spec §10's first named trap. A raw `querySelector` with a `!` is how
    // that door gets re-opened.
    const markedRefCell = mountedCell(container, "case_0002", "caseRef");
    // Both kinds, because this case carries both kinds of work -- and they are
    // separate marks, because they are resolved by separate judgements.
    expect(within(markedRefCell).getByRole("button", { name: /1 import problem/i })).toBeInTheDocument();
    expect(within(markedRefCell).getByRole("button", { name: /may be a duplicate/i })).toBeInTheDocument();

    // The row the summary said nothing about carries no mark at all. Without
    // this the assertions above would also pass for a table that marked every
    // row it rendered.
    const cleanRefCell = mountedCell(container, "case_0001", "caseRef");
    expect(within(cleanRefCell).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("LedgerPage — the issue filter", () => {
  it("narrows the grid to the loaded cases carrying one open reason, badged or not, and counts them in the option", () => {
    stubLedgerLoad({
      truncated: false,
      unreadableCaseIds: [],
      rows: [
        buildLedgerRow({ caseId: "case_0001", caseRef: "RGS-1001" }),
        buildLedgerRow({ caseId: "case_0002", caseRef: "RGS-1002" }),
        buildLedgerRow({ caseId: "case_0003", caseRef: "RGS-1003" }),
      ],
    });
    stubPartners();
    stubReviewSummary([
      { caseRef: "RGS-1001", openReasons: ["UNMAPPED_PARTNER"], fieldItemIds: ["rev_1"], mergeItemIds: [] },
      // A guess: open, not badged (no item ids), but still filterable.
      { caseRef: "RGS-1002", openReasons: ["PROPOSED_GROUP"], fieldItemIds: [], mergeItemIds: [] },
    ]);

    renderLedgerPage();
    const issueSelect = screen.getByLabelText("Issue") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "With an open issue (2)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Without open issues (1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "May belong with another case (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Country not recognised/ })).toBeNull();

    fireEvent.change(issueSelect, { target: { value: "PROPOSED_GROUP" } });
    expect(screen.getByText("RGS-1002")).toBeInTheDocument();
    expect(screen.queryByText("RGS-1001")).toBeNull();
    expect(screen.queryByText("RGS-1003")).toBeNull();
    expect(screen.getByText("Showing 1 of 3 loaded cases")).toBeInTheDocument();

    fireEvent.change(issueSelect, { target: { value: "__no_issue__" } });
    expect(screen.getByText("RGS-1003")).toBeInTheDocument();
    expect(screen.queryByText("RGS-1001")).toBeNull();
  });
});
