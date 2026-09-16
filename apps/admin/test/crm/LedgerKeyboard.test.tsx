import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import type { OpenReviewSummaryEntry } from "../../src/crm/api/crmClient";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { installVirtualScrolling, mountedCaseIds, mountedCell, mountedGridRow, renderLedger } from "./virtual";

// This test drives the virtualizer's own scrollToIndex (keyboard nav past
// the mounted window) rather than only the scrollTop+dispatchEvent that
// scrollLedgerTo already covers, so it needs the two-part jsdom shim -- see
// installVirtualScrolling's doc comment in ./virtual.ts for both causes.
installVirtualScrolling();

/**
 * Task 13: the grid's default focus starts on row 0's REF cell, and the
 * REF column's → is overloaded to expand rather than move on a collapsed
 * row (useGridKeyboard.ts) -- several tests below send a bare → (some
 * deliberately, one only because it iterates every consumed key) and so
 * expand row 0 as a side effect. Expanding mounts `<ApplicantSubRows>`,
 * which calls `useCase` and therefore `fetch`. None of the tests in this
 * file assert anything about sub-row content, so a `fetch` that never
 * resolves is the simplest correct stub -- it leaves that query loading
 * forever, which nothing here observes -- and (the actual reason this
 * exists) it is what keeps this file from making a REAL network call to
 * apps/admin/.env.local's `VITE_API_URL` every time one of those tests
 * runs.
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

/**
 * Written out rather than imported from `columns.tsx`/`ApplicantSubRows.tsx`:
 * an assertion built from the same constants the component computes its height
 * from would still hold if both moved together, which is exactly the change
 * this file exists to catch.
 */
const LEDGER_ROW_HEIGHT_PX = 40;
const APPLICANT_SUBROW_LINE_HEIGHT_PX = 28;

function buildRows(rowCount: number): crm.LedgerRow[] {
  return Array.from({ length: rowCount }, (_unused, rowIndex) => ({
    caseId: `case_${String(rowIndex).padStart(4, "0")}`,
    caseRef: `RGS-${1000 + rowIndex}`,
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA" as const,
    visaType: "TOURIST" as const,
    caseStatus: "IN_PROGRESS" as const,
    billingStatus: "UNKNOWN" as const,
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-04T10:00:00.000Z",
  }));
}

/** Constructs and dispatches a real, cancelable `KeyboardEvent` and hands
 * back the same event object so a test can inspect `defaultPrevented`
 * afterwards -- `cancelable: true` is not optional: a non-cancelable event's
 * `defaultPrevented` stays `false` no matter how many times a handler calls
 * `preventDefault()`, which would make this red-proof pass against a handler
 * that never calls it at all. */
function dispatchGridKeyDown(gridElement: Element, key: string, eventInit: KeyboardEventInit = {}): KeyboardEvent {
  const keyboardEvent = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...eventInit });
  act(() => {
    gridElement.dispatchEvent(keyboardEvent);
  });
  return keyboardEvent;
}

function getGridElement(container: HTMLElement): HTMLElement {
  const gridElement = container.querySelector<HTMLElement>("[data-testid='ledger-scroll']");
  if (gridElement === null) throw new Error("No ledger scroll/grid container in this render");
  return gridElement;
}

/**
 * Every mounted row's `translateY` offset, in mounted order -- the only thing
 * in this file that can see one row painting over the next, since jsdom has no
 * layout engine to ask for a real rect. Shared by both overlap tests below:
 * they differ only in what they expect the gaps to be, never in how the gaps
 * are read.
 */
function readMountedRowTops(container: HTMLElement): number[] {
  return mountedCaseIds(container).map((caseId) => {
    const rowElement = container.querySelector<HTMLElement>(
      `[data-testid='ledger-row'][data-case-id='${caseId}']`,
    );
    if (rowElement === null) throw new Error(`Row ${caseId} vanished between listing and measuring`);
    const translateYMatch = /translateY\((\d+)px\)/.exec(rowElement.style.transform);
    if (translateYMatch === null) {
      throw new Error(
        `Row ${caseId} has no translateY in its transform ("${rowElement.style.transform}") -- ` +
          "this test can only see the overlap bug if rows are positioned by transform.",
      );
    }
    return Number(translateYMatch[1]);
  });
}

