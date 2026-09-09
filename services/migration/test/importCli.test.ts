import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
import type { AppContext } from "@rgs/api/src/lib/context";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { listCasesByStatus } from "@rgs/api/src/domain/crm/cases";
import type { RawMiniCrmRow, WorkbookExtract } from "../src/readWorkbook";
import {
  COMMIT_BANNER,
  DRY_RUN_ABORT_MESSAGE,
  DRY_RUN_BANNER,
  IMPORT_CLI_USAGE,
  runImportCli,
  type ImportCliDependencies,
} from "../src/importCli";

/**
 * N8: this file could not exist before. `cli.ts` did its work at module scope
 * — `parseArgs(process.argv)`, top-level `await`, `process.exit(1)`, a real
 * `buildProductionContext()` — so importing it ran a real import against a
 * real table. The one file carrying the operator-facing behaviour was the one
 * file in the service with no tests.
 */

function buildRawMiniCrmRow(overrides: Partial<RawMiniCrmRow> = {}): RawMiniCrmRow {
  return {
    sourceRow: 2,
    receivedDateRaw: "2025-01-02",
    caseRef: "31376",
    applicantsName: "AKSHAY JAIN",
    applicantCount: "1",
    partnerName: "VWI Mumbai",
    country: "TURKEY",
    dateOfBirthRaw: "",
    subDateRaw: "",
    collectionRaw: "",
    passportNumber: "V2404480",
    entries: "SINGLE",
    visaType: "BUSINESS",
    status: "DELIVERED",
    additionalItems: "",
    remarks: "",
    courierDateRaw: "",
    paymentStatus: "",
    trackingNumber: "",
    ...overrides,
  };
}

function buildWorkbookExtract(rowCount: number): WorkbookExtract {
  return {
    miniCrmRows: Array.from({ length: rowCount }, (_unused, rowIndex) =>
      buildRawMiniCrmRow({
        sourceRow: rowIndex + 2,
        caseRef: String(40_000 + rowIndex),
        passportNumber: `P${String(rowIndex).padStart(7, "0")}`,
      }),
    ),
    yearRows: [],
  };
}

interface RecordedCliOutput {
  lines: string[];
  errors: string[];
  summaries: Record<string, unknown>[];
}

function buildDependencies(
  overrides: Partial<ImportCliDependencies>,
): { dependencies: ImportCliDependencies; output: RecordedCliOutput } {
  const output: RecordedCliOutput = { lines: [], errors: [], summaries: [] };
  const dependencies: ImportCliDependencies = {
    buildContext: () => buildTestContext(),
    readWorkbookAt: async () => buildWorkbookExtract(1),
    logLine: (message) => output.lines.push(message),
    logError: (message) => output.errors.push(message),
    logSummary: (summary) => output.summaries.push(summary),
    ...overrides,
  };
  return { dependencies, output };
}

/**
 * A table that fails the test the moment anything writes through it, rather
 * than merely recording that something did. A dry run that writes has already
 * done the damage by the time an assertion at the end of the test could see
 * it; this stops at the write.
 */
function tableThatMustNotBeWrittenTo(table: TableClient): TableClient {
  return {
    get: (partitionKey, sortKey, options) => table.get(partitionKey, sortKey, options),
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    put: (item: TableItem) => {
      throw new Error(`a dry run wrote to the table: put ${item.PK} / ${item.SK}`);
    },
    delete: (partitionKey: string, sortKey: string) => {
      throw new Error(`a dry run wrote to the table: delete ${partitionKey} / ${sortKey}`);
    },
  };
}

function withTable(context: AppContext, table: TableClient): AppContext {
  return { ...context, table };
}

describe("runImportCli", () => {
  it("refuses to run without --workbook, printing the usage line and a non-zero exit code", async () => {
    const { dependencies, output } = buildDependencies({
      readWorkbookAt: async () => {
        throw new Error("the workbook must never be read when no --workbook was given");
      },
      buildContext: () => {
        throw new Error("no context should be built when no --workbook was given");
      },
    });

    const cliResult = await runImportCli(["--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(output.errors).toContain(IMPORT_CLI_USAGE);
    // The usage line has to name the `run` in "pnpm ... run import": without
    // it pnpm runs its OWN built-in `import` command instead of this script.
    expect(IMPORT_CLI_USAGE).toContain("run import");
    expect(output.summaries).toHaveLength(0);
  });

  it("treats an unknown flag as a usage error rather than a stack trace", async () => {
    const { dependencies, output } = buildDependencies({});

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--dryrun"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(output.errors).toContain(IMPORT_CLI_USAGE);
  });

  it("writes nothing without --commit, and says so before it starts", async () => {
    const context = buildTestContext();
    const readOnlyContext = withTable(context, tableThatMustNotBeWrittenTo(context.table));
    const { dependencies, output } = buildDependencies({
      buildContext: () => readOnlyContext,
      readWorkbookAt: async () => buildWorkbookExtract(3),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx"], dependencies);

    // If the dry run had written anything the injected table would have thrown
    // at that write, and this would be exit code 1 with an abort message.
    expect(cliResult.exitCode).toBe(0);
    expect(output.errors).toHaveLength(0);
    expect(output.lines).toContain(DRY_RUN_BANNER);
    // Still reports what it WOULD do: a dry run that reports nothing is not a
    // rehearsal.
    expect(cliResult.summary?.casesCreated).toBe(3);
  });

  it("writes with --commit, and the cases are really there afterwards", async () => {
    const context = buildTestContext();
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(3),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).toBe(0);
    expect(output.lines).toContain(COMMIT_BANNER);
    expect(cliResult.summary?.casesCreated).toBe(3);
    const storedCases = await listCasesByStatus(context, "rgs", "CLOSED", 100);
    expect(storedCases.cases).toHaveLength(3);
  });

  it("prints createdCaseIds as a count, never the array itself", async () => {
    const { dependencies, output } = buildDependencies({
      readWorkbookAt: async () => buildWorkbookExtract(4),
    });

    await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    const printedSummary = output.summaries[0];
    expect(printedSummary).toBeDefined();
    // On the real workbook this is a 7,156-element array, and console.table
    // renders an array into one unreadable cell -- the operator loses the
    // whole summary to it.
    expect(printedSummary!["createdCaseIds"]).toBe(4);
    expect(Array.isArray(printedSummary!["createdCaseIds"])).toBe(false);
    // The counts the operator actually reads are still on the printed object.
    expect(printedSummary!["casesCreated"]).toBe(4);
    expect(printedSummary!["rowsRead"]).toBe(4);
  });

  it("says nothing was written when a DRY run fails, whatever the cause", async () => {
    const { dependencies, output } = buildDependencies({
      readWorkbookAt: async () => {
        throw new Error("ENOENT: no such file or directory, open 'typo.xlsx'");
      },
    });

    const cliResult = await runImportCli(["--workbook", "typo.xlsx"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(output.errors).toContain(DRY_RUN_ABORT_MESSAGE);
  });

  it("passes --tenant and --actor through instead of hard-coding them", async () => {
    const context = buildTestContext();
    const { dependencies } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(1),
    });

    await runImportCli(
      ["--workbook", "book.xlsx", "--commit", "--tenant", "other-tenant", "--actor", "ops@rgs.test"],
      dependencies,
    );

    const otherTenantCases = await listCasesByStatus(context, "other-tenant", "CLOSED", 100);
    expect(otherTenantCases.cases).toHaveLength(1);
    const defaultTenantCases = await listCasesByStatus(context, "rgs", "CLOSED", 100);
    expect(defaultTenantCases.cases).toHaveLength(0);
  });
});
