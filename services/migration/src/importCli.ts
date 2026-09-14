import { parseArgs } from "node:util";
import type { AppContext } from "@rgs/api/src/lib/context";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import type { WorkbookExtract } from "./readWorkbook";
import { mapRow } from "./mapRow";
import { joinPhones } from "./joinPhones";
import { proposeGroups } from "./groupCases";
import { passthroughResidueResolver } from "./residueResolver";
import { runImport, type ImportSummary } from "./importRun";

/**
 * The import CLI, as a function.
 *
 * Finding N8: this logic used to live at the top level of `cli.ts` — module
 * scope, `parseArgs(process.argv)`, top-level `await`, `process.exit(1)`, and
 * `buildProductionContext()` wired in by a static import. Every one of those
 * is an import-time side effect, so a test could not `import` the file at all
 * without running a real import against a real table, which is why the file
 * with the operator-facing behaviour on it was the one file in the service
 * with no tests. It stayed that way through two review rounds, and NEW-4 (the
 * abort message lying about whether anything was written) is exactly the kind
 * of defect that survives in an untestable file.
 *
 * Nothing here reads `process`, and importing this module does nothing at all.
 * `cli.ts` is now a bin shim: parse nothing, decide nothing, just hand over
 * `process.argv` and the real dependencies and set an exit code.
 */
export interface ImportCliDependencies {
  /**
   * Injected, and called INSIDE the run, because building the production
   * context is the step most likely to fail on a misconfigured machine and
   * the abort path has to describe that failure correctly (NEW-4).
   */
  buildContext: () => AppContext;
  readWorkbookAt: (workbookPath: string) => Promise<WorkbookExtract>;
  /** `console.log` in production. */
  logLine: (message: string) => void;
  /** `console.error` in production. */
  logError: (message: string) => void;
  /** `console.table` in production. */
  logSummary: (summary: Record<string, unknown>) => void;
}

export interface ImportCliResult {
  /** 0 on success. Non-zero on a usage error or an aborted run. */
  exitCode: number;
  /** Present only on a completed run. */
  summary?: ImportSummary;
  /** Present only on an aborted run, so a caller can rethrow or inspect it. */
  abortReason?: unknown;
}

/**
 * "run" is required: "pnpm --filter @rgs/migration import" (no "run") hits
 * pnpm's own built-in `import` command instead of this package.json script.
 */
export const IMPORT_CLI_USAGE =
  "usage: pnpm --filter @rgs/migration run import --workbook <path.xlsx> [--commit]";

export const DRY_RUN_BANNER = "DRY RUN — nothing will be written. Pass --commit to write.";
export const COMMIT_BANNER = "COMMITTING to the table.";

/**
 * The three things an abort can mean, kept apart because the operator's next
 * action is different for each one.
 *
 * Finding NEW-4: there used to be two, chosen by `dryRun` alone, so every
 * failure of a `--commit` run announced "some cases are already written" —
 * including the failures that happen before the first write. Building the
 * production context throws on a missing table name or missing credentials,
 * and `buildProductionContext()` was evaluated as an argument INSIDE the try,
 * so the single most likely failure on a fresh machine printed a paragraph
 * about partially written data at an operator whose table was untouched. So
 * did a bad path, and a workbook that would not parse.
 *
 * The message is now decided by whether a write was actually attempted, which
 * is observed rather than inferred — see `tableRecordingWrites`.
 */
export const DRY_RUN_ABORT_MESSAGE = "DRY RUN FAILED — nothing was written.";
export const NO_WRITES_ABORT_MESSAGE =
  "IMPORT FAILED BEFORE IT WROTE ANYTHING — the table was not touched. Fix the cause and re-run the same command.";
export const PARTIAL_WRITE_ABORT_MESSAGE =
  "IMPORT ABORTED PART-WAY — some cases are already written. Re-running the same command is safe: each REF NO. is reserved before its case, so an already-imported ref is skipped and a half-written one is repaired under its original case id.";

/** Mutable because the abort path reads it after the run has thrown. */
interface WriteObservation {
  anyWriteAttempted: boolean;
}

/**
 * Wraps a table client so the CLI can say, truthfully, whether this run had
 * begun writing when it died.
 *
 * The flag is set BEFORE the underlying call, not after it: a `put` that
 * throws a timeout may well have landed, and "we tried and do not know" has
 * to count as written or the abort message understates the damage in the one
 * case where understating it is dangerous.
 */
