import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { crm } from "@rgs/shared";
import { LEDGER_COLUMNS, LEDGER_ROW_HEIGHT } from "./columns";
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
    <div className="crm-root flex h-full flex-col border border-crm-rule-box rounded-crm-card overflow-hidden">
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
                        {column.render(row, partnerNamesById[row.partnerId] ?? row.partnerId)}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
