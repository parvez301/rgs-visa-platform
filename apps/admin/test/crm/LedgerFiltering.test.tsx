import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { installVirtualScrolling, mountedCell, renderLedger } from "./virtual";

/**
 * What happens to the grid's INDEX-keyed state (focus, selection, expansion --
 * `useGridKeyboard.ts`) when the rows those indexes address are replaced
 * underneath them. Task 13 is what made that routine: `LedgerPage` re-filters
 * and re-sorts client-side on every keystroke in the search box and on every
 * view chip click, where before this branch `rows` only ever changed on a
 * server refetch.
 *
 * Separate from `LedgerKeyboard.test.tsx` because these tests are not about
 * the keymap at all -- they drive one keypress only to get a row expanded,
 * and everything they assert is about the re-render that follows.
 */
installVirtualScrolling();

/**
 * Expanding a row mounts `<ApplicantSubRows>`, which calls `useCase` and
 * therefore `fetch`. A promise that never resolves leaves that query loading
 * forever -- which is all these tests need (the loading line is as good a
 * proof that the component mounted as a list of applicants would be) and
 * keeps this file from making a real network call to `.env.local`'s
 * `VITE_API_URL`.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildRow(caseId: string, caseRef: string): crm.LedgerRow {
  return {
    caseId,
    caseRef,
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    totalInr: 12_000,
    updatedAt: "2026-03-04T10:00:00.000Z",
  };
}

const allThreeRows: crm.LedgerRow[] = [
  buildRow("case_1001", "RGS-1001"),
  buildRow("case_1002", "RGS-1002"),
  buildRow("case_1003", "RGS-1003"),
];

/** The disclosed sub-row block under one specific case, if it is mounted at all. */
function mountedSubRowsFor(container: HTMLElement, caseId: string): Element | null {
  return container.querySelector(
    `[data-testid='ledger-row'][data-case-id='${caseId}'] [data-testid='applicant-subrows-loading']`,
  );
}

/** Every case id whose row is currently rendering its applicants, expanded. */
function expandedCaseIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-testid='ledger-row']")]
    .filter((rowElement) => rowElement.querySelector("[data-testid^='applicant-subrows']") !== null)
    .map((rowElement) => rowElement.getAttribute("data-case-id") ?? "");
}

describe("LedgerTable under a client-side filter (fix round 1, F2)", () => {
  it("does not leave another case's applicants disclosed when the expanded case is filtered away", async () => {
    const user = userEvent.setup();
    const { container, rerenderLedger } = renderLedger(
      <LedgerTable rows={allThreeRows} partnerNamesById={{}} />,
    );

    // The REF column's overloaded → expands row 0, which is RGS-1001.
    await user.click(mountedCell(container, "case_1001", "caseRef"));
    await user.keyboard("{ArrowRight}");
    expect(mountedSubRowsFor(container, "case_1001")).not.toBeNull();

    // Now a search keystroke filters RGS-1001 out. Expansion is stored as the
    // NUMBER 0, so without a remap row 0 -- a different case entirely -- keeps
    // rendering expanded and mounts `<ApplicantSubRows>` against a case the
    // desk agent never expanded.
    rerenderLedger(<LedgerTable rows={[allThreeRows[1]!, allThreeRows[2]!]} partnerNamesById={{}} />);

    expect(expandedCaseIds(container)).toEqual([]);
    expect(mountedSubRowsFor(container, "case_1002")).toBeNull();
  });

  it("keeps the expansion with its own case when filtering moves that case to a new index", async () => {
    const user = userEvent.setup();
    const { container, rerenderLedger } = renderLedger(
      <LedgerTable rows={allThreeRows} partnerNamesById={{}} />,
    );

    // Expand the MIDDLE row, so the remap has somewhere to move it to.
    await user.click(mountedCell(container, "case_1002", "caseRef"));
    await user.keyboard("{ArrowRight}");
    expect(mountedSubRowsFor(container, "case_1002")).not.toBeNull();

    // RGS-1001 drops out: RGS-1002 is row 0 now. Resetting expansion outright
    // would pass the test above and fail this one -- a desk agent who filters
    // the list must not silently lose the disclosure they are reading.
    rerenderLedger(<LedgerTable rows={[allThreeRows[1]!, allThreeRows[2]!]} partnerNamesById={{}} />);

    expect(expandedCaseIds(container)).toEqual(["case_1002"]);
  });

  it("moves the focused cell with its own case rather than leaving focus on the row that took its index", async () => {
    const user = userEvent.setup();
    const { container, rerenderLedger } = renderLedger(
      <LedgerTable rows={allThreeRows} partnerNamesById={{}} />,
    );

    await user.click(mountedCell(container, "case_1003", "partner"));
    expect(mountedCell(container, "case_1003", "partner")).toHaveFocus();

    // RGS-1003 slides from index 2 to index 1. Focus is stored as a pair of
    // numbers, so an unreconciled `rowIndex: 2` now points past the end of a
    // two-row list.
    rerenderLedger(<LedgerTable rows={[allThreeRows[0]!, allThreeRows[2]!]} partnerNamesById={{}} />);

    // The roving tabindex, not `toHaveFocus`: each row element is keyed by
    // `caseId`, so the focused cell is never unmounted by this filter and
    // keeps DOM focus either way -- that assertion would pass against a
    // focus index pointing at nothing. `tabindex="0"` is computed from
    // `gridState.focus` on every render, so it is the one thing on screen
    // that goes wrong when the stored index no longer names this case: with
    // focus stranded past the end NO cell is a tab stop, and tabbing into the
    // grid from outside lands nowhere.
    expect(mountedCell(container, "case_1003", "partner")).toHaveAttribute("tabindex", "0");
  });
});
