import ExcelJS from "exceljs";
import { excelSerialToIsoDate, isExcelSerialCandidate } from "./excelSerial";

export interface RawMiniCrmRow {
  sourceRow: number;
  receivedDateRaw: string;
  caseRef: string;
  applicantsName: string;
  applicantCount: string;
  partnerName: string;
  country: string;
  dateOfBirthRaw: string;
  subDateRaw: string;
  collectionRaw: string;
  passportNumber: string;
  entries: string;
  visaType: string;
  status: string;
  additionalItems: string;
  remarks: string;
  courierDateRaw: string;
  paymentStatus: string;
  trackingNumber: string;
}

export interface RawYearRow {
  sourceRow: number;
  caseRef: string;
  phoneRaw: string;
  trackingNumber: string;
}

export interface WorkbookExtract {
  miniCrmRows: RawMiniCrmRow[];
  yearRows: RawYearRow[];
}

export const MINI_CRM_SHEET_NAME = "Mini CRM";
export const YEAR_SHEET_NAME = "2025 YEAR";

/**
 * Excel's error literals. A cell holding one of these has no value to import —
 * in the REF NO column it has no identity either, which is why `normaliseRefNo`
 * refuses them rather than keying a case on "#REF!".
 */
const EXCEL_ERROR_TEXTS: ReadonlySet<string> = new Set([
  "#REF!",
  "#VALUE!",
  "#N/A",
  "#NAME?",
  "#DIV/0!",
  "#NULL!",
  "#NUM!",
  "#SPILL!",
  "#CALC!",
  "#GETTING_DATA",
]);

/**
 * Cells arrive as strings, numbers, Dates, or one of three object shapes,
 * every one of them measured on the real workbook. `String(value)` yields
 * "[object Object]" on all three, so each is unwrapped explicitly:
 *
 *  - `{richText}`   — a name split into formatting runs (APPLICANTS NAME, row 54
 *                     on both sheets). Join the runs' text.
 *  - `{formula, …}` — a stray pasted formula (REF NO, row 1001 on both sheets).
 *                     Take its cached result, which is itself unwrapped.
 *  - `{text, …}`    — a hyperlink. Take the display text.
 *
 * exceljs's own `cell.text` is NOT a shortcut here: for the formula shape it
 * returns `result.toString()`, and the result is `{error: "#REF!"}`, so
 * `cell.text` is itself "[object Object]" — measured, not assumed. Unwrapping
 * the value is the only route that is right for all three.
 *
 * Everything becomes trimmed text; a numeric value that looks like a date
 * serial is converted by `normaliseDateCell`, at the boundary, because the
 * shared date normalizer deliberately refuses serials.
 */
export function normaliseCellText(rawCellValue: unknown): string {
  if (rawCellValue === null || rawCellValue === undefined) {
    return "";
  }
  if (rawCellValue instanceof Date) {
    // UTC, deliberately. Date-formatted cells come back as midnight UTC, and
    // getFullYear/getMonth/getDate would shift them a day in any negative-offset
    // timezone while looking correct on a +04:00 machine.
    return rawCellValue.toISOString().slice(0, 10);
  }
  if (typeof rawCellValue === "object") {
    if ("richText" in rawCellValue) {
      const formattingRuns = (rawCellValue as { richText: unknown }).richText;
      if (Array.isArray(formattingRuns)) {
        return formattingRuns
          .map((formattingRun): string =>
            typeof formattingRun === "object" && formattingRun !== null && "text" in formattingRun
              ? String((formattingRun as { text: unknown }).text)
              : "",
          )
          .join("")
          .trim();
      }
    }
    if ("formula" in rawCellValue || "sharedFormula" in rawCellValue) {
      // The cached result may be a string, a number, a Date, or an error
      // wrapper. Unwrap it the same way as any other cell.
      return normaliseCellText((rawCellValue as { result?: unknown }).result);
    }
    if ("error" in rawCellValue) {
      return String((rawCellValue as { error: unknown }).error).trim();
    }
    if ("text" in rawCellValue) {
      return String((rawCellValue as { text: unknown }).text).trim();
    }
  }
  if (typeof rawCellValue === "number") {
    return String(rawCellValue);
  }
  return String(rawCellValue).trim();
}

/**
 * A date cell: convert a serial, otherwise keep the text for the shared
 * normalizer. Branching is on the value's runtime type, never on which sheet
 * the row came from — every date column on both sheets is mixed Date/text/empty.
 *
 * Exported so the serial branch can be tested directly. It does not fire on the
 * current workbook (measured: zero numeric date cells) but it is the only thing
 * standing between a differently-exported file and five-year-shifted dates.
 */