/**
 * Reads back the router location `renderLedger`'s own `MemoryRouter` is
 * holding. Rendered as a sibling of the table rather than as a `<Routes>`
 * probe, so this asserts where the grid NAVIGATED TO without also asserting
 * anything about what `/crm/cases/:caseId` renders -- that is `CasePage`'s own
 * test file's job.
 */
function RouterLocationProbe() {
  const routerLocation = useLocation();
  return <span data-testid="router-location">{routerLocation.pathname}</span>;
}

/**
 * One open review item on the FIRST row, which is where the grid's focus
 * starts -- so the chip R74 makes tabbable is the chip these tests reach.
 */
const FIRST_ROW_HAS_ONE_REVIEW_ITEM: ReadonlyMap<string, OpenReviewSummaryEntry> = new Map([
  ["RGS-1000", { caseRef: "RGS-1000", openReasons: [], fieldItemIds: ["rev_1"], mergeItemIds: [] }],
]);

/**
 * The review-marker chip on one mounted row, reached through `mountedCell` so
 * a chip the virtualizer never mounted fails as "not among the mounted rows"
 * rather than as a quietly absent element (spec §10's first named trap). The
 * REF cell's only other child is the `<a>`, so the button in it is the marker.
 */
function markerChipOnRow(container: HTMLElement, caseId: string): HTMLElement {
  return within(mountedCell(container, caseId, "caseRef")).getByRole("button", {
    name: /1 import problem/i,
  });
}

