import type { ReactNode } from "react";
import { crm } from "@rgs/shared";
import { AxisChip } from "../components/Chip";
import { CASE_TYPE_LABELS, VISA_TYPE_LABELS, describeCustodyRollUp } from "../labels";

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

function describeCaseType(row: crm.LedgerRow): string {
  const caseTypeLabel = CASE_TYPE_LABELS[row.caseType];
  if (row.visaType === undefined) return caseTypeLabel;
  return `${caseTypeLabel} · ${VISA_TYPE_LABELS[row.visaType]}`;
}

function renderApplicants(row: crm.LedgerRow): ReactNode {
  if (row.applicantSummary === undefined) {
    return describeCustodyRollUp(row.applicantSummary);
  }
  return `${row.applicantSummary.count} · ${describeCustodyRollUp(row.applicantSummary)}`;
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function formatInr(totalInr: number): string {
  return inrFormatter.format(totalInr);
}

export const LEDGER_COLUMNS: readonly LedgerColumn[] = [
  { key: "caseRef", header: "REF", width: 120, sticky: true, render: (row) => row.caseRef },
  { key: "partner", header: "Partner", width: 200, render: (_row, partnerName) => partnerName },
  { key: "destinationCountry", header: "Country", width: 80, render: (row) => row.destinationCountry },
  { key: "caseType", header: "Type", width: 150, render: (row) => describeCaseType(row) },
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
