import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { APPLICANT_SORT_KEY_PREFIX, META_SORT_KEY, casePartitionKey, caseStatusGsi1Pk } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { stripStorageKeys } from "@rgs/api/src/lib/storedRecords";
import { crm } from "@rgs/shared";

/** The pre-rename status. Shared types no longer know it, so it is only ever handled as a raw string here. */
export const LEGACY_IN_PROGRESS_STATUS = "IN_PROGRESS";
export const RENAMED_STATUS: crm.CaseStatus = "DOCS_UNDER_REVIEW";

export interface CaseStatusRenameReport {
  scanned: number;
  renamed: number;
  unreadableCaseIds: string[];
}

/**
 * Rewrites every case stored as IN_PROGRESS to DOCS_UNDER_REVIEW. The old
 * status is found through its own GSI1 partition and the case is rewritten by
 * `writeCase`, so the META item's GSI1PK moves with it. `updatedAt` is kept
 * (a rename is not an edit). Idempotent: once renamed, the IN_PROGRESS
 * partition is empty and a re-run scans nothing.
 */
export async function backfillCaseStatusRename(
  context: AppContext,
  tenantId: string,
  options: { onProgress?: (scanned: number) => void } = {},
): Promise<CaseStatusRenameReport> {
  const report: CaseStatusRenameReport = { scanned: 0, renamed: 0, unreadableCaseIds: [] };
  const legacyMetaItems = await context.table.queryGsi("GSI1", caseStatusGsi1Pk(tenantId, LEGACY_IN_PROGRESS_STATUS));

  for (const legacyMetaItem of legacyMetaItems) {
    if (legacyMetaItem["SK"] !== META_SORT_KEY) continue;
    report.scanned += 1;
    options.onProgress?.(report.scanned);

    const caseId = legacyMetaItem["caseId"];
    if (typeof caseId !== "string" || caseId.length === 0) {
      report.unreadableCaseIds.push(legacyMetaItem.PK);
      continue;
    }
    // Re-read strongly consistent: a rename must not be built from a stale index row.
    const partitionKey = casePartitionKey(tenantId, caseId);
    const metaItem = await context.table.get(partitionKey, META_SORT_KEY, { consistentRead: true });
    if (metaItem === undefined || metaItem["caseStatus"] !== LEGACY_IN_PROGRESS_STATUS) continue;
    const applicantItems = await context.table.query(partitionKey, {
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
      consistentRead: true,
    });

    const parsed = crm.CrmCaseSchema.safeParse({
      ...stripStorageKeys(metaItem),
      caseStatus: RENAMED_STATUS,
      applicants: applicantItems.map(stripStorageKeys),
    });
    if (!parsed.success) {
      report.unreadableCaseIds.push(caseId);
      continue;
    }
    await writeCase(context, parsed.data);
    report.renamed += 1;
  }
  return report;
}
