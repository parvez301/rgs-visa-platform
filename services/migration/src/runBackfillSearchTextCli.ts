import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillLedgerSearchText, type BackfillReport } from "./backfillLedgerSearchText";

export interface BackfillCliDependencies {
  buildContext: () => AppContext;
  logLine: (message: string) => void;
  logError: (message: string) => void;
  logSummary: (summary: Record<string, unknown>) => void;
}

export interface BackfillCliResult {
  exitCode: number;
  report: BackfillReport;
}

export async function runBackfillSearchTextCli(
  dependencies: BackfillCliDependencies,
): Promise<BackfillCliResult> {
  const context = dependencies.buildContext();
  const report = await backfillLedgerSearchText(context, DEFAULT_TENANT_ID, {
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
  return { exitCode: 0, report };
}