function tableRecordingWrites(table: TableClient, observation: WriteObservation): TableClient {
  return {
    get: (partitionKey, sortKey, options) => table.get(partitionKey, sortKey, options),
    query: (partitionKey, options) => table.query(partitionKey, options),
    queryGsi: (indexName, partitionKey, options) => table.queryGsi(indexName, partitionKey, options),
    queryGsiPage: (indexName, partitionKey, options) => table.queryGsiPage(indexName, partitionKey, options),
    put: (item: TableItem) => {
      observation.anyWriteAttempted = true;
      return table.put(item);
    },
    delete: (partitionKey: string, sortKey: string) => {
      observation.anyWriteAttempted = true;
      return table.delete(partitionKey, sortKey);
    },
  };
}

function describeAbort(dryRun: boolean, anyWriteAttempted: boolean): string {
  if (dryRun) return DRY_RUN_ABORT_MESSAGE;
  return anyWriteAttempted ? PARTIAL_WRITE_ABORT_MESSAGE : NO_WRITES_ABORT_MESSAGE;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

export async function runImportCli(
  argv: readonly string[],
  dependencies: ImportCliDependencies,
): Promise<ImportCliResult> {
  let parsedValues: {
    workbook: string | undefined;
    tenant: string;
    actor: string;
    commit: boolean;
  };
  try {
    // `parseArgs` throws on an unknown flag, which used to reach the operator
    // as a stack trace. A usage error is a usage error however it is spelled.
    const { values } = parseArgs({
      args: [...argv],
      options: {
        workbook: { type: "string" },
        tenant: { type: "string", default: "rgs" },
        actor: { type: "string", default: "migration@rgs.local" },
        commit: { type: "boolean", default: false },
      },
    });
    parsedValues = {
      workbook: values.workbook,
      // `default` guarantees these, but the option types do not say so.
      tenant: values.tenant ?? "rgs",
      actor: values.actor ?? "migration@rgs.local",
      commit: values.commit ?? false,
    };
  } catch (error) {
    dependencies.logError(describeError(error));
    dependencies.logError(IMPORT_CLI_USAGE);
    return { exitCode: 1, abortReason: error };
  }

  if (parsedValues.workbook === undefined) {
    dependencies.logError(IMPORT_CLI_USAGE);
    return { exitCode: 1 };
  }

  // Writing is opt-in. A mistyped command must never touch a real table.
  const dryRun = !parsedValues.commit;
  dependencies.logLine(dryRun ? DRY_RUN_BANNER : COMMIT_BANNER);

  const writeObservation: WriteObservation = { anyWriteAttempted: false };
  try {
    const context = dependencies.buildContext();
    const observedContext: AppContext = {
      ...context,
      table: tableRecordingWrites(context.table, writeObservation),
    };
    const workbookExtract = await dependencies.readWorkbookAt(parsedValues.workbook);
    const mappedRows = workbookExtract.miniCrmRows.map(mapRow);

    const importSummary = await runImport(observedContext, parsedValues.tenant, {
      mappedRows,
      contactDetails: joinPhones(mappedRows, workbookExtract.yearRows),
      proposedGroups: proposeGroups(mappedRows),
      residueResolver: passthroughResidueResolver,
      actorEmail: parsedValues.actor,
      dryRun,
    });

    // createdCaseIds is a 7,156-element array on a real run, and console.table
    // renders an array into one unreadable cell. The operator needs the count;
    // the ids are for callers, not for a terminal.
    const { createdCaseIds, ...countedSummary } = importSummary;
    dependencies.logSummary({ ...countedSummary, createdCaseIds: createdCaseIds.length });
    return { exitCode: 0, summary: importSummary };
  } catch (error) {
    // An abort used to skip the summary entirely, so the operator got a stack
    // trace and no statement about what had already been written. Cases are
    // written one at a time and this is not transactional, so some of them
    // may be on file -- and the only safe next step needs saying out loud.
    dependencies.logError(describeAbort(dryRun, writeObservation.anyWriteAttempted));
    dependencies.logError(describeError(error));
    return { exitCode: 1, abortReason: error };
  }
}
