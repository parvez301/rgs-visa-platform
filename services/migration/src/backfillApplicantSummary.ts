import { crm } from "@rgs/shared";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";

export interface BackfillReport {
  scanned: number;
  written: number;
  alreadyCurrent: number;
  unreadableCaseIds: string[];
}

export interface BackfillOptions {
  /** Called once per case so a 7,156-row run is not silent. */
  onProgress?: (scanned: number) => void;
}

/**
 * Gives every already-stored case the `applicantSummary` that `writeCase` now
 * computes (Plan 5 Task 1). Re-runnable, and it never writes a summary it had
 * to invent.
 *
 * Round-tripping through readCase/writeCase rather than patching the attribute
 * directly: writeCase is the only thing that knows how to compute the summary,
 * and a second computation here would be a second place to get it wrong. The
 * round trip changes nothing else -- same fields, same `updatedAt`, and no CRM
 * event, because nothing about the case changed and 7,156 phantom edits in the
 * timeline would corrupt the audit surface the Case screen is built on.
 */
export async function backfillApplicantSummary(
  context: AppContext,
  tenantId: string,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const report: BackfillReport = { scanned: 0, written: 0, alreadyCurrent: 0, unreadableCaseIds: [] };

  for (const caseStatus of crm.CASE_STATUSES) {
    // The ref listing, not listCasesByStatus: that one reassembles every case
    // to hand back ids this loop is about to read anyway, and it drops the
    // corrupt cases this run most needs to name. `limit: undefined` drains the
    // partition -- a capped sweep would leave part of the ledger unbackfilled
    // with nothing saying so.
    const { storedCaseRefs, unreadableCaseIds } = await listCaseRefsByStatus(
      context,
      tenantId,
      caseStatus,
      undefined,
    );
    report.unreadableCaseIds.push(...unreadableCaseIds);

    for (const { caseId } of storedCaseRefs) {
      report.scanned += 1;
      options.onProgress?.(report.scanned);

      let loadedCase;
      try {
        loadedCase = await readCase(context, tenantId, caseId);
      } catch (error) {
        // A partition holding META with no applicant items. Named and left
        // exactly as it is: writing a count: 0 summary over it would tell the
        // Ledger this case has no applicants, which is a stronger and falser
        // claim than "not summarised".
        if (!(error instanceof CorruptRecordError)) throw error;
        report.unreadableCaseIds.push(caseId);
        continue;
      }
      if (loadedCase === undefined) {
        report.unreadableCaseIds.push(caseId);
        continue;
      }

      const storedMetaItem = await context.table.get(
        casePartitionKey(tenantId, caseId),
        META_SORT_KEY,
        { consistentRead: true },
      );
      const expectedSummary = crm.summariseApplicants(loadedCase.applicants);
      if (
        JSON.stringify(storedMetaItem?.["applicantSummary"] ?? null) ===
        JSON.stringify(expectedSummary)
      ) {
        report.alreadyCurrent += 1;
        continue;
      }

      await writeCase(context, loadedCase);
      report.written += 1;
    }
  }

  return report;
}
