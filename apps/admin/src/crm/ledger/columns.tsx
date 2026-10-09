import type { ReactNode } from "react";
import { Link } from "react-router";
import { crm } from "@rgs/shared";
import type { OpenReviewSummaryEntry } from "../api/crmClient";
import { AxisChip } from "../components/Chip";
import { describeCaseType, describeCustodyRollUp, formatInr } from "../labels";
import { ReviewMarker } from "./ReviewMarker";

/**
 * Base collapsed row height. 48px fits AxisChip `md` (h-7) without clipping
 * pill bottoms; family REF stacks use `collapsedLedgerRowHeight` instead.
 */
export const LEDGER_ROW_HEIGHT = 48;

/** Rough REF stack line (text-xs / 10px) for derived virtualizer heights. */
const COLLAPSED_REF_LINE_PX = 16;

/**
 * Collapsed height for one ledger row. Solo rows stay at `LEDGER_ROW_HEIGHT`;
 * family rows (extra applicant REFs and/or group name) grow so the REF stack
 * is not clipped by the virtualizer's fixed estimate.
 */
export function collapsedLedgerRowHeight(row: crm.LedgerRow): number {
  const extraApplicantRefs = (row.applicantRefs ?? []).filter(
    (applicantRef) => applicantRef !== row.caseRef,
  );
  const extraLines =
    (extraApplicantRefs.length > 0 ? 1 : 0) + (row.groupName !== undefined ? 1 : 0);
  if (extraLines === 0) return LEDGER_ROW_HEIGHT;
  // Primary REF + each secondary line, with a little vertical pad for the chip column.
  return Math.max(LEDGER_ROW_HEIGHT, 12 + (1 + extraLines) * COLLAPSED_REF_LINE_PX);
}

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
    // Wide enough for case REF + family REF NO line + review marker.
    width: 200,
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
    render: (row, _partnerName, cellContext) => {
      // Case REF is the primary line. Extra applicant REF NOs only (no repeat
      // of caseRef) — family rows stay compact: 38608 / +38609 / PATANJALI FAMILY.
      const extraApplicantRefs = (row.applicantRefs ?? []).filter(
        (applicantRef) => applicantRef !== row.caseRef,
      );
      const allRefsForTooltip = [row.caseRef, ...extraApplicantRefs];
      const refsTooltip = allRefsForTooltip.join(" · ");
      return (
        <>
          <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <Link
              to={`/crm/cases/${row.caseId}`}
              tabIndex={-1}
              title={refsTooltip}
              className="mrz whitespace-nowrap text-xs font-semibold text-rgs-red-deep hover:underline"
            >
              {row.caseRef}
            </Link>
            {extraApplicantRefs.length > 0 && (
              <span
                data-testid="ledger-applicant-refs"
                title={refsTooltip}
                className="truncate font-mono text-[10px] tabular-nums text-ink-soft"
              >
                +{extraApplicantRefs.join(" · ")}
              </span>
            )}
            {row.groupName !== undefined && (
              <span data-testid="ledger-group-name" className="truncate text-[10px] text-ink-soft">
                {row.groupName}
              </span>
            )}
          </span>
          <ReviewMarker
            caseRef={row.caseRef}
            entry={cellContext.reviewEntry}
            isFocusedRow={cellContext.isFocusedRow}
          />
        </>
      );
    },
  },
  { key: "partner", header: "Partner", width: 160, render: (_row, partnerName) => partnerName },
  { key: "destinationCountry", header: "Country", width: 72, render: (row) => row.destinationCountry },
  {
    key: "caseType",
    header: "Type",
    width: 130,
    // Fix round 1, F1: this axis's edit was implemented and pinned in
    // EditableCell.test.tsx (Task 12) but never wired to a column, so it was
    // unreachable in the product. "Type" is the only column that already
    // displays a visa type, so it is the natural home for editing one.
    editable: "visaType",
    render: (row) => describeCaseType(row),
  },
  { key: "applicants", header: "Applicants", width: 180, render: (row) => renderApplicants(row) },
  {
    key: "caseStatus",
    header: "Status",
    // Longest label is "Additional Documents Required" — keep the pill uncropped.
    width: 260,
    editable: "caseStatus",
    render: (row) => <AxisChip axis="caseStatus" value={row.caseStatus} size="md" />,
  },
  {
    key: "billingStatus",
    header: "Billing",
    width: 110,
    editable: "billingStatus",
    render: (row) => <AxisChip axis="billing" value={row.billingStatus} />,
  },
  { key: "receivedDate", header: "Received", width: 100, render: (row) => row.receivedDate },
  {
    key: "submissionDate",
    header: "Sub date",
    width: 100,
    render: (row) => row.submissionDate ?? "—",
  },
  {
    key: "appointmentDate",
    header: "Appointment",
    width: 110,
    editable: "appointmentDate",
    render: (row) => row.appointmentDate ?? "—",
  },
  {
    key: "expectedCollectionDate",
    header: "Collect",
    width: 100,
    render: (row) => row.expectedCollectionDate ?? "—",
  },
  {
    key: "lineItemCount",
    header: "Lines",
    width: 70,
    render: (row) => String(row.lineItemCount ?? 0),
  },
  { key: "totalInr", header: "Total", width: 100, render: (row) => formatInr(row.totalInr) },
];
