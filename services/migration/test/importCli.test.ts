import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
import type { AppContext } from "@rgs/api/src/lib/context";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { listCasesByStatus } from "@rgs/api/src/domain/crm/cases";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import { withWriteRetries } from "@rgs/api/src/lib/tableRetry";
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

/** Lets the first `allowedWriteCount` writes through, then times out. */
function tableFailingAfterWrites(table: TableClient, allowedWriteCount: number): TableClient {
  let writesSoFar = 0;
  return {
    get: (partitionKey, sortKey, options) => table.get(partitionKey, sortKey, options),
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    put: async (item: TableItem) => {
      writesSoFar += 1;
      if (writesSoFar > allowedWriteCount) throw new Error("simulated write timeout");
      await table.put(item);
    },
    delete: (partitionKey: string, sortKey: string) => table.delete(partitionKey, sortKey),
  };
}

function withTable(context: AppContext, table: TableClient): AppContext {
  return { ...context, table };
}

/** What DynamoDB throws when a burst outruns the table's capacity. */
function buildThrottlingError(): Error {
  const throttlingError = new Error("Throughput exceeds the current capacity of your table");
  throttlingError.name = "ProvisionedThroughputExceededException";
  return throttlingError;
}

/**
 * Lets `allowedWriteCount` writes through, then throttles every write after
 * it. `allowedWriteCount: 0` is "throttled from the first byte".
 */
function tableThrottlingAfterWrites(table: TableClient, allowedWriteCount: number): TableClient {
  let writesSoFar = 0;
  return {
    get: (partitionKey, sortKey, options) => table.get(partitionKey, sortKey, options),
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    put: async (item: TableItem) => {
      writesSoFar += 1;
      if (writesSoFar > allowedWriteCount) throw buildThrottlingError();
      await table.put(item);
    },
    delete: (partitionKey: string, sortKey: string) => table.delete(partitionKey, sortKey),
  };
}

/** Throttles the first `failureCount` write ATTEMPTS, then behaves. */
function tableThrottlingFirstWrites(
  table: TableClient,
  failureCount: number,
  attemptLog: { putAttempts: number },
): TableClient {
  return {
    get: (partitionKey, sortKey, options) => table.get(partitionKey, sortKey, options),
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    put: async (item: TableItem) => {
      attemptLog.putAttempts += 1;
      if (attemptLog.putAttempts <= failureCount) throw buildThrottlingError();
      await table.put(item);
    },
    delete: (partitionKey: string, sortKey: string) => table.delete(partitionKey, sortKey),
  };
}

