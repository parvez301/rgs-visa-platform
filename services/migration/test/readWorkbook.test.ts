import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildEdgeCaseWorkbook,
  buildFixtureWorkbook,
  buildWorkbookWithoutMiniCrmSheet,
} from "./fixtures/buildFixtureWorkbook";
import {
  normaliseCellText,
  normaliseDateCell,
  normaliseRefNo,
  readWorkbook,
  type WorkbookExtract,
} from "../src/readWorkbook";

let extract: WorkbookExtract;
let edgeCaseExtract: WorkbookExtract;

async function writeWorkbookToTemporaryFile(workbookContents: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rgs-migration-"));
  const workbookPath = join(directory, "fixture.xlsx");
  await writeFile(workbookPath, workbookContents);
  return workbookPath;
}

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgs-migration-"));
  const workbookPath = join(directory, "fixture.xlsx");
  await writeFile(workbookPath, await buildFixtureWorkbook());
  extract = await readWorkbook(workbookPath);

  edgeCaseExtract = await readWorkbook(
    await writeWorkbookToTemporaryFile(await buildEdgeCaseWorkbook()),
  );
});

describe("readWorkbook", () => {
  it("reads every Mini CRM data row and numbers them by sheet row", () => {
    expect(extract.miniCrmRows).toHaveLength(3);
    expect(extract.miniCrmRows[0]!.sourceRow).toBe(2);
    expect(extract.miniCrmRows[2]!.sourceRow).toBe(4);
  });

  it("strips the float formatting from REF NO so case identity is stable", () => {
    expect(extract.miniCrmRows[0]!.caseRef).toBe("31376");
    expect(extract.miniCrmRows[0]!.applicantCount).toBe("3");
    expect(normaliseRefNo(31376)).toBe("31376");
    expect(normaliseRefNo("31376.0")).toBe("31376");
  });

  it("passes Mini CRM text dates through untouched", () => {
    expect(extract.miniCrmRows[0]!.subDateRaw).toBe("12/31/2024");
  });

  it("renders a Date-valued cell as an ISO date, in UTC", () => {
    // 1,045 Mini CRM Collection cells and 2,021 "2025 YEAR" Sub Date cells arrive
    // as Date objects. Local-time getters shift a midnight-UTC Date by a day in
    // any negative-offset zone, so this must be UTC-based. Asserting the exact
    // string is what makes the bug visible; a `toContain("2025")` would not.
    expect(extract.miniCrmRows[0]!.collectionRaw).toBe("2025-10-01");
  });

  it("is not sensitive to the machine's timezone", () => {
    // Guard: the same Date must render identically regardless of TZ. If this ever
    // fails, normaliseDateCell is using getFullYear/getMonth/getDate instead of
    // their getUTC* counterparts.
    const midnightUtc = new Date(Date.UTC(2025, 9, 1));
    expect(midnightUtc.toISOString().slice(0, 10)).toBe("2025-10-01");
    // The line above only exercises the JS runtime. These two put the same Date
    // through our own code, which is what the guard is actually for: run the
    // suite under TZ=America/New_York and a getFullYear/getMonth/getDate
    // implementation reddens here.
    expect(normaliseDateCell(midnightUtc)).toBe("2025-10-01");
    expect(normaliseCellText(midnightUtc)).toBe("2025-10-01");
  });

  it("converts a raw numeric serial, the branch real data never reaches", () => {
    // Without this the shared date normalizer refuses serials and every
    // row on this sheet would land in the review queue.
    expect(extract.yearRows).toHaveLength(2);
    expect(extract.miniCrmRows[0]!.collectionRaw).toBe("2025-10-01");
    // Neither assertion above touches the numeric branch: no field on RawYearRow
    // is a date, and Collection arrives as a Date. Delete the serial branch from
    // normaliseDateCell and they both still pass. These do not.
    expect(normaliseDateCell(45657)).toBe("2024-12-31");
    expect(normaliseDateCell(45931)).toBe("2025-10-01");
  });

  it("reads 2025 YEAR by position despite the column-E header saying 'China'", () => {
    expect(extract.yearRows[0]!.caseRef).toBe("31376");
    expect(extract.yearRows[0]!.trackingNumber).toBe("DTDC9911");
  });

  it("expands a scientific-notation phone back to digits", () => {
    expect(extract.yearRows[0]!.phoneRaw).toBe("723001238");
    expect(extract.yearRows[1]!.phoneRaw).toBe("9812345670");
  });

  it("returns empty strings for blank cells rather than undefined", () => {
    expect(extract.miniCrmRows[1]!.collectionRaw).toBe("");
    expect(extract.miniCrmRows[1]!.additionalItems).toBe("");
  });
});