export function normaliseDateCell(rawCellValue: unknown): string {
  if (isExcelSerialCandidate(rawCellValue)) {
    return excelSerialToIsoDate(rawCellValue) ?? String(rawCellValue);
  }
  return normaliseCellText(rawCellValue);
}

/**
 * `31376.0` and `"31376.0"` both become `"31376"`. Case identity depends on this.
 *
 * An Excel error resolves to "" rather than to its literal: row 1001 on both
 * sheets holds a broken formula in REF NO, and "#REF!" is non-empty, so without
 * this the reader would import a junk case keyed on "#REF!" — and, being an
 * identity, re-import it on every run.
 */
export function normaliseRefNo(rawCellValue: unknown): string {
  const text = normaliseCellText(rawCellValue);
  if (text === "" || EXCEL_ERROR_TEXTS.has(text)) {
    return "";
  }
  const numericValue = Number(text);
  return Number.isFinite(numericValue) ? String(Math.trunc(numericValue)) : text;
}

/** Phones arrive as floats in scientific notation: 7.23001238E8. */
function normalisePhone(rawCellValue: unknown): string {
  if (typeof rawCellValue === "number" && Number.isFinite(rawCellValue)) {
    return String(Math.trunc(rawCellValue));
  }
  return normaliseCellText(rawCellValue);
}

export async function readWorkbook(workbookPath: string): Promise<WorkbookExtract> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);

  const miniCrmSheet = workbook.getWorksheet(MINI_CRM_SHEET_NAME);
  const yearSheet = workbook.getWorksheet(YEAR_SHEET_NAME);
  if (miniCrmSheet === undefined) {
    throw new Error(`Workbook has no "${MINI_CRM_SHEET_NAME}" sheet`);
  }

  const miniCrmRows: RawMiniCrmRow[] = [];
  // eachRow skips blank rows inside the used range and reports the real 1-based
  // sheet number, which is why sourceRow is trustworthy provenance. Iterating
  // 1..rowCount instead would emit ~391 phantom rows on the real sheet.
  miniCrmSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    // Columns are read by POSITION. The real file has unreliable headers.
    const cellAt = (columnNumber: number): unknown => row.getCell(columnNumber).value;
    const caseRef = normaliseRefNo(cellAt(2));
    // A row with no REF NO carries no identity: blank rows and the four
    // month-divider rows (a date typed into APPLICANTS NAME) are dropped here,
    // and must never become review items.
    if (caseRef === "") return;
    miniCrmRows.push({
      sourceRow: rowNumber,
      receivedDateRaw: normaliseDateCell(cellAt(1)),
      caseRef,
      applicantsName: normaliseCellText(cellAt(3)),
      applicantCount: normaliseRefNo(cellAt(4)),
      partnerName: normaliseCellText(cellAt(5)),
      country: normaliseCellText(cellAt(6)),
      dateOfBirthRaw: normaliseDateCell(cellAt(7)),
      subDateRaw: normaliseDateCell(cellAt(8)),
      collectionRaw: normaliseDateCell(cellAt(9)),
      passportNumber: normaliseCellText(cellAt(10)),
      entries: normaliseCellText(cellAt(11)),
      visaType: normaliseCellText(cellAt(12)),
      status: normaliseCellText(cellAt(13)),
      additionalItems: normaliseCellText(cellAt(14)),
      // c15-c19. The reader used to stop at c14, discarding 3,217 populated
      // cells: "Remarks" 270, "COURIER DATE" 256, "payment status" 34 and
      // "TRACKING NO." 2,657 (measured over these 7,156 importable rows).
      // c18 and c20 are the sheet's own empty "Column 2"/"Column 3" spacers
      // -- measured at 0 non-empty cells each -- so they carry nothing to
      // read. One "payment status" cell is a {text, hyperlink} object, which
      // normaliseCellText already unwraps.
      remarks: normaliseCellText(cellAt(15)),
      courierDateRaw: normaliseDateCell(cellAt(16)),
      paymentStatus: normaliseCellText(cellAt(17)),
      trackingNumber: normaliseCellText(cellAt(19)),
    });
  });

  const yearRows: RawYearRow[] = [];
  yearSheet?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cellAt = (columnNumber: number): unknown => row.getCell(columnNumber).value;
    const caseRef = normaliseRefNo(cellAt(2));
    if (caseRef === "") return;
    yearRows.push({
      sourceRow: rowNumber,
      caseRef,
      phoneRaw: normalisePhone(cellAt(10)),
      trackingNumber: normaliseCellText(cellAt(11)),
    });
  });

  return { miniCrmRows, yearRows };
}
