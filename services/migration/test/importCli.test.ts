import { afterEach, describe, expect, it } from "vitest";
import {
  buildTestContext,
  closeTestContexts,
  contextRefusingWrites,
  interceptSql,
  type TestContext,
} from "@rgs/api/test/helpers";
import { listCasesByStatus } from "@rgs/api/src/domain/crm/cases";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import type { RawMiniCrmRow, WorkbookExtract } from "../src/readWorkbook";
import {
  COMMIT_BANNER,
  DRY_RUN_ABORT_MESSAGE,
  DRY_RUN_BANNER,
  IMPORT_CLI_USAGE,
  NO_WRITES_ABORT_MESSAGE,
  PARTIAL_WRITE_ABORT_MESSAGE,
  runImportCli,
  type ImportCliDependencies,
} from "../src/importCli";

/**
 * N8: this file could not exist before. `cli.ts` did its work at module scope
 * — `parseArgs(process.argv)`, top-level `await`, `process.exit(1)`, a real
 * `buildProductionContext()` — so importing it ran a real import against a
 * real table. The one file carrying the operator-facing behaviour was the one
 * file in the service with no tests, which is how NEW-4 survived two rounds.
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
    buildContext: () => {
      throw new Error("this test supplied no context");
    },
    readWorkbookAt: async () => buildWorkbookExtract(1),
    logLine: (message) => output.lines.push(message),
    logError: (message) => output.errors.push(message),
    logSummary: (summary) => output.summaries.push(summary),
    ...overrides,
  };
  return { dependencies, output };
}

/** Statements that change data (same shape the API test helpers treat as a write). */
const WRITE_STATEMENT = /\b(?:insert\s+into|delete\s+from|update\s+[a-z_]+\s+set|truncate)\b/i;

/**
 * Lets the first `allowedWriteCount` write statements through, then fails every
 * write after it, the way a dropped connection or timeout would. Reads still
 * work. Returns a function that restores the healthy client.
 */
function failWritesAfter(context: TestContext, allowedWriteCount: number): () => void {
  const healthyClient = context.sql;
  let writesSoFar = 0;
  interceptSql(context, async ({ text }, run) => {
    if (WRITE_STATEMENT.test(text)) {
      writesSoFar += 1;
      if (writesSoFar > allowedWriteCount) throw new Error("simulated write timeout");
    }
    return run();
  });
  return () => {
    context.sql = healthyClient;
  };
}

