import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { crm } from "@rgs/shared";
import { describeLedgerEditValue, useLedgerEdit } from "../api/mutations";
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
 * line per applicant `<ApplicantSubRows>` will draw. It reads
 * `applicantSummary.count` -- the same roll-up the collapsed "Applicants"
 * column already renders (`columns.tsx`'s `renderApplicants`) -- rather than
 * waiting for `useCase` to resolve, because the virtualizer must place every
 * row up front, long before any expanded row's own fetch has settled.
 *
 * A case imported before that roll-up existed (`applicantSummary ===
 * undefined`) has no count to read yet; `1` is the floor every real case
 * guarantees (`CrmCaseSchema.applicants` requires at least one), not a
 * guess that could come in short. See the module comment below, on
 * `estimateSize`, for why a short guess here could never overlap the next
 * row even if the real count turns out bigger.
 */
function estimateExpandedRowHeight(row: crm.LedgerRow): number {
  const applicantLineCount = row.applicantSummary?.count ?? 1;
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
      return gridState.expandedRowIndexes.includes(index) ? estimateExpandedRowHeight(row) : LEDGER_ROW_HEIGHT;
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
  useEffect(() => {
    rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridState.expandedRowIndexes]);

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
                <div
                  key={row.caseId}
                  data-testid="ledger-row"
                  data-case-id={row.caseId}
                  role="row"
                  aria-selected={isRowSelected ? "true" : "false"}
                  aria-expanded={isRowExpanded}
                  className="absolute left-0 w-full border-b border-crm-rule-row bg-crm-canvas"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
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
                  {isRowExpanded && <ApplicantSubRows caseId={row.caseId} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingConflict !== undefined && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="This case changed underneath your edit"
          className="absolute inset-0 z-40 flex items-center justify-center bg-crm-charcoal/40"
        >
          <div className="w-full max-w-sm rounded-crm-card border border-crm-rule-box bg-crm-canvas p-4 text-[13px] text-crm-charcoal shadow">
            <p className="font-medium">This case changed underneath your edit.</p>
            <p className="mt-2 text-crm-steel">{pendingConflict.serverMessage}</p>
            <p className="mt-2">Your value: {describeLedgerEditValue(pendingConflict.edit)}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => resolveConflict("keepTheirs")}
                className="rounded-crm-control border border-crm-rule-box px-2 py-1"
              >
                Keep theirs
              </button>
              <button
                type="button"
                onClick={() => resolveConflict("keepMine")}
                className="rounded-crm-control border border-crm-primary bg-crm-lavender px-2 py-1"
              >
                Keep mine
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
