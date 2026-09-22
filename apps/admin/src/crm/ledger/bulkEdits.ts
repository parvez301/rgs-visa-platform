/**
 * Sequential single-case edits over a Ledger selection. No bulk backend
 * route: each case keeps its own audit trail, and a partial failure is a
 * real state the caller must surface per item.
 */

export type BulkLedgerAxis = "caseStatus" | "billingStatus";

export interface BulkEditResult {
  caseId: string;
  ok: boolean;
  errorMessage?: string;
}

export const BULK_SELECTION_WARN_THRESHOLD = 50;

export async function applyBulkLedgerEdits(options: {
  caseIds: readonly string[];
  column: BulkLedgerAxis;
  nextValue: string;
  performEdit: (caseId: string, column: BulkLedgerAxis, nextValue: string) => Promise<void>;
}): Promise<BulkEditResult[]> {
  const results: BulkEditResult[] = [];
  for (const caseId of options.caseIds) {
    try {
      await options.performEdit(caseId, options.column, options.nextValue);
      results.push({ caseId, ok: true });
    } catch (error) {
      results.push({
        caseId,
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function summariseBulkEditResults(results: readonly BulkEditResult[]): {
  appliedCount: number;
  failedCount: number;
  failedCaseIds: string[];
} {
  const failed = results.filter((result) => !result.ok);
  return {
    appliedCount: results.length - failed.length,
    failedCount: failed.length,
    failedCaseIds: failed.map((result) => result.caseId),
  };
}
