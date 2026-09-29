import ExcelJS from "exceljs";
import { crm } from "@rgs/shared";
import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_COLUMNS,
  buildLedgerWorkbookBytes,
  exportFileName,
  fetchAllExportRows,
} from "../../src/crm/ledger/ledgerExport";

function exportRow(overrides: Partial<crm.CaseExportRow> = {}): crm.CaseExportRow {
  return {
    caseId: "case_1",
    caseRef: "38017",
    partnerName: "Ozzy Travels",
    destinationCountry: "JP",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-09-01",
    totalInr: 4500,
    applicantRefNo: "38017",
    applicantName: "ASHA RAO",
    custody: "NOT_HELD",
    outcome: "PENDING",
    ...overrides,
  };
}

describe("fetchAllExportRows", () => {
  it("asks in batches of MAX_EXPORT_CASE_IDS, keeps order, and collects missing ids", async () => {
    const caseIds = Array.from({ length: crm.MAX_EXPORT_CASE_IDS + 3 }, (_, index) => `case_${index}`);
    const fetchBatch = vi.fn(async (batchCaseIds: string[]) => ({
      rows: batchCaseIds.slice(0, 1).map((caseId) => exportRow({ caseId })),
      missingCaseIds: batchCaseIds.slice(-1),
    }));
    const progressCalls: [number, number][] = [];

    const result = await fetchAllExportRows(fetchBatch, caseIds, (doneCount, totalCount) =>
      progressCalls.push([doneCount, totalCount]),
    );

    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch.mock.calls[0]?.[0]).toHaveLength(crm.MAX_EXPORT_CASE_IDS);
    expect(result.rows.map((row) => row.caseId)).toEqual(["case_0", `case_${crm.MAX_EXPORT_CASE_IDS}`]);
    expect(result.missingCaseIds).toEqual([`case_${crm.MAX_EXPORT_CASE_IDS - 1}`, `case_${crm.MAX_EXPORT_CASE_IDS + 2}`]);
    expect(progressCalls.at(-1)).toEqual([caseIds.length, caseIds.length]);
  });
});

describe("buildLedgerWorkbookBytes", () => {
  it("writes a header row and one labelled row per export row", async () => {
    const workbookBytes = await buildLedgerWorkbookBytes([exportRow(), exportRow({ applicantName: "RAVI RAO", applicantRefNo: "A2" })]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBytes);
    const worksheet = workbook.getWorksheet("Cases")!;

    expect(worksheet.getRow(1).getCell(1).value).toBe(EXPORT_COLUMNS[0]!.header);
    expect(worksheet.rowCount).toBe(3);
    const headerTexts = EXPORT_COLUMNS.map((column) => column.header);
    const statusColumnNumber = headerTexts.indexOf("Status") + 1;
    expect(worksheet.getRow(2).getCell(statusColumnNumber).value).toBe("New");
    const nameColumnNumber = headerTexts.indexOf("Applicant") + 1;
    expect(worksheet.getRow(3).getCell(nameColumnNumber).value).toBe("RAVI RAO");
  });
});

it("names the file after the day", () => {
  expect(exportFileName("2026-09-29")).toBe("rgs-ledger-2026-09-29.xlsx");
});
