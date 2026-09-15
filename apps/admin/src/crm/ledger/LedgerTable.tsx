import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { crm } from "@rgs/shared";
import { describeLedgerEditValue, useLedgerEdit } from "../api/mutations";
import { ConflictPrompt } from "../components/ConflictPrompt";
import { ApplicantSubRows, APPLICANT_SUBROW_LINE_HEIGHT } from "./ApplicantSubRows";
import { LEDGER_COLUMNS, LEDGER_ROW_HEIGHT } from "./columns";
import { EditableCell, readLedgerColumnValue } from "./EditableCell";
import { useGridKeyboard } from "./useGridKeyboard";

interface LedgerTableProps {
  rows: crm.LedgerRow[];
  partnerNamesById: Record<string, string>;
}

/**
 * How tall an EXPANDED row needs to be: the collapsed row itself, plus one
 * line per applicant `<ApplicantSubRows>` is drawing.
 *
 * The LARGEST of three claims about the line count, never the first one that
 * happens to exist (fix round 1 F1; R54 as amended in fix round 2, F8):
 *
 * 1. `reportedLineCount` -- what the mounted `<ApplicantSubRows>` says it is
 *    ACTUALLY rendering right now (1 while loading, 1 for the error line, one
 *    per applicant once loaded). Only available after that component has
 *    mounted and reported, which is why it cannot be the only source.
 * 2. `applicantSummary.count` -- the roll-up the collapsed "Applicants"
 *    column already renders (`columns.tsx`'s `renderApplicants`). Available
 *    up front, which is what the virtualizer needs to place rows before any
 *    expanded row's own fetch has settled.
 * 3. `1` -- the floor `CrmCaseSchema.applicants` (`.min(1)`) guarantees.
 *
 * Why the largest rather than the freshest, which is what this function did
 * first: the two claims disagree in BOTH directions, and the two disagreements
 * do not cost the same. The 7,156 cases imported before `writeCase` computed a
 * roll-up (`packages/shared/src/crm/ledger.ts`) have no (2) at all, so a
 * three-applicant one of them reserved 32 + 1 x 28 = 60px from (3) and then
 * drew 32 + 3 x 28 = 116px into it, straight over the next row -- and heights
 * here are DERIVED, not MEASURED (see `estimateSize` below), so that undercount
 * is permanent, never self-correcting. A case that HAS a roll-up of 3 hits the
 * opposite disagreement: (1) reports 1 for as long as the fetch is in flight,
 * which under a freshest-wins rule shrank the row from 116px to 60px and back
 * again while the agent watched. An over-reserve is a gap under the sub-rows;
 * an under-reserve is the overlap. Taking the max pays the gap, never the
 * overlap, and the gap closes itself the moment the real count arrives.
 */
function estimateExpandedRowHeight(row: crm.LedgerRow, reportedLineCount: number | undefined): number {
  const applicantLineCount = Math.max(reportedLineCount ?? 0, row.applicantSummary?.count ?? 0, 1);
  return LEDGER_ROW_HEIGHT + applicantLineCount * APPLICANT_SUBROW_LINE_HEIGHT;
}