/** The production wrapper, with the sleep injected so tests do not wait. */
function withInstantWriteRetries(table: TableClient, maxAttempts: number): TableClient {
  return withWriteRetries(table, {
    maxAttempts,
    initialDelayMs: 1,
    maxDelayMs: 4,
    sleep: async () => undefined,
    random: () => 1,
    onRetry: () => undefined,
  });
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

  // --- NEW-4: what the abort message is allowed to claim -------------------

  it("does not claim cases were written when the context could not even be built", async () => {
    const configurationFailure = new Error("RGS_TABLE_NAME is not set");
    const { dependencies, output } = buildDependencies({
      buildContext: () => {
        throw configurationFailure;
      },
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(cliResult.exitCode).not.toBe(0);
    expect(cliResult.abortReason).toBe(configurationFailure);
    // The defect: `buildProductionContext()` was evaluated as an argument
    // INSIDE the try, so a missing table name -- the likeliest failure on a
    // fresh machine, before a single byte is written -- printed a paragraph
    // about partially written data and a "re-running is safe" reassurance
    // about a repair that had nothing to repair.
    expect(output.errors).not.toContain(PARTIAL_WRITE_ABORT_MESSAGE);
    expect(output.errors.join("\n")).not.toMatch(/already written/);
    expect(output.errors).toContain(NO_WRITES_ABORT_MESSAGE);
    // And the cause is still on screen; a correct message is not a substitute
    // for saying what went wrong.
    expect(output.errors.join("\n")).toMatch(/RGS_TABLE_NAME is not set/);
  });

  it("does not claim cases were written when the workbook itself could not be read", async () => {
    const { dependencies, output } = buildDependencies({
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
    const context = buildTestContext();
    // Ten rows, and the table stops accepting writes a few writes in -- the
    // real shape of a throttled or timed-out --commit at row N.
    const failingContext = withTable(context, tableFailingAfterWrites(context.table, 5));
    const { dependencies, output } = buildDependencies({
      buildContext: () => failingContext,
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
    const storedItems = await context.table.query("TENANT#rgs#CASE_REF#40000");
    expect(storedItems.length).toBeGreaterThan(0);
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

  // --- N11: throttling, backoff, and what an exhausted cap leaves behind ---

  it("finishes the import when the table throttles a few writes and then recovers", async () => {
    const context = buildTestContext();
    const attemptLog = { putAttempts: 0 };
    const throttledContext = withTable(
      context,
      withInstantWriteRetries(tableThrottlingFirstWrites(context.table, 4, attemptLog), 5),
    );
    const { dependencies } = buildDependencies({
      buildContext: () => throttledContext,
      readWorkbookAt: async () => buildWorkbookExtract(3),
    });

    const cliResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    // Unhandled, those four throttles would have aborted a 7,156-row import at
    // whichever row was in flight -- on a transient condition a short sleep
    // absorbs.
    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.summary?.casesCreated).toBe(3);
    expect(attemptLog.putAttempts).toBeGreaterThan(4);
    const storedCases = await listCasesByStatus(context, "rgs", "CLOSED", 100);
    expect(storedCases.cases).toHaveLength(3);
  });

  it("gives up when throttling never lets up, and the next run repairs what it left", async () => {
    const context = buildTestContext();
    // Ten rows; the table accepts a handful of writes and then throttles
    // permanently, so the retries exhaust their cap mid-import.
    const throttledContext = withTable(
      context,
      withInstantWriteRetries(tableThrottlingAfterWrites(context.table, 12), 3),
    );
    const { dependencies, output } = buildDependencies({
      buildContext: () => throttledContext,
      readWorkbookAt: async () => buildWorkbookExtract(10),
    });

    const abortedResult = await runImportCli(["--workbook", "book.xlsx", "--commit"], dependencies);

    expect(abortedResult.exitCode).not.toBe(0);
    // Accurate, per NEW-4: writes really did happen this time.
    expect(output.errors).toContain(PARTIAL_WRITE_ABORT_MESSAGE);
    // And the operator can see WHY, which is the difference between "raise the
    // table's capacity" and "no idea".
    expect(output.errors.join("\n")).toMatch(/ProvisionedThroughputExceededException/);

    // The state it left is one the next run repairs -- which is precisely what
    // the abort message promises. No checkpoint file, no --resume flag: the
    // caseRef reservations already are the checkpoint, so resuming is running
    // the same command again.
    const { dependencies: healthyDependencies } = buildDependencies({
      buildContext: () => context,
      readWorkbookAt: async () => buildWorkbookExtract(10),
    });
    const resumedResult = await runImportCli(
      ["--workbook", "book.xlsx", "--commit"],
      healthyDependencies,
    );

    expect(resumedResult.exitCode).toBe(0);

    const storedCases = await listCasesByStatus(context, "rgs", "CLOSED", 100);
    // Nine of the ten come back whole, one case per ref: a resumed run
    // repairs or skips, and never duplicates.
    expect(storedCases.cases).toHaveLength(9);
    expect(new Set(storedCases.cases.map((storedCase) => storedCase.caseRef)).size).toBe(9);

    // The tenth is the case the throttle interrupted mid-write, and the
    // resumed run deliberately does NOT re-create it: C1's ruling is that a
    // second case under one REF NO. is worse than a missing one, so a
    // half-written case is NAMED for a human rather than silently replaced.
    // "The next run repairs it" is therefore exact about the two states the
    // reservation distinguishes -- completed refs are skipped, reserved-but-
    // never-written refs are re-written under their original caseId -- and
    // deliberately not about this third one, which is a refusal, not a gap.
    expect(storedCases.unreadableCaseIds).toHaveLength(1);
    expect(resumedResult.summary?.casesSkippedUnreadable).toBe(1);
    const openQueue = await listReviewItems(context, "rgs", "OPEN", 1_000);
    const namedForRepair = openQueue.reviewItems.filter(
      (reviewItem) => reviewItem.reason === "UNREADABLE_STORED_CASE",
    );
    expect(namedForRepair).toHaveLength(1);
    expect(namedForRepair[0]!.detail).toMatch(/NOT imported/);

    // Every row is accounted for exactly once, in one of the three buckets.
    const resumedSummary = resumedResult.summary!;
    expect(
      resumedSummary.casesCreated +
        resumedSummary.casesSkippedAlreadyImported +
        resumedSummary.casesSkippedUnreadable,
    ).toBe(10);
    // And the checkpoint really was consulted: some refs were skipped because
    // a completed reservation said they were already done.
    expect(resumedSummary.casesSkippedAlreadyImported).toBeGreaterThan(0);
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
