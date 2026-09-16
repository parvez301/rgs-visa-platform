import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import type { OpenReviewSummaryEntry } from "../../src/crm/api/crmClient";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { mountedCaseIds, mountedCell, renderLedger, scrollLedgerTo } from "./virtual";

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
    applicantSummary: { count: 3, custody: { AT_EMBASSY: 2, WITH_RGS: 1 }, outcome: { PENDING: 3 } },
  }));
}

const partnerNames = { partner_1: "Skyline Travels" };

/**
 * Two marked rows, one kind of work each -- the shape R74 is about. Two,
 * because "exactly one chip is tabbable" says nothing at all about roving if
 * only one chip exists to be it.
 */
const TWO_MARKED_ROWS: ReadonlyMap<string, OpenReviewSummaryEntry> = new Map([
  ["RGS-1000", { caseRef: "RGS-1000", fieldItemIds: ["rev_1"], mergeItemIds: [] }],
  ["RGS-1001", { caseRef: "RGS-1001", fieldItemIds: ["rev_2"], mergeItemIds: [] }],
]);

function getGridElement(container: HTMLElement): HTMLElement {
  const gridElement = container.querySelector<HTMLElement>("[data-testid='ledger-scroll']");
  if (gridElement === null) throw new Error("No ledger scroll/grid container in this render");
  return gridElement;
}

/**
 * Every mounted review-marker chip, with the tab stop it carries.
 *
 * Read through `mountedCaseIds`/`mountedCell`, which throw rather than hand
 * back an empty list: "no chip is a tab stop" must never be able to pass
 * because the virtualizer mounted nothing (spec §10's first named trap). The
 * REF cell's other child is an `<a>`, so every `button` in it is a marker.
 */
function markerChipTabStops(container: HTMLElement): { caseId: string; tabIndex: number }[] {
  return mountedCaseIds(container).flatMap((caseId) =>
    [...mountedCell(container, caseId, "caseRef").querySelectorAll("button")].map((chipButton) => ({
      caseId,
      tabIndex: chipButton.tabIndex,
    })),
  );
}