export function LedgerTable({ rows, partnerNamesById }: LedgerTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Grid semantics (focus, selection, expand/collapse) live in the reducer
  // (Task 11's `useGridKeyboard`/`gridReducer`), not here -- this call has to
  // come before `useVirtualizer` below, because its `expandedRowIndexes` is
  // what `estimateSize` needs on every render.
  const { state: gridState, onKeyDown: onGridKeyDown, dispatch: dispatchGridAction } = useGridKeyboard({
    rowCount: rows.length,
    columnCount: LEDGER_COLUMNS.length,
  });

  // What each mounted `<ApplicantSubRows>` reports it is really drawing, keyed
  // by case id rather than row index: `rows` is re-filtered client-side on
  // every keystroke now (Task 13), and an index means a different case after
  // each of those. A case that scrolls out of the mounted window keeps its
  // entry, so re-expanding it later reserves the right height immediately
  // instead of flickering through the fallback again.
  const [reportedLineCountsByCaseId, setReportedLineCountsByCaseId] = useState<Map<string, number>>(
    () => new Map(),
  );

  // Stable identity (`[]` deps): `<ApplicantSubRows>` reports from an effect
  // keyed on this callback, so a new function every render would re-report on
  // every render. Returning the SAME Map when the count has not changed is
  // what keeps that report from queuing a pointless re-render and a pointless
  // `.measure()` besides.
  const reportApplicantLineCount = useCallback((caseId: string, lineCount: number) => {
    setReportedLineCountsByCaseId((previousLineCounts) => {
      if (previousLineCounts.get(caseId) === lineCount) return previousLineCounts;
      const nextLineCounts = new Map(previousLineCounts);
      nextLineCounts.set(caseId, lineCount);
      return nextLineCounts;
    });
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    // A collapsed row is always exactly LEDGER_ROW_HEIGHT (spec §3); an
    // expanded one needs the extra height `estimateExpandedRowHeight`
    // computes above. Deliberately no `measureElement` ref is wired up
    // anywhere in this file to correct this from the real, rendered DOM
    // size: `@tanstack/react-virtual`'s default per-item measurement reads
    // `element.offsetHeight`, and this app's own jsdom test scaffolding
    // (test/setup.ts) fixes EVERY element's `offsetHeight` at a flat 800px
    // unless a test opts an element out -- wiring in real measurement would
    // make that scaffolding silently override every row's height, collapsed
    // rows included, breaking the fixed 32px-per-row arithmetic every other
    // Ledger test (scroll-to-row-N, the "mounts <200 of 7,156" assertion)
    // already depends on, for a reason that has nothing to do with sub-rows.
    // Keeping the height fully DERIVED here (estimateSize decides it, the
    // DOM below is styled to match it exactly) rather than MEASURED (the DOM
    // decides it, the virtualizer copies it back) is what keeps this correct
    // under both a real browser and jsdom without special-casing either one.
    estimateSize: (index) => {
      const row = rows[index];
      if (row === undefined) return LEDGER_ROW_HEIGHT;
      if (!gridState.expandedRowIndexes.includes(index)) return LEDGER_ROW_HEIGHT;
      return estimateExpandedRowHeight(row, reportedLineCountsByCaseId.get(row.caseId));
    },
    // Enough rows above and below the window that a fast scroll does not show
    // blank bands, and few enough that the DOM stays small.
    overscan: 12,
  });

  // `estimateSize`'s closure above reads the LATEST `gridState.expandedRowIndexes`
  // on every call, but a change to what a FUTURE call would return does
  // nothing on its own: virtual-core's `getMeasurements` only recomputes when
  // `itemSizeCacheVersion` changes, and `estimateSize` is not one of the
  // values that bumps it (see virtual-core's `getMeasurementOptions`, which
  // does not list `estimateSize`). `.measure()` is the one call that clears
  // the cache and forces every row's height to be re-derived from the
  // current `estimateSize` -- without this, toggling a row's expansion would
  // change `expandedRowIndexes` but leave every row exactly where it already
  // was, until some unrelated scroll happened to force a recompute anyway.
  //
  // `reportedLineCountsByCaseId` is in the deps for exactly the same reason
  // (fix round 1, F1): a sub-row group reporting three lines where one was
  // reserved changes what `estimateSize` WOULD return, and nothing but
  // `.measure()` makes the virtualizer ask again.
  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridState.expandedRowIndexes, reportedLineCountsByCaseId]);

  // Every index in `gridState` -- focus, selection, expansion -- addresses a
  // POSITION in `rows`, and from Task 13 on `rows` is re-filtered and
  // re-sorted client-side on every keystroke in the Ledger's search box and on
  // every view chip click (`LedgerPage`), not just on a server refetch. So the
  // rows those numbers point at change underneath them, and "row 0 is
  // expanded" silently becomes a different case -- one the desk agent never
  // expanded, whose applicants are then fetched and disclosed under it (fix
  // round 1, F2).
  //
  // The case ids on both sides are what the reducer needs to tell "the same
  // cases came back" (a background refetch: leave everything alone) from "the
  // set changed" (remap what survived, drop what did not).
  //
  // `useLayoutEffect`, not `useEffect`: this runs before the browser paints,
  // so the frame where row 0 renders another case's disclosure never reaches
  // the screen.
  const currentCaseIds = rows.map((row) => row.caseId);
  // Seeded with THIS render's ids so mounting is not itself treated as a
  // replacement; the reducer no-ops on an unchanged list anyway, which is what
  // keeps this from re-rendering the grid on every refetch.
  const previousCaseIdsRef = useRef<string[]>(currentCaseIds);
  useLayoutEffect(() => {
    const previousCaseIds = previousCaseIdsRef.current;
    previousCaseIdsRef.current = currentCaseIds;
    dispatchGridAction({ kind: "rowsReplaced", previousCaseIds, nextCaseIds: currentCaseIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Direct human edits go straight to the REST routes -- the agent's
  // approval gate governs what the agent writes, not a desk agent's own
  // click (rule 1). One call here, shared by every editable cell: a second
  // call site would keep its own `pendingConflict` state, and the two would
  // silently disagree about whether a conflict prompt is open.
  const { commitEdit, pendingConflict, resolveConflict } = useLedgerEdit();

  // Moving focus to a row outside the mounted window must scroll it in
  // first -- otherwise `↓` held down walks the focus off the mounted window
  // and focus silently falls back to `document.body`. `align: "auto"` is a
  // no-op when the row is already visible, so this never fights a desk
  // agent's own manual scrolling.
  useEffect(() => {
    rowVirtualizer.scrollToIndex(gridState.focus.rowIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridState.focus.rowIndex]);

  // No dependency array: the row `scrollToIndex` just brought into range
  // mounts on the render *after* that call, not within it, so this has to
  // keep looking until the target cell actually exists. `preventScroll`
  // keeps a re-run of this effect (e.g. after an unrelated re-render) from
  // fighting a desk agent's manual scroll -- `scrollToIndex` above already
  // owns scrolling.
  //
  // Sub-rows (Task 13) do not change what "the row at index N" means here:
  // an expanded case is still exactly one entry in `rows`, one virtualized
  // item and one `[data-case-id]` element -- its disclosed applicants are
  // rendered as children of that SAME element, never as additional indices
  // of their own. That is a deliberate choice (see the module comment on
  // `estimateExpandedRowHeight`'s caller below), and it is what keeps this
  // effect's query, `rowIndex`'s meaning, and the roving-tabindex logic
  // below all correct with no change at all.
  useEffect(() => {
    // Fix round 1, F2: while a cell is open for editing, the open editor's own
    // input/select owns DOM focus -- it is a *descendant* of the gridcell
    // wrapper this effect focuses, not the wrapper itself. Re-running this on
    // every render (which the no-deps-array comment above still requires) is
    // exactly what stole focus back to the wrapper out from under an open
    // editor on any unrelated re-render, firing `onBlur`'s commit for a value
    // the human never confirmed. `gridState.focus` does not move while
    // `gridState.editing` is set, so skipping the sync entirely until editing
    // ends loses nothing: there is nothing new to focus.
    if (gridState.editing !== undefined) return;

    // Fix round 2, F7 (R57): the grid may only reclaim focus it ALREADY OWNS.
    // The guard above covers an open in-grid editor; it says nothing about
    // focus that left the grid entirely. `LedgerPage`'s search box is outside
    // this component, and every keystroke in it changes `rows` and re-renders
    // this table -- so this effect ran and pulled focus back onto the focused
    // cell after the FIRST character, sending the rest of the term to the grid
    // as keymap input. Measured before the fix: typing "RGS-1003" left the
    // input holding "R" and the table unfiltered.
    //
    // `document.activeElement` on `body` means either nothing owns focus or
    // the previously focused cell was just unmounted by the virtualizer --
    // both cases this effect exists to repair, so it may act. Anything else
    // outside this container (the search input, a view chip, the Save button,
    // the agent panel) is where a human deliberately put focus, and taking it
    // from them is never this effect's business. `focusin`/`focusout`
    // bookkeeping cannot tell those two apart -- `relatedTarget` is null both
    // when a cell unmounts and when a click lands on non-focusable chrome --
    // which is why this reads `activeElement` instead.
    const elementOwningFocus = document.activeElement;
    const focusIsUnclaimedOrInsideTheGrid =
      elementOwningFocus === null ||
      elementOwningFocus === document.body ||
      scrollContainerRef.current?.contains(elementOwningFocus) === true;
    if (!focusIsUnclaimedOrInsideTheGrid) return;

    const focusedRow = rows[gridState.focus.rowIndex];
    const focusedColumn = LEDGER_COLUMNS[gridState.focus.columnIndex];
    if (focusedRow === undefined || focusedColumn === undefined) return;
    const focusedCellElement = scrollContainerRef.current?.querySelector<HTMLElement>(
      `[data-testid='ledger-row'][data-case-id='${focusedRow.caseId}'] [data-column='${focusedColumn.key}']`,
    );
    focusedCellElement?.focus({ preventScroll: true });
  });

  const gridTemplateColumns = LEDGER_COLUMNS.map((column) => `${column.width}px`).join(" ");

  return (
    <div className="crm-root relative flex h-full flex-col border border-crm-rule-box rounded-crm-card overflow-hidden">
      <div
        data-testid="ledger-header"
        className="sticky top-0 z-20 grid bg-crm-surface text-crm-steel text-[12px] uppercase tracking-wide"
        style={{ gridTemplateColumns, height: LEDGER_ROW_HEIGHT }}
      >
        {LEDGER_COLUMNS.map((column) => (
          <div
            key={column.key}
            data-column={column.key}
            className={`flex items-center px-2 ${column.sticky ? "sticky left-0 z-30 bg-crm-surface" : ""}`}
          >
            {column.header}
          </div>
        ))}
      </div>

      <div
        data-testid="ledger-scroll"
        ref={scrollContainerRef}
        className="flex-1 overflow-auto"
        role="grid"
        tabIndex={0}
        onKeyDown={(event) => onGridKeyDown(event.nativeEvent)}
      >
        {rows.length === 0 ? (
          <p className="p-6 text-crm-steel">No cases match these filters.</p>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              const isRowSelected = gridState.selectedRowIndexes.includes(virtualRow.index);
              const isRowExpanded = gridState.expandedRowIndexes.includes(virtualRow.index);
              return (
                // The positioned wrapper carries NO role (fix round 1, F5):
                // it owns the virtualizer's transform and the expanded
                // height, and it contains the disclosed sub-rows as well as
                // the cells. `role="row"` belongs on the cell container
                // alone, because a `row`'s required owned elements are its
                // `gridcell`s -- a generic container in between drops them
                // out of the row in the accessibility tree and
                // screen-reader table navigation over the Ledger stops
                // working.
                <div
                  key={row.caseId}
                  data-testid="ledger-row"
                  data-case-id={row.caseId}
                  className="absolute left-0 w-full border-b border-crm-rule-row bg-crm-canvas"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    role="row"
                    aria-selected={isRowSelected ? "true" : "false"}
                    aria-expanded={isRowExpanded}
                    className="grid hover:bg-crm-surface"
                    style={{ gridTemplateColumns, height: LEDGER_ROW_HEIGHT }}
                  >
                    {LEDGER_COLUMNS.map((column, columnIndex) => {
                      const isCellFocused =
                        gridState.focus.rowIndex === virtualRow.index && gridState.focus.columnIndex === columnIndex;
                      const isCellEditing =
                        gridState.editing?.rowIndex === virtualRow.index &&
                        gridState.editing?.columnIndex === columnIndex;
                      const editableColumn = column.editable;
                      return (
                        <div
                          key={column.key}
                          data-column={column.key}
                          role="gridcell"
                          tabIndex={isCellFocused ? 0 : -1}
                          // Fix round 1, F3: the click handler lives on each cell, not
                          // the row, and always names the column actually clicked --
                          // the row-level click this replaced only ever moved row
                          // focus, so a click on any non-REF cell never focused that
                          // cell for editing. `stopPropagation` keeps a click here
                          // from ever reaching a stray row-level handler in the future
                          // and double-dispatching.
                          onClick={(event) => {
                            event.stopPropagation();
                            dispatchGridAction({
                              kind: "clickSelect",
                              rowIndex: virtualRow.index,
                              columnIndex,
                              withShift: event.shiftKey,
                            });
                          }}
                          className={`flex items-center gap-1.5 px-2 truncate ${
                            column.sticky ? "sticky left-0 z-10 bg-inherit font-medium" : ""
                          }`}
                        >
                          {editableColumn === undefined ? (
                            column.render(row, partnerNamesById[row.partnerId] ?? row.partnerId)
                          ) : (
                            <EditableCell
                              column={editableColumn}
                              row={row}
                              isEditing={isCellEditing}
                              onCloseEditor={() => dispatchGridAction({ kind: "cancelEdit" })}
                              renderClosedValue={() =>
                                column.render(row, partnerNamesById[row.partnerId] ?? row.partnerId)
                              }
                              onCommit={(nextValue) => {
                                void commitEdit({
                                  caseId: row.caseId,
                                  column: editableColumn,
                                  previousValue: readLedgerColumnValue(editableColumn, row),
                                  nextValue,
                                });
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {isRowExpanded && (
                    <ApplicantSubRows caseId={row.caseId} onLineCountChange={reportApplicantLineCount} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingConflict !== undefined && (
        <ConflictPrompt
          serverMessage={pendingConflict.serverMessage}
          yourValue={describeLedgerEditValue(pendingConflict.edit)}
          onKeepTheirs={() => resolveConflict("keepTheirs")}
          onKeepMine={() => resolveConflict("keepMine")}
        />
      )}
    </div>
  );
}
