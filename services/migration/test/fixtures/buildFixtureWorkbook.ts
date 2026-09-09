import ExcelJS from "exceljs";

const MINI_CRM_HEADER_ROW = [
  "C",
  "REF NO.",
  "APPLICANTS NAME",
  "No.",
  "REFRENCE",
  "Country",
  "DOB",
  "Sub Date",
  "Collection",
  "Passport No.",
  "Entries",
  "Visa Type",
  "Status",
  "Additional Items",
];

/** Column E's header really is "China" in the source file. */
const YEAR_HEADER_ROW = [
  "DATE",
  "REF NO.",
  "APPLICANTS NAME",
  "REFRENCE",
  "China",
  "DOB",
  "No.",
  "Sub Date",
  "Collection",
  "Phone",
  "TRACKING NO.",
  "Passport No.",
  "Visa Type",
  "Entries",
];

/**
 * Builds a workbook reproducing the real file's traps: text dates on
 * "Mini CRM", serial dates and a mislabeled column-E header on "2025 YEAR",
 * and float-formatted REF NO / No. values on both.
 */
export async function buildFixtureWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const miniCrm = workbook.addWorksheet("Mini CRM");
  miniCrm.addRow(["C","REF NO.","APPLICANTS NAME","No.","REFRENCE","Country","DOB","Sub Date","Collection","Passport No.","Entries","Visa Type","Status","Additional Items"]);
  // Collection is a real Date object, which is how exceljs hands back 1,045 of
  // Mini CRM's Collection cells. Sub Date stays text: the column is mixed.
  miniCrm.addRow(["30-12-2024", 31376, "AKSHAY JAIN", 3, "Sudiva Spinners Pvt Ltd", "Turkey", "", "12/31/2024", new Date(Date.UTC(2025, 9, 1)), "V2404480", "Single", "Business", "Handover", "PHOTO, HOTEL"]);
  miniCrm.addRow(["02-01-2025", 31377, "MEERA IYER", 1, "VWI Mumbai", "Vietnam", "", "05/01/2025", "", "M1234567", "Multiple 1 Yr", "Tourist", "Approved", ""]);
  miniCrm.addRow(["03-01-2025", 31378, "RAVI NAIR", 1, "VWI BOM", "Czech Group", "", "aposttile", "", "", "Business", "Attestation", "DEU/DEL/190126/", ""]);

  // Column E's header really is "China" in the source file.
  const yearSheet = workbook.addWorksheet("2025 YEAR");
  yearSheet.addRow(["DATE","REF NO.","APPLICANTS NAME","REFRENCE","China","DOB","No.","Sub Date","Collection","Phone","TRACKING NO.","Passport No.","Visa Type","Entries"]);
  yearSheet.addRow(["30-12-2024", 31376, "AKSHAY JAIN", "Sudiva Spinners Pvt Ltd", "Turkey", "", 3, 45657, 45931, 723001238, "DTDC9911", "V2404480", "Business", "Single"]);
  yearSheet.addRow(["02-01-2025", 31377, "MEERA IYER", "VWI Mumbai", "Vietnam", "", 1, 45658, "", 9812345670, "", "M1234567", "Tourist", "Multiple 1 Yr"]);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * A second workbook for the shapes the primary fixture cannot express, each one
 * measured on the real file:
 *  - a month-divider row (a date typed into APPLICANTS NAME, no REF NO) — four
 *    of these sit inside "Mini CRM" and must be dropped, never queued;
 *  - blank rows inside the used range, so `sourceRow` is provably the real sheet
 *    row and not an array index shifted past the header;
 *  - a `{ text, hyperlink }` cell, on which `String(value)` yields
 *    "[object Object]";
 *  - a Date-typed DOB, pinning the UTC rendering in a second column.
 */
export async function buildEdgeCaseWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const miniCrm = workbook.addWorksheet("Mini CRM");
  miniCrm.addRow(MINI_CRM_HEADER_ROW);
  miniCrm.addRow([
    "01-01-2025",
    40001,
    "PRIYA DESAI",
    1,
    "VWI Pune",
    "France",
    new Date(Date.UTC(1990, 4, 17)),
    "12/31/2024",
    "",
    { text: "P9988776", hyperlink: "https://example.invalid/P9988776" },
    "Single",
    "Tourist",
    "Approved",
    "",
  ]);
  // Sheet row 3: a month divider. Somebody typed a date into APPLICANTS NAME and
  // left every other column empty, REF NO included.
  miniCrm.addRow([null, null, new Date(Date.UTC(2025, 0, 1))]);

  // Sheet rows 4-6 are left entirely absent, reproducing the 391 blank rows that
  // sit inside "Mini CRM"'s used range. The next real record is sheet row 7.
  const rowAfterTheBlankRun = miniCrm.getRow(7);
  const rowAfterTheBlankRunValues = [
    "05-01-2025",
    40002,
    "ARJUN RAO",
    2,
    "VWI Delhi",
    "Japan",
    "",
    "",
    "",
    "J7654321",
    "Multiple 1 Yr",
    "Business",
    "Handover",
    "PHOTO",
  ];
  rowAfterTheBlankRunValues.forEach((cellValue, zeroBasedColumnOffset) => {
    rowAfterTheBlankRun.getCell(zeroBasedColumnOffset + 1).value = cellValue;
  });

  const yearSheet = workbook.addWorksheet("2025 YEAR");
  yearSheet.addRow(YEAR_HEADER_ROW);
  yearSheet.addRow([
    "01-01-2025",
    40001,
    "PRIYA DESAI",
    "VWI Pune",
    "France",
    "",
    1,
    45658,
    "",
    723001238,
    { text: "DTDC7001", hyperlink: "https://example.invalid/track/DTDC7001" },
    "P9988776",
    "Tourist",
    "Single",
  ]);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/** A workbook whose "Mini CRM" sheet is missing: reading it must be refused. */
export async function buildWorkbookWithoutMiniCrmSheet(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const yearSheet = workbook.addWorksheet("2025 YEAR");
  yearSheet.addRow(YEAR_HEADER_ROW);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
