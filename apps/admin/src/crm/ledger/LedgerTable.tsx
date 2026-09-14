import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { crm } from "@rgs/shared";
import { LEDGER_COLUMNS, LEDGER_ROW_HEIGHT } from "./columns";

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

      <div data-testid="ledger-scroll" ref={scrollContainerRef} className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="p-6 text-crm-steel">No cases match these filters.</p>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div
                  key={row.caseId}
                  data-testid="ledger-row"
                  data-case-id={row.caseId}
                  className="absolute left-0 grid w-full border-b border-crm-rule-row bg-crm-canvas hover:bg-crm-surface"
                  style={{
                    gridTemplateColumns,
                    height: LEDGER_ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {LEDGER_COLUMNS.map((column) => (
                    <div
                      key={column.key}
                      data-column={column.key}
                      className={`flex items-center gap-1.5 px-2 truncate ${
                        column.sticky ? "sticky left-0 z-10 bg-inherit font-medium" : ""
                      }`}
                    >
                      {column.render(row, partnerNamesById[row.partnerId] ?? row.partnerId)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
