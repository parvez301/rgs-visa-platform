import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { notFound } from "../../lib/errors";
import {
  APPLICANT_SORT_KEY_PREFIX,
  CASE_META_SORT_KEY,
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
    SK: CASE_META_SORT_KEY,
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

  // Drop applicant items beyond the current count, or a shrunk case keeps ghosts.
  const existingApplicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
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
  const metaItem = await context.table.get(partitionKey, CASE_META_SORT_KEY);
  if (!metaItem) return undefined;

  const applicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
  });

  return crm.CrmCaseSchema.parse({
    ...stripStorageAttributes(metaItem),
    applicants: applicantItems.map(stripStorageAttributes),
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
