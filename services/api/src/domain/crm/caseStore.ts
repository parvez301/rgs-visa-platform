import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { corruptRecord, notFound } from "../../lib/errors";
import {
  APPLICANT_SORT_KEY_PREFIX,
  META_SORT_KEY,
  applicantSortKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";

/**
 * The domain shape (CrmCase, with applicants[] embedded) and the storage shape
 * (a META item plus one APPLICANT#nn item each) differ on purpose — see spec §5.
 * This module is the only place that knows about the difference.
 */

export async function writeCase(context: AppContext, crmCase: crm.CrmCase): Promise<void> {
  const partitionKey = casePartitionKey(crmCase.tenantId, crmCase.caseId);
  const { applicants, ...caseBody } = crmCase;

  await context.table.put({
    PK: partitionKey,
    SK: META_SORT_KEY,
    GSI1PK: caseStatusGsi1Pk(crmCase.tenantId, crmCase.caseStatus),
    GSI1SK: crmCase.updatedAt,
    GSI2PK: partnerCasesGsi2Pk(crmCase.tenantId, crmCase.partnerId),
    GSI2SK: crmCase.receivedDate,
    ...caseBody,
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
  const metaItem = await context.table.get(partitionKey, META_SORT_KEY);
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

  try {
    return crm.CrmCaseSchema.parse({
      ...stripStorageAttributes(metaItem),
      applicants: applicantItems.map(stripStorageAttributes),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      // A partition can hold META with no APPLICANT# items — writeCase is not
      // transactional, so a timeout between the two writes leaves exactly that.
      // Raw, a ZodError escapes the router's ApiError mapping as a 500; an
      // empty applicants array would instead pass a corrupt case off as healthy.
      throw corruptRecord("Case", caseId, describeFirstIssue(error));
    }
    throw error;
  }
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
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

/** Removes the key and index attributes so only domain fields reach the schema. */
function stripStorageAttributes(item: TableItem): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1Pk,
    GSI1SK: _gsi1Sk,
    GSI2PK: _gsi2Pk,
    GSI2SK: _gsi2Sk,
    GSI3PK: _gsi3Pk,
    GSI3SK: _gsi3Sk,
    ...domainFields
  } = item;
  return domainFields;
}
