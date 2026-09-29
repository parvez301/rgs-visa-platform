import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillRefClaims, type RefClaimBackfillReport } from "./backfillRefClaims";

export interface RefClaimCliDependencies {
  buildContext: () => AppContext;
  logLine: (message: string) => void;
  logError: (message: string) => void;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runBackfillRefClaimsCli(
  dependencies: RefClaimCliDependencies,
): Promise<{ exitCode: number; report: RefClaimBackfillReport }> {
  const context = dependencies.buildContext();
  const report = await backfillRefClaims(context, DEFAULT_TENANT_ID, {
    onProgress: (scanned) => {
      if (scanned % 250 === 0) dependencies.logLine(`...${scanned} cases scanned`);
    },
  });
  dependencies.logSummary({
    scanned: report.scanned,
    claimed: report.claimed,
    alreadyClaimed: report.alreadyClaimed,
    duplicates: report.duplicates.length,
    unreadable: report.unreadableCaseIds.length,
  });
  for (const duplicate of report.duplicates) {
    dependencies.logError(`Duplicate: case ${duplicate.caseId} (REF ${duplicate.caseRef}) also uses "${duplicate.refValue}"`);
  }
  if (report.unreadableCaseIds.length > 0) {
    dependencies.logError(`Cases that could not be reassembled: ${report.unreadableCaseIds.join(", ")}`);
  }
  return { exitCode: 0, report };
}
