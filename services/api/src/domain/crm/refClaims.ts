import type { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict } from "../../lib/errors";
import { stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, refClaimPartitionKey } from "./keys";
import { crmPostgresOf } from "./postgresClient";
import { deleteRefClaimPostgres, insertRefClaimIfAbsentPostgres, readRefClaimPostgres } from "./refClaimsPostgres";

/**
 * "REF must be unique" (owner, 2026-09-29), enforced by one claim item per
 * normalized reference value written with a conditional put. A case REF and
 * an applicant REF NO share one namespace; a REF NO may repeat its OWN case's
 * REF (a single-person case typed twice) but nothing else's.
 *
 * Diff-only by design: a write claims the keys the new version adds and
 * releases the keys it dropped. Unchanged values are never re-claimed, so a
 * legacy duplicate (staging's second 38017) can still have its remarks
 * edited -- it only meets the 409 when someone sets a REF another case holds.
 */
export interface RefClaim {
  tenantId: string;
  refKey: string;
  /** The value as it was typed, for the error message and the audit. */
  refValue: string;
  caseId: string;
  claimedAt: string;
}

type RefBearingCase = Pick<crm.CrmCase, "caseRef" | "applicants">;

export function normalizeRefKey(refValue: string): string {
  return refValue.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Normalized key -> the value as typed. The case REF first, then REF NOs in applicant order. */
export function refKeysOfCase(crmCase: RefBearingCase): Map<string, string> {
  const refValuesByKey = new Map<string, string>();
  const typedValues = [crmCase.caseRef, ...crmCase.applicants.map((applicant) => applicant.refNo)];
  for (const typedValue of typedValues) {
    if (typedValue === undefined || typedValue.trim() === "") continue;
    const refKey = normalizeRefKey(typedValue);
    if (!refValuesByKey.has(refKey)) refValuesByKey.set(refKey, typedValue);
  }
  return refValuesByKey;
}

export function assertApplicantRefNosDistinct(crmCase: Pick<crm.CrmCase, "applicants">): void {
  const seenRefKeys = new Set<string>();
  for (const applicant of crmCase.applicants) {
    if (applicant.refNo === undefined) continue;
    const refKey = normalizeRefKey(applicant.refNo);
    if (seenRefKeys.has(refKey)) {
      throw badRequest(`REF NO "${applicant.refNo}" is used twice on this case.`);
    }
    seenRefKeys.add(refKey);
  }
}

export async function readRefClaim(
  context: AppContext,
  tenantId: string,
  refKey: string,
): Promise<RefClaim | undefined> {
  const sql = crmPostgresOf(context);
  if (sql !== undefined) return readRefClaimPostgres(sql, tenantId, refKey);
  // Consistent: a claim written a moment ago by the losing side of a race
  // must be visible to the reader deciding whether it is ours.
  const storedItem = await context.table.get(refClaimPartitionKey(tenantId, refKey), META_SORT_KEY, {
    consistentRead: true,
  });
  return storedItem === undefined ? undefined : (stripStorageKeys(storedItem) as unknown as RefClaim);
}

/**
 * A claim can be released between our losing putIfAbsent and our read of the
 * winner. Reading "nobody" then means the key is free again, not that another
 * case holds it, so we try the put again. Bounded so a key flapping under
 * contention cannot spin forever.
 */
const MAX_CLAIM_ATTEMPTS = 3;

type ClaimOutcome = "written" | "already_ours" | "held_by_other_case";

async function claimRefKey(
  context: AppContext,
  tenantId: string,
  caseId: string,
  refKey: string,
  refValue: string,
): Promise<ClaimOutcome> {
  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const refClaim: RefClaim = { tenantId, refKey, refValue, caseId, claimedAt: context.now().toISOString() };
    const sql = crmPostgresOf(context);
    const wasWritten =
      sql !== undefined
        ? await insertRefClaimIfAbsentPostgres(sql, refClaim)
        : await context.table.putIfAbsent({
            PK: refClaimPartitionKey(tenantId, refKey),
            SK: META_SORT_KEY,
            ...refClaim,
          });
    if (wasWritten) return "written";
    const existingClaim = await readRefClaim(context, tenantId, refKey);
    if (existingClaim === undefined) continue;
    return existingClaim.caseId === caseId ? "already_ours" : "held_by_other_case";
  }
  return "held_by_other_case";
}

export async function claimNewRefs(
  context: AppContext,
  tenantId: string,
  caseId: string,
  previousCase: RefBearingCase | undefined,
  nextCase: RefBearingCase,
): Promise<string[]> {
  const previousRefKeys = previousCase === undefined ? new Set<string>() : new Set(refKeysOfCase(previousCase).keys());
  const newlyClaimedKeys: string[] = [];
  for (const [refKey, refValue] of refKeysOfCase(nextCase)) {
    if (previousRefKeys.has(refKey)) continue;
    const claimOutcome = await claimRefKey(context, tenantId, caseId, refKey, refValue);
    if (claimOutcome !== "held_by_other_case") {
      // "already_ours" is reported too: keys the previous version held were
      // skipped above, so a claim of ours that reaches here is a putIfAbsent
      // that landed but whose response was lost (or an orphan of this case).
      // Rollback must be able to release it, or a failed writeCase leaves the
      // REF claimed forever.
      newlyClaimedKeys.push(refKey);
      continue;
    }
    await releaseRefKeys(context, tenantId, caseId, newlyClaimedKeys);
    throw conflict(`REF "${refValue}" is already used by another case.`);
  }
  return newlyClaimedKeys;
}

export async function releaseRefKeys(
  context: AppContext,
  tenantId: string,
  caseId: string,
  refKeys: Iterable<string>,
): Promise<void> {
  for (const refKey of refKeys) {
    const existingClaim = await readRefClaim(context, tenantId, refKey);
    if (existingClaim?.caseId !== caseId) continue;
    const sql = crmPostgresOf(context);
    if (sql !== undefined) {
      // Guarded on the owner again: between the read and the delete the claim
      // could have been released and re-taken by another case.
      await deleteRefClaimPostgres(sql, tenantId, refKey, caseId);
      continue;
    }
    await context.table.delete(refClaimPartitionKey(tenantId, refKey), META_SORT_KEY);
  }
}

export function staleRefKeys(previousCase: RefBearingCase, nextCase: RefBearingCase): string[] {
  const nextRefKeys = new Set(refKeysOfCase(nextCase).keys());
  return [...refKeysOfCase(previousCase).keys()].filter((refKey) => !nextRefKeys.has(refKey));
}
