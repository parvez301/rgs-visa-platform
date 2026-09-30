import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillCaseStatusRename, type CaseStatusRenameReport } from "./backfillCaseStatusRename";

export interface CaseStatusRenameCliDependencies {
  buildContext: () => AppContext;
  logLine: (message: string) => void;
  logError: (message: string) => void;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runBackfillCaseStatusRenameCli(
  dependencies: CaseStatusRenameCliDependencies,
): Promise<{ exitCode: number; report: CaseStatusRenameReport }> {
  const context = dependencies.buildContext();
  const report = await backfillCaseStatusRename(context, DEFAULT_TENANT_ID, {
    onProgress: (scanned) => {
      if (scanned % 250 === 0) dependencies.logLine(`...${scanned} cases scanned`);
    },
  });
  dependencies.logSummary({
    scanned: report.scanned,
    renamed: report.renamed,
    unreadable: report.unreadableCaseIds.length,
  });
  if (report.unreadableCaseIds.length > 0) {
    dependencies.logError(`Cases that could not be renamed: ${report.unreadableCaseIds.join(", ")}`);
  }
  return { exitCode: report.unreadableCaseIds.length > 0 ? 1 : 0, report };
}