afterEach(closeTestContexts);

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
    const context = await buildTestContext();
    const readOnlyContext = contextRefusingWrites(context, "importCli dry run");
    const { dependencies, output } = buildDependencies({
      buildContext: () => readOnlyContext,
      readWorkbookAt: async () => buildWorkbookExtract(3),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx"], dependencies);

    // If the dry run had written anything the injected client would have thrown
    // at that write, and this would be exit code 1 with an abort message.
    expect(cliResult.exitCode).toBe(0);
    expect(output.errors).toHaveLength(0);
    expect(output.lines).toContain(DRY_RUN_BANNER);
    // Still reports what it WOULD do: a dry run that reports nothing is not a
    // rehearsal.
    expect(cliResult.summary?.casesCreated).toBe(3);
  });

  it("writes with --commit, and the cases are really there afterwards", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
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

  // --- NEW-4: what the abort message is allowed to claim -------------------

  it("does not claim cases were written when the context could not even be built", async () => {
    const configurationFailure = new Error("DATABASE_URL is not configured");
    const { dependencies, output } = buildDependencies({
      buildContext: () => {
        throw configurationFailure;
      },
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(cliResult.abortReason).toBe(configurationFailure);
    // The defect: `buildProductionContext()` was evaluated as an argument
    // INSIDE the try, so a missing database URL -- the likeliest failure on a
    // fresh machine, before a single byte is written -- printed a paragraph
    // about partially written data and a "re-running is safe" reassurance
    // about a repair that had nothing to repair.
    expect(output.errors).not.toContain(PARTIAL_WRITE_ABORT_MESSAGE);
    expect(output.errors.join("\n")).not.toMatch(/already written/);
    expect(output.errors).toContain(NO_WRITES_ABORT_MESSAGE);
    // And the cause is still on screen; a correct message is not a substitute
    // for saying what went wrong.
    expect(output.errors.join("\n")).toMatch(/DATABASE_URL is not configured/);
  });

  it("does not claim cases were written when the workbook itself could not be read", async () => {
    const context = await buildTestContext();
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => {
        throw new Error("ENOENT: no such file or directory, open 'typo.xlsx'");
      },
    });

    const cliResult = await runImportCli(["--workbook", "typo.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(output.errors).toContain(NO_WRITES_ABORT_MESSAGE);
    expect(output.errors.join("\n")).not.toMatch(/already written/);
  });

  it("DOES claim cases were written when the run died after writing some", async () => {
    const context = await buildTestContext();
    // Ten rows, and the database stops accepting writes a few writes in -- the
    // real shape of a timed-out --commit at row N.
    const healthyClient = context.sql;
    failWritesAfter(context, 5);
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(10),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    // The other half of NEW-4, and the reason the fix is not "delete the
    // scary message": when writes really have happened, the operator must be
    // told, and told that re-running repairs rather than duplicates.
    expect(output.errors).toContain(PARTIAL_WRITE_ABORT_MESSAGE);
    expect(output.errors).not.toContain(NO_WRITES_ABORT_MESSAGE);
    // Something really did land.
    const stored = await healthyClient.query("SELECT count(*)::int AS total FROM crm_case_ref_reservations");
    expect(Number(stored.rows[0]?.["total"])).toBeGreaterThan(0);
  });

  it("DOES claim a case may have been written when the very first put times out", async () => {
    const context = await buildTestContext();
    // allowedWriteCount 0: the FIRST write throws, before any write has ever
    // succeeded. The existing "died after writing some" test above lets five
    // writes land first, so `anyWriteAttempted` is already true no matter
    // which side of the call the flag is set on -- it cannot tell "before"
    // from "after" apart. This one can: only "before" observes a write that
    // never got a chance to complete.
    failWritesAfter(context, 0);
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(1),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    // The timed-out put may well have landed on the table before the timeout
    // was raised locally, so "we tried and do not know" must count as
    // written -- the understating message here would be the dangerous lie.
    expect(output.errors).toContain(PARTIAL_WRITE_ABORT_MESSAGE);
    expect(output.errors).not.toContain(NO_WRITES_ABORT_MESSAGE);
  });

  it("says nothing was written when a DRY run fails, whatever the cause", async () => {
    const context = await buildTestContext();
    const { dependencies, output } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => {
        throw new Error("ENOENT: no such file or directory, open 'typo.xlsx'");
      },
    });

    const cliResult = await runImportCli(["--workbook", "typo.xlsx"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(output.errors).toContain(DRY_RUN_ABORT_MESSAGE);
  });

  it("re-running after an aborted --commit finishes the import without duplicating a ref", async () => {
    const context = await buildTestContext();
    const restoreHealthyClient = failWritesAfter(context, 12);
    const { dependencies } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(10),
    });

    const abortedResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);
    expect(abortedResult.exitCode).not.toBe(0);

    // No checkpoint file, no --resume flag: the caseRef reservations already
    // are the checkpoint, so resuming is running the same command again.
    restoreHealthyClient();
    const resumedResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);
    expect(resumedResult.exitCode).toBe(0);

    const storedCases = await listCasesByStatus(context, "rgs", "CLOSED", 100);
    const refs = storedCases.cases.map((storedCase) => storedCase.caseRef);
    expect(new Set(refs).size).toBe(refs.length);
    const resumedSummary = resumedResult.summary!;
    // Every row is accounted for exactly once, in one of the three buckets.
    expect(
      resumedSummary.casesCreated +
        resumedSummary.casesSkippedAlreadyImported +
        resumedSummary.casesSkippedUnreadable,
    ).toBe(10);
    expect(resumedSummary.casesSkippedAlreadyImported).toBeGreaterThan(0);
    expect(storedCases.cases.length + storedCases.unreadableCaseIds.length).toBe(10);
    const openQueue = await listReviewItems(context, "rgs", "OPEN", 1_000);
    expect(
      openQueue.reviewItems.filter((reviewItem) => reviewItem.reason === "UNREADABLE_STORED_CASE"),
    ).toHaveLength(storedCases.unreadableCaseIds.length);
  });

  it("passes --tenant and --actor through instead of hard-coding them", async () => {
    const context = await buildTestContext();
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
