import { act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { installVirtualScrolling, renderLedger } from "./virtual";

/**
 * R62: the agent panel inherits the grid's selection, and the grid reports it
 * upward as CASE IDS rather than publishing its index-keyed reducer state.
 *
 * Case ids, not indexes, is the whole point. `gridState.selectedRowIndexes`
 * addresses positions in `rows`, and `rows` is re-filtered and re-sorted
 * client-side on every keystroke in the search box (Task 13) -- so an index
 * handed to the panel means a different case a moment later, and the agent
 * would be told about a case nobody selected.
 */
installVirtualScrolling();

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

function pressOnGrid(container: HTMLElement, key: string): void {
  const gridElement = container.querySelector<HTMLElement>("[data-testid='ledger-scroll']");
  if (gridElement === null) throw new Error("No ledger grid in this render");
  act(() => {
    gridElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("LedgerTable reports its selection as case ids", () => {
  it("names the selected rows' cases, in selection order", () => {
    const reportSelection = vi.fn();
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={{}} onSelectionChange={reportSelection} />,
    );

    // Focus starts on row 0; Space toggles the focused row's selection.
    pressOnGrid(container, " ");
    pressOnGrid(container, "ArrowDown");
    pressOnGrid(container, " ");

    expect(reportSelection).toHaveBeenLastCalledWith(["case_0000", "case_0001"]);
  });

  it("reports an emptied selection, so the panel stops claiming cases the human deselected", () => {
    const reportSelection = vi.fn();
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={{}} onSelectionChange={reportSelection} />,
    );

    pressOnGrid(container, " ");
    expect(reportSelection).toHaveBeenLastCalledWith(["case_0000"]);

    pressOnGrid(container, " ");
    expect(reportSelection).toHaveBeenLastCalledWith([]);
  });

  it("never reports a hole, not even on the render before the index remap lands", () => {
    // `rowsReplaced` remaps selection when the client-side filters swap the
    // rows underneath it -- but that remap is itself dispatched from an effect,
    // so there is one commit in between where `rows` is already the NEW list
    // and `selectedRowIndexes` is still the OLD one. On that render an index
    // past the end of the new list addresses nothing, and without the guard
    // the panel is handed `[..., undefined]` and tells the agent about a case
    // that is not a case. Asserted across EVERY call, not just the last one:
    // the last call is post-remap and is honest either way.
    const reportSelection = vi.fn();
    const { container, rerenderLedger } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={{}} onSelectionChange={reportSelection} />,
    );

    pressOnGrid(container, " ");
    pressOnGrid(container, "ArrowDown");
    pressOnGrid(container, " ");
    expect(reportSelection).toHaveBeenLastCalledWith(["case_0000", "case_0001"]);

    // The search box narrows the ledger to one row.
    rerenderLedger(
      <LedgerTable
        rows={buildRows(5).slice(1, 2)}
        partnerNamesById={{}}
        onSelectionChange={reportSelection}
      />,
    );

    const everyReportedCaseId = reportSelection.mock.calls.flatMap(
      ([reportedCaseIds]) => reportedCaseIds as string[],
    );
    expect(everyReportedCaseId.every((caseId) => typeof caseId === "string")).toBe(true);
    expect(reportSelection.mock.lastCall?.[0]).toEqual(["case_0001"]);
  });
});
