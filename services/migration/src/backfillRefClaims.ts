import { readCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { claimNewRefs, normalizeRefKey, readRefClaim, refKeysOfCase } from "@rgs/api/src/domain/crm/refClaims";
import { listReviewItems, recordReviewItem } from "@rgs/api/src/domain/crm/reviewQueue";
import { ApiError, CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";
import { crm } from "@rgs/shared";

export interface RefClaimBackfillReport {
  scanned: number;
  claimed: number;
  alreadyClaimed: number;
  duplicates: { caseId: string; caseRef: string; refValue: string }[];
  unreadableCaseIds: string[];
}

/** Review items need a provenance row; there is no workbook row for this one. */
const BACKFILL_SOURCE_SHEET = "ref-claims-backfill";

/**
 * Gives every case stored before uniqueness existed its ref claims. The first
 * case to be swept keeps a contested value; every later holder is reported
 * and gets ONE open DUPLICATE_REF review item (re-runs do not add more), so a
 * human renames it from the case page. No case is modified.
 */
export async function backfillRefClaims(
  context: AppContext,
  tenantId: string,
  options: { onProgress?: (scanned: number) => void } = {},
): Promise<RefClaimBackfillReport> {
  const report: RefClaimBackfillReport = { scanned: 0, claimed: 0, alreadyClaimed: 0, duplicates: [], unreadableCaseIds: [] };
  const openDuplicateKeys = await loadOpenDuplicateReviewKeys(context, tenantId);

  for (const caseStatus of crm.CASE_STATUSES) {
    const { storedCaseRefs, unreadableCaseIds } = await listCaseRefsByStatus(context, tenantId, caseStatus, undefined);
    report.unreadableCaseIds.push(...unreadableCaseIds);
    for (const { caseId } of storedCaseRefs) {
      report.scanned += 1;
      options.onProgress?.(report.scanned);
      let storedCase;
      try {
        storedCase = await readCase(context, tenantId, caseId);
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        report.unreadableCaseIds.push(caseId);
        continue;
      }
      if (storedCase === undefined) continue;

      // One value at a time, so a clash on the REF does not stop the REF NOs
      // behind it from being claimed.
      for (const [refKey, refValue] of refKeysOfCase(storedCase)) {
        const existingClaim = await readRefClaim(context, tenantId, refKey);
        if (existingClaim?.caseId === caseId) {
          report.alreadyClaimed += 1;
          continue;
        }
        try {
          await claimNewRefs(context, tenantId, caseId, undefined, { caseRef: refValue, applicants: [] });
          report.claimed += 1;
        } catch (error) {
          if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
          report.duplicates.push({ caseId, caseRef: storedCase.caseRef, refValue });
          const duplicateKey = `${storedCase.caseRef}|${normalizeRefKey(refValue)}`;
          if (openDuplicateKeys.has(duplicateKey)) continue;
          await recordReviewItem(context, tenantId, {
            reason: "DUPLICATE_REF",
            sourceSheet: BACKFILL_SOURCE_SHEET,
            sourceRow: report.scanned,
            caseRef: storedCase.caseRef,
            fieldName: "REF NO.",
            rawValue: refValue,
            detail: `"${refValue}" is also used by another case, which keeps it. Rename this case's REF or REF NO (case id ${caseId}).`,
          });
          openDuplicateKeys.add(duplicateKey);
        }
      }
    }
  }
  return report;
}

/**
 * Every OPEN backfill-raised duplicate item. `listReviewItems` has no cursor,
 * only a page size and a `hasMore` flag, so a truncated page is re-read with a
 * wider limit until the whole queue fits -- a truncated read here would let a
 * re-run raise a second item for a clash already on the queue.
 */
async function loadOpenDuplicateReviewKeys(context: AppContext, tenantId: string): Promise<Set<string>> {
  let pageLimit = 1_000;
  let listing = await listReviewItems(context, tenantId, "OPEN", pageLimit);
  while (listing.hasMore) {
    pageLimit *= 4;
    listing = await listReviewItems(context, tenantId, "OPEN", pageLimit);
  }
  const openDuplicateKeys = new Set<string>();
  for (const reviewItem of listing.reviewItems) {
    if (reviewItem.reason !== "DUPLICATE_REF" || reviewItem.sourceSheet !== BACKFILL_SOURCE_SHEET) continue;
    openDuplicateKeys.add(`${reviewItem.caseRef}|${normalizeRefKey(reviewItem.rawValue)}`);
  }
  return openDuplicateKeys;
}
