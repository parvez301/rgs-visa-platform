import { LEDGER_ROW_HEIGHT } from "./columns";

/** Placeholder rows while the first ledger page is in flight. */
export function LedgerSkeleton({ rowCount = 12 }: { rowCount?: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-line"
      aria-busy="true"
      aria-label="Loading ledger"
    >
      {Array.from({ length: rowCount }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="animate-pulse border-b border-line bg-mist/70 last:border-b-0"
          style={{
            height: LEDGER_ROW_HEIGHT,
            opacity: Math.max(0.25, 1 - rowIndex * 0.05),
          }}
        />
      ))}
    </div>
  );
}
