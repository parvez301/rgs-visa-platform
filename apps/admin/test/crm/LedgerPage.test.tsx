import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerPage } from "../../src/crm/ledger/LedgerPage";
import { useLedgerRows, usePartners } from "../../src/crm/api/hooks";
import type { LedgerLoad } from "../../src/crm/api/crmClient";

/** `AdminShell` renders a react-router `<Link>`/`<NavLink>` in its header. */
function renderLedgerPage(element: ReactElement = <LedgerPage />) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

/**
 * `LedgerPage` reacts to a load result -- it does not fetch one. Mocking at
 * the hook boundary (Task 10 fix round 1, F1) keeps this file about that
 * reaction: whether the partial-ledger banner shows the right thing at the
 * right time, and whether the filter bar's mutual exclusion ever leaves an
 * agent stuck in one mode. `crmClient` and `useLedgerRows`'s own query-key
 * behaviour already have their own tests (crmClient.test.ts, hooks.test.ts).
 */
vi.mock("../../src/crm/api/hooks", () => ({
  useLedgerRows: vi.fn(),
  usePartners: vi.fn(),
}));

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
  overrides: Partial<UseQueryResult<QueryData, Error>>,
): UseQueryResult<QueryData, Error> {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<QueryData, Error>;
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

    renderLedgerPage();

    // A banner that always shows is exactly as useless as one that never
    // does -- this case is as load-bearing as the other three.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
    // instead, never fabricate a total.
    expect(banner.textContent).toContain("Showing the first 5 cases");
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
    expect(banner.textContent).not.toContain("Showing the first");
  });

  it("says both things when both are true, and neither hides the other", () => {
    const shownRows = Array.from({ length: 10 }, (_unused, rowIndex) =>
      buildLedgerRow({ caseId: `case_${rowIndex}` }),
    );
    stubLedgerLoad({ rows: shownRows, truncated: true, unreadableCaseIds: ["case_x"] });
    stubPartners();

    renderLedgerPage();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Showing the first 10 cases");
    expect(banner.textContent).toContain("1 case could not be read from storage");
  });
});

describe("LedgerPage — the status/partner filter exclusion", () => {
  it("clears the status selection when a partner is chosen, and back again", async () => {
    const user = userEvent.setup();
    stubLedgerLoad();
    stubPartners();

    renderLedgerPage();

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("button", { name: "New" })).toHaveAttribute("aria-pressed", "true");
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith(["NEW"], undefined);

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
    await user.click(screen.getByRole("button", { name: "In progress" }));
    expect(screen.getByRole("combobox", { name: "Partner" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "In progress" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mockedUseLedgerRows).toHaveBeenLastCalledWith(["IN_PROGRESS"], undefined);
  });
});