describe("LedgerTable keyboard and selection", () => {
  it("opens the focused REF cell's case on Enter (R65)", async () => {
    // A keyboard-only desk agent had no way to reach a case at all: the REF
    // `<Link>` carries `tabIndex={-1}` (it must -- an anchor per mounted row
    // would put ~180 tab stops in the grid and change what Tab does), and the
    // REF column is not editable, so Enter was bound to `beginEdit` on a cell
    // with no editor and did nothing visible.
    const user = userEvent.setup();
    const { container } = renderLedger(
      <>
        <LedgerTable rows={buildRows(50)} partnerNamesById={{}} />
        <RouterLocationProbe />
      </>,
    );
    await user.click(mountedCell(container, "case_0001", "caseRef"));

    expect(screen.getByTestId("router-location").textContent).toBe("/");

    dispatchGridKeyDown(getGridElement(container), "Enter");

    expect(screen.getByTestId("router-location").textContent).toBe("/crm/cases/case_0001");
  });

  it("leaves Enter on every OTHER column alone -- it still opens that cell's editor", async () => {
    // The other half of R65: the ruling forbids a keymap entry that changes
    // what Enter does anywhere but the REF column. Without this, binding Enter
    // to navigation at the grid level would silently take editing with it.
    const user = userEvent.setup();
    const { container } = renderLedger(
      <>
        <LedgerTable rows={buildRows(50)} partnerNamesById={{}} />
        <RouterLocationProbe />
      </>,
    );
    await user.click(mountedCell(container, "case_0001", "caseStatus"));

    dispatchGridKeyDown(getGridElement(container), "Enter");

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByTestId("router-location").textContent).toBe("/");
  });

  it("moves the focused cell with the arrow keys", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{ArrowDown}");

    expect(mountedCell(container, "case_0001", "caseRef")).toHaveFocus();
    // Roving tabindex: exactly one cell is ever a tab stop, and it must have
    // followed focus -- otherwise Tab from outside the grid would still land
    // on row 0 no matter where keyboard navigation actually left off.
    expect(mountedCell(container, "case_0001", "caseRef")).toHaveAttribute("tabindex", "0");
    expect(mountedCell(container, "case_0000", "caseRef")).toHaveAttribute("tabindex", "-1");
  });

  it("does not wrap focus from the first row back to the last on ArrowUp", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{ArrowUp}");

    expect(mountedCell(container, "case_0000", "caseRef")).toHaveFocus();
  });

  it("toggles row selection with Space and shows it", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard(" ");

    // `aria-selected` lives on the row's CELL container, not on the
    // positioned wrapper that carries the transform (fix round 1, F5).
    expect(mountedGridRow(container, "case_0000")).toHaveAttribute("aria-selected", "true");

    await user.keyboard(" ");

    expect(mountedGridRow(container, "case_0000")).toHaveAttribute("aria-selected", "false");
  });

  it("extends the selection to the next row with Shift+ArrowDown", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));
    await user.keyboard(" ");

    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");

    expect(mountedGridRow(container, "case_0000")).toHaveAttribute("aria-selected", "true");
    expect(mountedGridRow(container, "case_0001")).toHaveAttribute("aria-selected", "true");
    expect(mountedCell(container, "case_0001", "caseRef")).toHaveFocus();
  });

  it("selects a contiguous range with a shift-click", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{Shift>}");
    await user.click(mountedCell(container, "case_0003", "caseRef"));
    await user.keyboard("{/Shift}");

    for (const caseId of ["case_0000", "case_0001", "case_0002", "case_0003"]) {
      expect(mountedGridRow(container, caseId)).toHaveAttribute("aria-selected", "true");
    }
  });

  it("resolves the overloaded → in the reducer: expands first, moves right only once already expanded", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{ArrowRight}");
    // The first → on a collapsed REF cell expands the row instead of moving
    // -- focus must stay on the REF cell, not slide onto "partner".
    expect(mountedCell(container, "case_0000", "caseRef")).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    // Now that the row is expanded, → behaves like an ordinary move.
    expect(mountedCell(container, "case_0000", "partner")).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    // Back on the REF column: this ← does not need to move (only one column
    // over), but the row is expanded and the next ← from the REF cell must
    // collapse rather than try (and fail) to move further left.
    expect(mountedCell(container, "case_0000", "caseRef")).toHaveFocus();
  });

  it("keeps rows from overlapping when one is expanded", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    // The REF column's overloaded → expands row 0. An expanded row is taller
    // than the flat 32px every other row gets, so the virtualizer has to
    // re-derive every LATER row's offset -- `estimateSize` reading the
    // expanded state is not enough on its own, because virtual-core caches
    // measurements and does not treat `estimateSize` as an input that
    // invalidates them. `rowVirtualizer.measure()` is what clears that cache.
    await user.keyboard("{ArrowRight}");

    const rowTops = readMountedRowTops(container);

    // Two independent assertions, because each catches a different shape of
    // the same bug. Sorted-ascending catches rows placed out of order; the
    // Set size catches two rows placed AT THE SAME OFFSET -- which is the
    // overlap itself, and which a sortedness check alone passes over happily
    // (a list with a repeated value is still sorted).
    expect(rowTops).toEqual([...rowTops].sort((leftTop, rightTop) => leftTop - rightTop));
    expect(new Set(rowTops).size).toBe(rowTops.length);

    // Without this the two assertions above are both satisfied by a table
    // that never re-measured at all: 32px apart everywhere is sorted and has
    // no duplicates. The gap after the EXPANDED row must be bigger than the
    // gap after a collapsed one, or nothing here is about expansion.
    const gapAfterExpandedRow = rowTops[1]! - rowTops[0]!;
    const gapAfterCollapsedRow = rowTops[2]! - rowTops[1]!;
    expect(gapAfterExpandedRow).toBeGreaterThan(gapAfterCollapsedRow);
  });

  it("holds a SUMMARISED row at its roll-up height while the fetch is still in flight (fix round 2, F8)", async () => {
    // The other half of the same arithmetic. This row DOES carry a roll-up
    // (`applicantSummary.count: 3`), and the file-level `fetch` stub never
    // resolves, so `<ApplicantSubRows>` sits on its single loading line and
    // reports a line count of 1 for as long as the test runs. Preferring that
    // report over the roll-up -- which is what R54 originally said -- made the
    // row reserve 116px on expand, drop to 60px, and climb back to 116px when
    // the fetch landed: a visible jump on every slow expand. R54 as amended
    // takes the LARGER of the two, because an over-reserve is a gap and an
    // under-reserve is the overlap Step 5 exists to prevent.
    const summarisedRows = buildRows(50).map((row) => ({
      ...row,
      applicantSummary: {
        count: 3,
        custody: { AT_EMBASSY: 2, WITH_RGS: 1 },
        outcome: { PENDING: 3 },
      },
    }));

    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={summarisedRows} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{ArrowRight}");

    // The loading line really is what is on screen -- without this the
    // assertion below could be passing against a resolved three-applicant
    // case, which is the F1 test's job, not this one's.
    expect(container.querySelector("[data-testid='applicant-subrows-loading']")).not.toBeNull();

    const rowTops = readMountedRowTops(container);
    // Exactly the roll-up height, not merely at least it: reserving MORE than
    // the roll-up would be a gap under the sub-rows that nothing ever closes.
    expect(rowTops[1]! - rowTops[0]!).toBe(LEDGER_ROW_HEIGHT_PX + 3 * APPLICANT_SUBROW_LINE_HEIGHT_PX);
  });

  it("reserves height for every applicant an UN-SUMMARISED case turns out to have (fix round 1, F1)", async () => {
    // The row shape that dominates production today: `buildRows` above omits
    // `applicantSummary` entirely, which is what all 7,156 cases imported
    // before `writeCase` computed one look like
    // (packages/shared/src/crm/ledger.ts). The height is DERIVED, never
    // measured from the DOM (jsdom cannot measure), so a guess that comes in
    // short is never self-corrected -- the sub-rows simply paint over the
    // next row. Only the sub-rows themselves know the real line count, and
    // only once the fetch has resolved.
    const threeApplicantCase = {
      caseId: "case_0000",
      caseRef: "RGS-1000",
      applicants: [
        { applicantRef: "A1", travellerId: "traveller_1", custody: "WITH_RGS", outcome: "PENDING" },
        { applicantRef: "A2", travellerId: "traveller_2", custody: "WITH_RGS", outcome: "PENDING" },
        { applicantRef: "A3", travellerId: "traveller_3", custody: "AT_EMBASSY", outcome: "PENDING" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => threeApplicantCase })),
    );

    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    await user.keyboard("{ArrowRight}");

    // Assert only once the three applicant lines are really on screen: before
    // that the sub-rows are still on their single loading line, where
    // reserving 32 + 1 x 28 is the correct answer and this test would pass
    // without proving anything.
    await waitFor(() => {
      expect(container.querySelectorAll("[data-testid='applicant-subrow']")).toHaveLength(3);
    });

    // The re-measure the report triggers lands in a render of its own, after
    // the one that first drew the three lines -- so this waits for the
    // positions rather than reading them in the same tick.
    await waitFor(() => {
      const rowTops = readMountedRowTops(container);
      expect(rowTops[1]! - rowTops[0]!).toBeGreaterThanOrEqual(
        LEDGER_ROW_HEIGHT_PX + 3 * APPLICANT_SUBROW_LINE_HEIGHT_PX,
      );
    });
  });

  it("scrolls a distant row into the mounted window before focusing it", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    // ~37 rows mount at a time (measured); row 40 starts outside that window,
    // so this is only reachable if scrollToIndex actually runs before the
    // focus effect.
    await user.keyboard("{ArrowDown>40/}");

    expect(mountedCell(container, "case_0040", "caseRef")).toHaveFocus();
  });

  it("prevents the browser default for every key the grid consumes, but leaves Tab alone", () => {
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    const gridElement = getGridElement(container);

    const consumedKeyPresses: [string, KeyboardEventInit?][] = [
      ["ArrowUp"],
      ["ArrowDown"],
      ["ArrowLeft"],
      ["ArrowRight"],
      ["ArrowDown", { shiftKey: true }],
      ["ArrowUp", { shiftKey: true }],
      ["Enter"],
      ["Enter", { metaKey: true }],
      ["Enter", { ctrlKey: true }],
      ["Escape"],
      [" "],
    ];
    for (const [key, eventInit] of consumedKeyPresses) {
      const keyboardEvent = dispatchGridKeyDown(gridElement, key, eventInit);
      expect(keyboardEvent.defaultPrevented, `expected "${key}" to be prevented`).toBe(true);
    }

    // Space scrolling the page out from under a desk agent mid-selection is
    // the bug preventDefault exists to stop -- but a handler that
    // blanket-prevents everything would break browser-native behaviour a
    // desk agent relies on just as badly. Tab (tabbing away from the grid)
    // must reach the browser untouched.
    const tabKeyboardEvent = dispatchGridKeyDown(gridElement, "Tab");
    expect(tabKeyboardEvent.defaultPrevented).toBe(false);
  });

  it("leaves the arrow keys working after Enter on a read-only column (Critical #2, D23/D28)", async () => {
    // Partner is one of the six Ledger columns with no `editable` field. Enter
    // there used to set `editing` on a cell that renders no editor, and `move`
    // returns the previous state while `editing` is set -- so every arrow key
    // died until the desk agent happened to press Escape, with nothing on
    // screen to say why. Written at the TABLE level, not the reducer's: the
    // pairing of `editing` with `columns.tsx`'s `editable` field only exists
    // here (G2).
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "partner"));
    expect(mountedCell(container, "case_0000", "partner")).toHaveFocus();

    await user.keyboard("{Enter}");

    // Nothing opened, because there is nothing on this column to open.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}");

    expect(mountedCell(container, "case_0001", "partner")).toHaveFocus();
  });

  it("R75: Tab reaches the focused row's marker chip, and Enter there opens the panel instead of leaving the Ledger", async () => {
    // G1: every existing marker test opens the popover with a synthetic mouse
    // click, and `ReviewMarker.test.tsx` renders the chip OUTSIDE `LedgerTable`
    // -- so the grid's own `onKeyDown` is not even in the tree. The mechanism
    // that killed this feature is event propagation from the chip INTO that
    // handler, and a plain Enter on the REF column navigates away (R65).
    const user = userEvent.setup();
    const { container } = renderLedger(
      <>
        <LedgerTable
          rows={buildRows(50)}
          partnerNamesById={{}}
          reviewEntriesByCaseRef={FIRST_ROW_HAS_ONE_REVIEW_ITEM}
        />
        <RouterLocationProbe />
      </>,
    );
    await user.click(mountedCell(container, "case_0000", "caseRef"));

    // R74's roving tab stop, exercised rather than read off an attribute.
    await user.tab();
    const markerChip = markerChipOnRow(container, "case_0000");
    expect(markerChip).toHaveFocus();

    fireEvent.keyDown(markerChip, { key: "Enter" });

    expect(screen.getByRole("group", { name: "Import review for RGS-1000" })).toBeInTheDocument();
    // The half that makes this a real test of propagation: without the chip's
    // own handler the grid's keymap consumes this Enter and navigates.
    expect(screen.getByTestId("router-location").textContent).toBe("/");
  });

  it("R75: Space on the marker chip opens the panel and leaves the row's selection alone", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(
      <LedgerTable
        rows={buildRows(50)}
        partnerNamesById={{}}
        reviewEntriesByCaseRef={FIRST_ROW_HAS_ONE_REVIEW_ITEM}
      />,
    );
    await user.click(mountedCell(container, "case_0000", "caseRef"));
    await user.tab();
    const markerChip = markerChipOnRow(container, "case_0000");
    expect(markerChip).toHaveFocus();
    // The precondition the assertion below is a change FROM -- without it,
    // "still not selected" could be true of a row that was never selectable.
    expect(mountedGridRow(container, "case_0000")).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(markerChip, { key: " " });

    expect(screen.getByRole("group", { name: "Import review for RGS-1000" })).toBeInTheDocument();
    // Space is the grid's selection toggle (spec §4). Opening a review panel is
    // not a statement about which cases the agent should be looking at (R62).
    expect(mountedGridRow(container, "case_0000")).toHaveAttribute("aria-selected", "false");
  });

  it("R75(b): a re-render does not pull focus off the marker chip and back onto the gridcell", async () => {
    // D5. The R57 focus-sync effect has no dependency array, so it runs on
    // every render, and its guard used to admit anything inside the scroll
    // container -- the chip included. A settled refetch, a selection report or
    // any prop change then reclaimed focus, which made R74's tab stop
    // unholdable as well as inoperable.
    const user = userEvent.setup();
    const { container, rerenderLedger } = renderLedger(
      <LedgerTable
        rows={buildRows(50)}
        partnerNamesById={{}}
        reviewEntriesByCaseRef={FIRST_ROW_HAS_ONE_REVIEW_ITEM}
      />,
    );
    await user.click(mountedCell(container, "case_0000", "caseRef"));
    await user.tab();
    expect(markerChipOnRow(container, "case_0000")).toHaveFocus();

    // A prop change the desk agent never asked for -- the partner names
    // arriving from their own query is the everyday one.
    act(() => {
      rerenderLedger(
        <LedgerTable
          rows={buildRows(50)}
          partnerNamesById={{ partner_1: "Skyline Travels" }}
          reviewEntriesByCaseRef={FIRST_ROW_HAS_ONE_REVIEW_ITEM}
        />,
      );
    });

    // The re-render really happened -- otherwise the effect never ran and this
    // proves nothing about its guard.
    expect(mountedCell(container, "case_0000", "partner").textContent).toBe("Skyline Travels");
    expect(markerChipOnRow(container, "case_0000")).toHaveFocus();
  });
});
