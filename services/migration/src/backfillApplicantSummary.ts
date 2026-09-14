import { crm } from "@rgs/shared";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";

/**
 * Key-set-and-value equality for the two `Partial<Record<State, number>>`
 * maps `ApplicantSummary` carries (`custody`, `outcome`). Order-independent
 * by construction, which is the whole point: a hand-rolled `JSON.stringify`
 * comparison (the bug this replaces) agrees only when both sides serialise
 * their keys in the same order, and nothing guarantees the order DynamoDB
 * hands a Map attribute back in matches the order `summariseApplicants`
 * inserts them in while iterating applicants.
 */
function partialRecordsMatch<StateType extends string>(
  firstRecord: Partial<Record<StateType, number>>,
  secondRecord: Partial<Record<StateType, number>>,
): boolean {
  const firstKeys = Object.keys(firstRecord) as StateType[];
  const secondKeys = Object.keys(secondRecord) as StateType[];
  if (firstKeys.length !== secondKeys.length) return false;
  return firstKeys.every((stateName) => firstRecord[stateName] === secondRecord[stateName]);
}

/**
 * Whether a case's stored `applicantSummary` already IS the summary
 * `writeCase` would compute for it -- decided structurally, through
 * `ApplicantSummarySchema`, rather than by comparing two JSON strings.
 *
 * `JSON.stringify` serialises object keys in insertion order. The computed
 * side builds `custody`/`outcome` by iterating applicants in array order; the
 * stored side comes back through DynamoDB's own Map attribute, whose key
 * order across a PutItem/Query round trip is an empirical observation, not a
 * documented guarantee. If the two orders ever diverge, a string comparison
 * says "different" for two summaries that are the same summary, and rule 1
 * (re-runnable) dies silently: every case looks stale forever, and the
 * "backfill" becomes an unconditional 7,156-item rewrite on every run,
 * reporting clean success each time it does. `InMemoryTableClient` round-
 * trips through `structuredClone`, which preserves insertion order
 * deterministically -- so no test built only against the in-memory adapter
 * can ever observe this the way `JSON.stringify` would fail on it. Comparing
 * by key set and per-key value, instead, cannot be order-sensitive no matter
 * what either side's storage layer does to key order.
 *
 * Parsing through `ApplicantSummarySchema` rather than reading the stored
 * value's fields by hand also means a future field added to `ApplicantSummary`
 * reaches this comparison automatically -- the schema is the one place that
 * shape is defined, and a hand-written field list beside it is a second place
 * to forget to update.
 */
function applicantSummaryIsCurrent(
  storedValue: unknown,
  expectedSummary: crm.ApplicantSummary,
): boolean {
  const parsedStoredSummary = crm.ApplicantSummarySchema.safeParse(storedValue);
  // A summary that will not even parse is not current -- rewriting it is the
  // right answer for a malformed one, not silence.
  if (!parsedStoredSummary.success) return false;
  const storedSummary = parsedStoredSummary.data;
  return (
    storedSummary.count === expectedSummary.count &&
    partialRecordsMatch(storedSummary.custody, expectedSummary.custody) &&
    partialRecordsMatch(storedSummary.outcome, expectedSummary.outcome)
  );
}

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
        // Provably unreachable today, not merely unobserved: `readCase`
        // returns `undefined` only when the base-table META item is absent
        // under a strongly consistent `get` (caseStore.ts), and this `caseId`
        // came from `listCaseRefsByStatus` reading that very META item off
        // GSI1 moments earlier, in this same single-threaded sweep. For
        // `readCase` to then find nothing, something must have deleted the
        // META item in between -- and nothing in this codebase does: every
        // `table.delete(` call site (grepped across services/api/src and
        // services/migration/src) is `caseStore.ts`'s own stale-APPLICANT#nn
        // cleanup, or `memory.ts`/`notices.ts` deleting an unrelated
        // partition. None deletes a case META item.
        //
        // Folding this into `unreadableCaseIds` would misrepresent it: that
        // bucket is for the ONE known, expected corruption (rule 2 above) --
        // a `writeCase` timeout leaving META with no applicants -- which an
        // operator reading the report already knows how to act on. This is
        // not that. It is the sweep's own assumptions turning out false, and
        // continuing to write against a state the code no longer understands
        // is worse than stopping. So it throws instead of being counted.
        //
        // What would make this reachable: a future case-deletion feature, or
        // a logic error introduced into this sweep. Either should bring its
        // own test alongside it -- a provably dead branch does not get one
        // now.
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
      const expectedSummary = crm.summariseApplicants(loadedCase.applicants);
      if (applicantSummaryIsCurrent(storedMetaItem?.["applicantSummary"], expectedSummary)) {
        report.alreadyCurrent += 1;
        continue;
      }

      await writeCase(context, loadedCase);
      report.written += 1;
    }
  }

  return report;
}
