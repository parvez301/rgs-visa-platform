import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { installVirtualScrolling, mountedCaseIds, mountedCell, renderLedger } from "./virtual";

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

describe("LedgerTable keyboard and selection", () => {
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

    expect(
      container.querySelector("[data-testid='ledger-row'][data-case-id='case_0000']"),
    ).toHaveAttribute("aria-selected", "true");

    await user.keyboard(" ");

    expect(
      container.querySelector("[data-testid='ledger-row'][data-case-id='case_0000']"),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("extends the selection to the next row with Shift+ArrowDown", async () => {
    const user = userEvent.setup();
    const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
    await user.click(mountedCell(container, "case_0000", "caseRef"));
    await user.keyboard(" ");

    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");

    expect(
      container.querySelector("[data-testid='ledger-row'][data-case-id='case_0000']"),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      container.querySelector("[data-testid='ledger-row'][data-case-id='case_0001']"),
    ).toHaveAttribute("aria-selected", "true");
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
      expect(container.querySelector(`[data-testid='ledger-row'][data-case-id='${caseId}']`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
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

    const rowTops = mountedCaseIds(container).map((caseId) => {
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
});
