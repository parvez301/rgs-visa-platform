import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { resolveLedgerSearchText } from "@rgs/api/src/domain/crm/ledgerSearchText";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";
import { crm } from "@rgs/shared";

export interface BackfillReport {
  scanned: number;
  written: number;
  alreadyCurrent: number;
  unreadableCaseIds: string[];
}

export interface BackfillOptions {
  /** Called once per case so a large run is not silent. */
  onProgress?: (scanned: number) => void;
}

/**
 * Gives every already-stored case the `searchText` haystack `writeCase` now
 * stamps (applicant names + passports). Re-runnable: a case whose stored
 * `searchText` already matches what `resolveLedgerSearchText` would produce
 * is left alone.
 *
 * Round-trips through readCase/writeCase so the stamp has one author. No CRM
 * event: nothing about the case changed for a human reading the timeline.
 */
export async function backfillLedgerSearchText(
  context: AppContext,
  tenantId: string,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const report: BackfillReport = { scanned: 0, written: 0, alreadyCurrent: 0, unreadableCaseIds: [] };

  for (const caseStatus of crm.CASE_STATUSES) {
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
        if (!(error instanceof CorruptRecordError)) throw error;
        report.unreadableCaseIds.push(caseId);
        continue;
      }
      if (loadedCase === undefined) {
        throw new Error(
          `Internal invariant violated: case ${caseId} was listed by ` +
            `listCaseRefsByStatus but readCase found no META item moments ` +
            `later. Nothing in this codebase deletes a case META item, so ` +
            `something has changed that assumption -- stopping rather than ` +
            `writing against a state the sweep no longer understands.`,
        );
      }

      const storedMetaItem = await context.table.get(
        casePartitionKey(tenantId, caseId),
        META_SORT_KEY,
        { consistentRead: true },
      );
      const expectedSearchText = await resolveLedgerSearchText(
        context,
        tenantId,
        loadedCase.applicants,
      );
      const storedSearchText =
        typeof storedMetaItem?.["searchText"] === "string" ? storedMetaItem["searchText"] : undefined;
      if (storedSearchText === expectedSearchText) {
        report.alreadyCurrent += 1;
        continue;
      }

      await writeCase(context, loadedCase);
      report.written += 1;
    }
  }

  return report;
}