describe("LedgerTable", () => {
  it("mounts a window of rows, not all 7,156", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );

    const mounted = mountedCaseIds(container);
    expect(mounted.length).toBeGreaterThan(5);
    // The whole reason for virtualizing. If this ever passes with 7,156, the
    // virtualizer has been bypassed and the screen will die on real data.
    expect(mounted.length).toBeLessThan(200);
    expect(mounted[0]).toBe("case_0000");
  });

  it("renders the spec's columns, in the spec's order", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(10)} partnerNamesById={partnerNames} />,
    );

    const headerKeys = [...container.querySelectorAll("[data-testid='ledger-header'] [data-column]")].map(
      (cell) => cell.getAttribute("data-column"),
    );
    expect(headerKeys).toEqual([
      "caseRef",
      "partner",
      "destinationCountry",
      "caseType",
      "applicants",
      "caseStatus",
      "billingStatus",
      "receivedDate",
      "appointmentDate",
      "totalInr",
    ]);
  });

  it("links the REF to that case's own screen, without adding a tab stop per row", () => {
    // Spec §5: the Case screen is "reached by clicking a REF". The `tabIndex`
    // half is not decoration -- the grid deliberately leaves Tab alone
    // (`useGridKeyboard`), and an anchor at the browser default would put one
    // tab stop in every mounted row, which is what Tab would then do instead.
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    const refLink = mountedCell(container, "case_0003", "caseRef").querySelector("a");
    expect(refLink).not.toBeNull();
    expect(refLink!.textContent).toBe("RGS-1003");
    expect(refLink!.getAttribute("href")).toBe("/crm/cases/case_0003");
    expect(refLink!.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the partner's canonical name, not the partner id", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "partner").textContent).toBe("Skyline Travels");
  });

  it("carries the custody roll-up on the collapsed parent row", () => {
    // Spec §4: the collapsed parent must carry enough per-applicant signal
    // that expanding is rarely needed, and the roll-up comes from the META
    // item's summary -- the row never reads applicant records.
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    const applicantsCell = mountedCell(container, "case_0000", "applicants");
    expect(applicantsCell.textContent).toContain("3");
    expect(applicantsCell.textContent).toContain("2 at embassy · 1 with us");
  });

  it("says 'Not summarised' for a case imported before the roll-up existed", () => {
    const [rowWithoutSummary] = buildRows(1);
    const { applicantSummary: _dropped, ...bareRow } = rowWithoutSummary!;
    const { container } = renderLedger(
      <LedgerTable rows={[bareRow]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "applicants").textContent).toContain("Not summarised");
  });

  it("marks an UNKNOWN billing status as import debt", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(3)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "billingStatus").innerHTML).toContain("border-dashed");
  });

  it("mounts a different window after scrolling, and the far row really is there", async () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );
    expect(mountedCaseIds(container)).not.toContain("case_3000");

    // R78: wrapped in `act` because this scroll updates the virtualizer's
    // mounted window from a listener React did not dispatch. Nothing about
    // what this test asserts changes -- both assertions below are made after
    // the scroll has settled either way -- and the sibling scroll test below
    // has done exactly this since it was written.
    await act(async () => {
      await scrollLedgerTo(container, 3000 * 32);
    });

    // Asserted against a row the virtualizer actually mounted -- this is the
    // mechanism spec §10 asks the plan to name.
    expect(mountedCaseIds(container)).toContain("case_3000");
    expect(mountedCell(container, "case_3000", "caseRef").textContent).toBe("RGS-4000");
  });

  it("keeps every gridcell a direct child of its own row (fix round 1, F5)", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(10)} partnerNamesById={partnerNames} />,
    );

    const gridCells = [...container.querySelectorAll("[role='gridcell']")];
    // Guard first: an empty list of cells would make the real assertion below
    // trivially true, which is spec §10's named trap.
    expect(gridCells.length).toBeGreaterThan(0);

    // `row` has required owned elements. A generic container in between --
    // the positioned wrapper the virtualizer transforms, say -- drops the
    // cells out of the row in the computed accessibility tree, and
    // screen-reader table navigation over the Ledger stops working. Nothing
    // about it is visible on screen, which is why it needs its own assertion.
    const cellsNotOwnedByARow = gridCells.filter(
      (cellElement) => cellElement.parentElement?.getAttribute("role") !== "row",
    );
    expect(cellsNotOwnedByARow).toHaveLength(0);
  });

  it("R74: only the FOCUSED row's review marker is a Tab stop", () => {
    // The REF `<Link>` beside the chip carries `tabIndex={-1}` precisely so
    // that Tab still leaves the grid after one press; a plain `<button>` in
    // the same cell was quietly putting that stop back, once per mounted
    // marked row. The chip stays keyboard-reachable by roving with the grid's
    // focus instead of by leaving the tab order alone.
    const { container } = renderLedger(
      <LedgerTable
        rows={buildRows(5)}
        partnerNamesById={partnerNames}
        reviewEntriesByCaseRef={TWO_MARKED_ROWS}
      />,
    );

    const chipTabStops = markerChipTabStops(container);
    // Guard: if the fixture stops producing two chips, the assertion below is
    // a statement about one chip and proves no roving at all.
    expect(chipTabStops.map((chip) => chip.caseId)).toEqual(["case_0000", "case_0001"]);
    // Focus starts on row 0, so row 0's chip is the only reachable one.
    expect(chipTabStops.filter((chip) => chip.tabIndex === 0)).toEqual([
      { caseId: "case_0000", tabIndex: 0 },
    ]);
  });

  it("R74: the tabbable marker follows the grid's focus down the rows", () => {
    const { container } = renderLedger(
      <LedgerTable
        rows={buildRows(5)}
        partnerNamesById={partnerNames}
        reviewEntriesByCaseRef={TWO_MARKED_ROWS}
      />,
    );

    fireEvent.keyDown(getGridElement(container), { key: "ArrowDown" });

    const chipTabStops = markerChipTabStops(container);
    expect(chipTabStops.filter((chip) => chip.tabIndex === 0)).toEqual([
      { caseId: "case_0001", tabIndex: 0 },
    ]);
    // And the chip the focus LEFT is back out of the tab order -- without
    // this, a marker that only ever gained tab stops would still pass above.
    expect(chipTabStops.find((chip) => chip.caseId === "case_0000")?.tabIndex).toBe(-1);
  });

  it("closes an open review panel when the grid scrolls under it, and does not grab focus back", async () => {
    // The panel's items are fetched only when it opens (R69) and this file
    // stubs no API, so a `fetch` that never settles leaves them on "Loading
    // this review item…" -- nothing here asserts anything about item content.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const { container } = renderLedger(
      <LedgerTable
        rows={buildRows(60)}
        partnerNamesById={partnerNames}
        reviewEntriesByCaseRef={TWO_MARKED_ROWS}
      />,
    );

    const markerChip = within(mountedCell(container, "case_0000", "caseRef")).getByRole("button", {
      name: /1 import problem/i,
    });
    await userEvent.click(markerChip);
    expect(screen.getByRole("group", { name: "Import review for RGS-1000" })).toBeInTheDocument();

    // Three rows' worth: far enough to be a real scroll, and well inside the
    // 12-row overscan, so case_0000 is still mounted afterwards. That is what
    // makes this a test of the scroll listener rather than of the unmount
    // path, which closes the panel for a different reason entirely.
    //
    // Wrapped in `act` because this scroll updates TWO components (the
    // virtualizer's own window and the marker's open state) from a listener
    // React did not dispatch. The neighbouring scroll test carried the suite's
    // one known `act(...)` warning until R78 wrapped it the same way.
    await act(async () => {
      await scrollLedgerTo(container, 3 * 32);
    });
    expect(mountedCaseIds(container)).toContain("case_0000");

    // The panel is `position: fixed` from the chip's rect at open time, so it
    // cannot follow the row -- it would hang over unrelated rows while the
    // agent scrolled past.
    expect(screen.queryByRole("group", { name: "Import review for RGS-1000" })).not.toBeInTheDocument();
    // Nobody closed this panel, so nothing may take focus back to the chip:
    // that would move a keyboard agent's focus for them, mid-scroll.
    expect(document.activeElement).not.toBe(markerChip);
  });

  it("renders an empty ledger as an empty state rather than a broken table", () => {
    const { container, getByText } = renderLedger(
      <LedgerTable rows={[]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCaseIds(container, { allowEmpty: true })).toEqual([]);
    expect(getByText(/no cases/i)).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
