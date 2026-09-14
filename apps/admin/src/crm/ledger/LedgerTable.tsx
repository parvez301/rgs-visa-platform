import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { crm } from "@rgs/shared";
import { describeLedgerEditValue, useLedgerEdit } from "../api/mutations";
import { LEDGER_COLUMNS, LEDGER_ROW_HEIGHT } from "./columns";
import { EditableCell, readLedgerColumnValue } from "./EditableCell";
import { useGridKeyboard } from "./useGridKeyboard";

interface LedgerTableProps {
  rows: crm.LedgerRow[];
  partnerNamesById: Record<string, string>;
}

export function LedgerTable({ rows, partnerNamesById }: LedgerTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => LEDGER_ROW_HEIGHT,
    // Enough rows above and below the window that a fast scroll does not show
    // blank bands, and few enough that the DOM stays small.
    overscan: 12,
  });

  const { state: gridState, onKeyDown: onGridKeyDown, dispatch: dispatchGridAction } = useGridKeyboard({
    rowCount: rows.length,
    columnCount: LEDGER_COLUMNS.length,
  });

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
  useEffect(() => {
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
              return (
                <div
                  key={row.caseId}
                  data-testid="ledger-row"
                  data-case-id={row.caseId}
                  role="row"
                  aria-selected={isRowSelected ? "true" : "false"}
                  onClick={(event) =>
                    dispatchGridAction({
                      kind: "clickSelect",
                      rowIndex: virtualRow.index,
                      withShift: event.shiftKey,
                    })
                  }
                  className="absolute left-0 grid w-full border-b border-crm-rule-row bg-crm-canvas hover:bg-crm-surface"
                  style={{
                    gridTemplateColumns,
                    height: LEDGER_ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
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
