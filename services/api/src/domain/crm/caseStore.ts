import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import {
  APPLICANT_SORT_KEY_PREFIX,
  META_SORT_KEY,
  applicantSortKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";
import { resolveLedgerSearchText } from "./ledgerSearchText";

/**
 * The domain shape (CrmCase, with applicants[] embedded) and the storage shape
 * (a META item plus one APPLICANT#nn item each) differ on purpose — see spec §5.
 * This module is the only place that knows about the difference.
 */

export async function writeCase(context: AppContext, crmCase: crm.CrmCase): Promise<void> {
  const partitionKey = casePartitionKey(crmCase.tenantId, crmCase.caseId);
  const { applicants, ...caseBody } = crmCase;
  const searchText = await resolveLedgerSearchText(context, crmCase.tenantId, applicants);

  await context.table.put({
    PK: partitionKey,
    SK: META_SORT_KEY,
    GSI1PK: caseStatusGsi1Pk(crmCase.tenantId, crmCase.caseStatus),
    GSI1SK: crmCase.updatedAt,
    GSI2PK: partnerCasesGsi2Pk(crmCase.tenantId, crmCase.partnerId),
    GSI2SK: crmCase.receivedDate,
    ...caseBody,
    // AFTER the spread, deliberately: a caller that hand-built a case object
    // carrying a stale applicantSummary must not be able to store it. The
    // computed value is the only one that can reach the item.
    //
    // Computed here and nowhere else because here is the only place a case
    // can reach storage -- every mutator in cases.ts reassembles the whole
    // case and calls this function -- so there is no way to persist a case
    // whose roll-up disagrees with its applicants. `readCase` never reads this
    // attribute back: CrmCaseSchema strips unknown keys, so the domain object
    // stays exactly what it was, and the Ledger projection (Plan 5 Task 3) is
    // the only reader.
    applicantSummary: crm.summariseApplicants(applicants),
    // Same discipline as applicantSummary: computed here, never accepted from
    // a caller-built case body. Omitted when empty so PutItem clears a stale
    // haystack rather than leaving the previous names/passports behind.
    ...(searchText !== undefined ? { searchText } : {}),
  });

  for (const [applicantIndex, caseApplicant] of applicants.entries()) {
    await context.table.put({
      PK: partitionKey,
      SK: applicantSortKey(applicantIndex),
      ...caseApplicant,
    });
  }

  // Drop applicant items beyond the current count, or a shrunk case keeps
  // ghosts. This is a read-after-write: an eventually consistent read can miss
  // the very item it is about to delete, and a surviving ghost applicant
  // blocks DECIDED and CLOSED for good, so it must be strongly consistent.
  const existingApplicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
    consistentRead: true,
  });
  for (const staleItem of existingApplicantItems.slice(applicants.length)) {
    await context.table.delete(partitionKey, staleItem.SK);
  }
}

export async function readCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase | undefined> {
  const partitionKey = casePartitionKey(tenantId, caseId);
  // Strongly consistent, for the same reason the applicant read below is: an
  // eventually consistent get can miss a META item that was written moments
  // earlier, and a case that exists then reads back as no case at all — a 404
  // from the single-case route, or a false entry in unreadableCaseIds on the
  // listing.
  const metaItem = await context.table.get(partitionKey, META_SORT_KEY, {
    consistentRead: true,
  });
  if (!metaItem) return undefined;

  // Strongly consistent for the same reason writeCase's re-read is: an
  // eventually consistent query can miss an applicant item that is really
  // there. Here the cost is worse than a ghost — a healthy case comes back
  // with applicants: [], which parses as CorruptRecordError, which the list
  // endpoint skips, and the case leaves the queue without anything being wrong
  // with it.
  const applicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
    consistentRead: true,
  });

  // A partition can hold META with no APPLICANT# items — writeCase is not
  // transactional, so a timeout between the two writes leaves exactly that.
  // Raw, a ZodError escapes the router's ApiError mapping as a 500; an empty
  // applicants array would instead pass a corrupt case off as healthy.
  return parseStoredRecord(crm.CrmCaseSchema, "Case", caseId, {
    ...stripStorageKeys(metaItem),
    applicants: applicantItems.map(stripStorageKeys),
  });
}

export async function readCaseOrThrow(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  const loadedCase = await readCase(context, tenantId, caseId);
  if (!loadedCase) throw notFound("Case");
  return loadedCase;
}
