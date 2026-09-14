import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillApplicantSummary, type BackfillReport } from "./backfillApplicantSummary";

/**
 * The backfill CLI, as a function -- the same move `importCli.ts` makes for
 * the import CLI (finding N8): everything that decides anything lives here,
 * injected rather than reached for at module scope, so a test can call it
 * against an in-memory context without a real `buildProductionContext()` ever
 * running. `backfillCli.ts` is the bin shim left over: parse nothing, decide
 * nothing, just hand over the real dependencies and set an exit code.
 */
export interface BackfillCliDependencies {
  buildContext: () => AppContext;
  /** `console.log` in production. */
  logLine: (message: string) => void;
  /** `console.error` in production. */
  logError: (message: string) => void;
  /** `console.table` in production. */
  logSummary: (summary: Record<string, unknown>) => void;
}

export interface BackfillCliResult {
  /** Always 0: an unreadable case is a finding the report names, not a failure. */
  exitCode: number;
  report: BackfillReport;
}

export async function runBackfillCli(
  dependencies: BackfillCliDependencies,
): Promise<BackfillCliResult> {
  const context = dependencies.buildContext();
  const report = await backfillApplicantSummary(context, DEFAULT_TENANT_ID, {
    onProgress: (scanned) => {
      if (scanned % 250 === 0) dependencies.logLine(`...${scanned} cases scanned`);
    },
  });

  dependencies.logSummary({
    scanned: report.scanned,
    written: report.written,
    alreadyCurrent: report.alreadyCurrent,
    unreadable: report.unreadableCaseIds.length,
  });
  if (report.unreadableCaseIds.length > 0) {
    dependencies.logError(`Cases that could not be reassembled: ${report.unreadableCaseIds.join(", ")}`);
  }
  // Unreadable cases are a finding, not a failure: the run did everything it
  // could and said what it could not do.
  return { exitCode: 0, report };
}
