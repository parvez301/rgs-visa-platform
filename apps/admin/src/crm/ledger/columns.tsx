import type { ReactNode } from "react";
import { Link } from "react-router";
import { crm } from "@rgs/shared";
import { AxisChip } from "../components/Chip";
import { describeCaseType, describeCustodyRollUp, formatInr } from "../labels";

/** Exactly 32px. Spec §3: a desk agent must see ~30 cases without scrolling. */
export const LEDGER_ROW_HEIGHT = 32;

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
  render(row: crm.LedgerRow, partnerName: string): ReactNode;
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
    render: (row) => (
      <Link
        to={`/crm/cases/${row.caseId}`}
        tabIndex={-1}
        className="text-crm-link hover:underline"
      >
        {row.caseRef}
      </Link>
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