describe("readWorkbook on the rows the primary fixture cannot express", () => {
  it("drops the month-divider rows instead of emitting an identity-less record", () => {
    // Four of these sit inside "Mini CRM" (sheet rows 5984, 6308, 6615, 6900):
    // a date typed into APPLICANTS NAME and nothing else, REF NO included. They
    // are the difference between actualRowCount 7,162 and the 7,157 real records,
    // and they must never reach the review queue.
    expect(edgeCaseExtract.miniCrmRows).toHaveLength(2);
    expect(edgeCaseExtract.miniCrmRows.map((row) => row.caseRef)).toEqual(["40001", "40002"]);
    expect(edgeCaseExtract.miniCrmRows.some((row) => row.sourceRow === 3)).toBe(false);
  });

  it("numbers a record by its real sheet row across a run of blank rows", () => {
    // Sheet rows 4-6 are absent and row 3 was dropped, so the second surviving
    // record is at sheet row 7. An implementation numbering by array index — or
    // by a counter that only advances on kept rows — reports 3 or 4 here.
    expect(edgeCaseExtract.miniCrmRows[1]!.sourceRow).toBe(7);
    expect(edgeCaseExtract.miniCrmRows[1]!.applicantsName).toBe("ARJUN RAO");
  });

  it("reads a hyperlink cell's text rather than stringifying the object", () => {
    expect(edgeCaseExtract.miniCrmRows[0]!.passportNumber).toBe("P9988776");
    expect(edgeCaseExtract.miniCrmRows[0]!.passportNumber).not.toContain("[object Object]");
    expect(edgeCaseExtract.yearRows[0]!.trackingNumber).toBe("DTDC7001");
  });

  it("renders a Date-typed DOB in UTC as well, not only Collection", () => {
    expect(edgeCaseExtract.miniCrmRows[0]!.dateOfBirthRaw).toBe("1990-05-17");
  });

  it("refuses a workbook with no Mini CRM sheet", async () => {
    const workbookPath = await writeWorkbookToTemporaryFile(await buildWorkbookWithoutMiniCrmSheet());
    await expect(readWorkbook(workbookPath)).rejects.toThrow(/Mini CRM/);
  });
});

describe("normaliseDateCell", () => {
  it("prefers the Date branch over the serial branch", () => {
    expect(normaliseDateCell(new Date(Date.UTC(2024, 11, 31)))).toBe("2024-12-31");
  });

  it("hands trimmed text straight through for the shared day-first parser", () => {
    expect(normaliseDateCell("  12/31/2024  ")).toBe("12/31/2024");
    expect(normaliseDateCell("aposttile")).toBe("aposttile");
  });

  it("keeps an implausible serial as text instead of inventing a 1899 date", () => {
    // excelSerialToIsoDate returns null outside 2020-2027; the raw value has to
    // survive so mapRow can queue it for review rather than store a wrong date.
    expect(normaliseDateCell(1)).toBe("1");
    expect(normaliseDateCell(60000)).toBe("60000");
  });

  it("reads .text from a rich object rather than stringifying it", () => {
    expect(normaliseDateCell({ text: "12/31/2024", hyperlink: "https://example.invalid" })).toBe(
      "12/31/2024",
    );
  });

  it("treats blank as not recorded, never as a review item", () => {
    expect(normaliseDateCell(null)).toBe("");
    expect(normaliseDateCell(undefined)).toBe("");
    expect(normaliseDateCell("")).toBe("");
    expect(normaliseDateCell("   ")).toBe("");
  });
});

describe("normaliseCellText", () => {
  it("renders a Date in UTC", () => {
    expect(normaliseCellText(new Date(Date.UTC(2025, 0, 1)))).toBe("2025-01-01");
  });

  it("renders a number without a float suffix or exponent", () => {
    expect(normaliseCellText(31376)).toBe("31376");
    expect(normaliseCellText(9812345670)).toBe("9812345670");
  });

  it("trims text and maps null and undefined to empty", () => {
    expect(normaliseCellText("  AKSHAY JAIN  ")).toBe("AKSHAY JAIN");
    expect(normaliseCellText(null)).toBe("");
    expect(normaliseCellText(undefined)).toBe("");
  });
});

describe("normaliseRefNo", () => {
  it("collapses every float spelling of a ref to the same string", () => {
    // Case identity is keyed on this string. If "31376" and "31376.0" differed,
    // the second import run would re-create every case.
    expect(normaliseRefNo(31376)).toBe("31376");
    expect(normaliseRefNo(31376.0)).toBe("31376");
    expect(normaliseRefNo("31376.0")).toBe("31376");
    expect(normaliseRefNo(" 31376 ")).toBe("31376");
  });

  it("keeps a non-numeric ref as written", () => {
    expect(normaliseRefNo("RGS-31376")).toBe("RGS-31376");
  });

  it("returns empty for a blank ref so the row can be dropped", () => {
    expect(normaliseRefNo(null)).toBe("");
    expect(normaliseRefNo("")).toBe("");
  });
});
