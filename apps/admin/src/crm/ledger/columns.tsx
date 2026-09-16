import type { ReactNode } from "react";
import { Link } from "react-router";
import { crm } from "@rgs/shared";
import type { OpenReviewSummaryEntry } from "../api/crmClient";
import { AxisChip } from "../components/Chip";
import { describeCaseType, describeCustodyRollUp, formatInr } from "../labels";
import { ReviewMarker } from "./ReviewMarker";

/** Exactly 40px: the Queue table's row height, chosen for readability over density (2026-09-16). About 18 rows on a laptop. */
export const LEDGER_ROW_HEIGHT = 40;

/**
 * Per-row data that is not part of the row itself, handed to `render` as a
 * third argument (R66).
 *
 * A third argument rather than a React context, because the alternative is
 * worse in a specific way: `LEDGER_COLUMNS` is a module-level array of plain
 * objects, so a context would have to be read by a component INSIDE each
 * render function -- turning every column cell into a context consumer that
 * re-renders whenever the review summary refetches, including the nine columns
 * that have nothing to do with review. The cost of this shape is one prop
 * threaded through one component; other columns simply ignore the argument.
 */
export interface LedgerCellContext {
  /** This case's open review items, joined on `caseRef`. Absent for a clean case. */
  reviewEntry?: OpenReviewSummaryEntry;
  /**
   * Whether the grid's focus sits on this row (R74, fix round 1 F1).
   *
   * It rides in the cell context rather than in `LedgerRow` because it is not
   * a fact about the CASE at all -- it is a fact about where the grid's cursor
   * is this render, which is precisely the kind of per-row, not-in-the-row
   * datum this interface exists for.
   */
  isFocusedRow: boolean;
}

export interface LedgerColumn {
  key: string;
  header: string;
  /** px. The table is a CSS grid, not a <table>: a virtualizer needs fixed track widths. */
  width: number;
  /** REF only. Sticky-left, so the row a desk agent is editing never loses its name. */
  sticky?: boolean;
  /**
   * Which axis an inline edit on this column writes to, or absent for a
   * read-only column. Only the four with a REST route are editable
   * (Task 7 + the three axis routes) -- a column with no route is not made
   * editable "for later", because the failure mode is a desk agent typing a
   * value that silently never saves.
   */
  editable?: "caseStatus" | "billingStatus" | "appointmentDate" | "visaType";
  render(row: crm.LedgerRow, partnerName: string, cellContext: LedgerCellContext): ReactNode;
}

function renderApplicants(row: crm.LedgerRow): ReactNode {
  if (row.applicantSummary === undefined) {
    return describeCustodyRollUp(row.applicantSummary);
  }
  return `${row.applicantSummary.count} · ${describeCustodyRollUp(row.applicantSummary)}`;
}

export const LEDGER_COLUMNS: readonly LedgerColumn[] = [
  {
    key: "caseRef",
    header: "REF",
    width: 120,
    sticky: true,
    // Spec §5: the Case screen is "reached by clicking a REF". `tabIndex={-1}`
    // on purpose (Task 14): the grid owns its own roving tabindex on the
    // gridcell wrapper, and an anchor that kept the default tab stop would add
    // one Tab stop per mounted row -- the grid deliberately leaves Tab alone
    // (`useGridKeyboard`'s closing comment) and this must not change what Tab
    // does. A click still navigates; the anchor's own onClick has already run
    // by the time the cell's `stopPropagation` fires.
    // Spec §7: a case with unresolved review items carries a marker on its
    // row, joined on `caseRef`. It rides in the REF cell because `caseRef` is
    // the only thing the summary knows about a case -- the projection carries
    // no caseId -- and because the REF cell is sticky, so the mark stays
    // visible however far right the desk agent has scrolled.
    // R74 (fix round 1, F1): the marker chip is the ONE exception to the "no
    // Tab stop per mounted row" rule above, and only because its tab stop
    // ROVES with the grid's focus -- `isFocusedRow` is what makes it roam.
    render: (row, _partnerName, cellContext) => (
      <>
        <Link
          to={`/crm/cases/${row.caseId}`}
          tabIndex={-1}
          className="mrz text-xs font-semibold text-rgs-red-deep hover:underline"
        >
          {row.caseRef}
        </Link>
        <ReviewMarker
          caseRef={row.caseRef}
          entry={cellContext.reviewEntry}
          isFocusedRow={cellContext.isFocusedRow}
        />
      </>
    ),
  },
  { key: "partner", header: "Partner", width: 200, render: (_row, partnerName) => partnerName },
  { key: "destinationCountry", header: "Country", width: 80, render: (row) => row.destinationCountry },
  {
    key: "caseType",
    header: "Type",
    width: 150,
    // Fix round 1, F1: this axis's edit was implemented and pinned in
    // EditableCell.test.tsx (Task 12) but never wired to a column, so it was
    // unreachable in the product. "Type" is the only column that already
    // displays a visa type, so it is the natural home for editing one.
    editable: "visaType",
    render: (row) => describeCaseType(row),
  },
  { key: "applicants", header: "Applicants", width: 220, render: (row) => renderApplicants(row) },
  {
    key: "caseStatus",
    header: "Status",
    width: 140,
    editable: "caseStatus",
    render: (row) => <AxisChip axis="caseStatus" value={row.caseStatus} />,
  },
  {
    key: "billingStatus",
    header: "Billing",
    width: 120,
    editable: "billingStatus",
    render: (row) => <AxisChip axis="billing" value={row.billingStatus} />,
  },
  { key: "receivedDate", header: "Received", width: 110, render: (row) => row.receivedDate },
  {
    key: "appointmentDate",
    header: "Appointment",
    width: 120,
    editable: "appointmentDate",
    render: (row) => row.appointmentDate ?? "—",
  },
  { key: "totalInr", header: "Total", width: 110, render: (row) => formatInr(row.totalInr) },
];
