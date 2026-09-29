import { crm } from "@rgs/shared";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  CUSTODY_LABELS,
  ENTRY_TYPE_LABELS,
  OUTCOME_LABELS,
  PROCESSING_LABELS,
  VISA_TYPE_LABELS,
} from "../labels";

type ExportRowsBatch = { rows: crm.CaseExportRow[]; missingCaseIds: string[] };

/**
 * The sheet's columns, in order, and how each reads a row. Labels, not raw
 * enum values: the file is for people, and "APPOINTMENT_SET" is not how the
 * desk says it.
 */
export const EXPORT_COLUMNS: readonly { header: string; value: (row: crm.CaseExportRow) => string | number }[] = [
  { header: "REF", value: (row) => row.caseRef },
  { header: "Group", value: (row) => row.groupName ?? "" },
  { header: "Applicant REF NO", value: (row) => row.applicantRefNo },
  { header: "Applicant", value: (row) => row.applicantName },
  { header: "Passport", value: (row) => row.passportNumber ?? "" },
  { header: "Partner", value: (row) => row.partnerName },
  { header: "Country", value: (row) => row.destinationCountry },
  { header: "Type", value: (row) => CASE_TYPE_LABELS[row.caseType] },
  { header: "Visa type", value: (row) => (row.visaType === undefined ? "" : VISA_TYPE_LABELS[row.visaType]) },
  { header: "Entry", value: (row) => (row.entryType === undefined ? "" : ENTRY_TYPE_LABELS[row.entryType]) },
  { header: "Processing", value: (row) => (row.processing === undefined ? "" : PROCESSING_LABELS[row.processing]) },
  { header: "Status", value: (row) => CASE_STATUS_LABELS[row.caseStatus] },
  { header: "Billing", value: (row) => BILLING_LABELS[row.billingStatus] },
  { header: "Received", value: (row) => row.receivedDate },
  { header: "Submitted", value: (row) => row.submissionDate ?? "" },
  { header: "Appointment", value: (row) => row.appointmentDate ?? "" },
  { header: "Collection", value: (row) => row.expectedCollectionDate ?? "" },
  { header: "Custody", value: (row) => CUSTODY_LABELS[row.custody] },
  { header: "Outcome", value: (row) => OUTCOME_LABELS[row.outcome] },
  { header: "Tracking", value: (row) => row.trackingNumber ?? "" },
  { header: "Total (INR)", value: (row) => row.totalInr },
  { header: "Client email", value: (row) => row.clientEmail ?? "" },
  { header: "Remarks", value: (row) => row.remarks ?? "" },
];

export async function fetchAllExportRows(
  fetchBatch: (caseIds: string[]) => Promise<ExportRowsBatch>,
  caseIds: readonly string[],
  onProgress?: (doneCount: number, totalCount: number) => void,
): Promise<ExportRowsBatch> {
  const collected: ExportRowsBatch = { rows: [], missingCaseIds: [] };
  // Sequential on purpose: each batch is one Lambda call near its budget, and
  // firing fifteen at once would trade a slower export for throttled ones.
  for (let batchStart = 0; batchStart < caseIds.length; batchStart += crm.MAX_EXPORT_CASE_IDS) {
    const batchCaseIds = caseIds.slice(batchStart, batchStart + crm.MAX_EXPORT_CASE_IDS);
    const batchResult = await fetchBatch(batchCaseIds);
    collected.rows.push(...batchResult.rows);
    collected.missingCaseIds.push(...batchResult.missingCaseIds);
    onProgress?.(batchStart + batchCaseIds.length, caseIds.length);
  }
  return collected;
}

export async function buildLedgerWorkbookBytes(rows: readonly crm.CaseExportRow[]): Promise<ArrayBuffer> {
  // Loaded on click, not with the Ledger: exceljs is large and most visits never export.
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Cases", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.addRow(EXPORT_COLUMNS.map((column) => column.header));
  worksheet.getRow(1).font = { bold: true };
  for (const exportRow of rows) {
    worksheet.addRow(EXPORT_COLUMNS.map((column) => column.value(exportRow)));
  }
  EXPORT_COLUMNS.forEach((column, columnIndex) => {
    worksheet.getColumn(columnIndex + 1).width = Math.max(12, column.header.length + 2);
  });
  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

export function exportFileName(todayIso: string): string {
  return `rgs-ledger-${todayIso}.xlsx`;
}
