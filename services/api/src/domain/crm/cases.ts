import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { readCase, readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { CASE_META_SORT_KEY, caseStatusGsi1Pk, partnerCasesGsi2Pk } from "./keys";
import { getPartnerOrThrow } from "./partners";

export interface CreateCaseApplicantInput {
  applicantRef: string;
  travellerId: string;
  passportNumber?: string;
}

export interface CreateCaseInput {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  receivedDate: string;
  applicants: CreateCaseApplicantInput[];
}

export async function createCase(
  context: AppContext,
  tenantId: string,
  input: CreateCaseInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  // 404s if the partner is unknown — a case always belongs to someone.
  await getPartnerOrThrow(context, tenantId, input.partnerId);

  const nowIso = context.now().toISOString();
  const crmCase = crm.CrmCaseSchema.parse({
    tenantId,
    caseId: newId("case", context.now().getTime()),
    caseRef: input.caseRef,
    caseType: input.caseType,
    partnerId: input.partnerId,
    destinationCountry: input.destinationCountry,
    ...(input.visaType !== undefined ? { visaType: input.visaType } : {}),
    ...(input.entryType !== undefined ? { entryType: input.entryType } : {}),
    ...(input.processing !== undefined ? { processing: input.processing } : {}),
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: input.receivedDate,
    lineItems: [],
    totalInr: 0,
    watchdogOverrides: {},
    mutedRules: [],
    applicants: input.applicants.map((applicant) => ({
      applicantRef: applicant.applicantRef,
      travellerId: applicant.travellerId,
      ...(applicant.passportNumber !== undefined
        ? { passportNumber: applicant.passportNumber }
        : {}),
      custody: "NOT_HELD",
      outcome: "PENDING",
    })),
    createdAt: nowIso,
    updatedAt: nowIso,
    createdByEmail: actorEmail,
  });

  await writeCase(context, crmCase);
  await recordCrmEvent(context, tenantId, crmCase.caseId, "CASE_CREATED", actorEmail, {
    caseRef: crmCase.caseRef,
    caseType: crmCase.caseType,
  });
  return crmCase;
}

export async function getCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  return readCaseOrThrow(context, tenantId, caseId);
}

export async function changeCaseStatus(
  context: AppContext,
  tenantId: string,
  caseId: string,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  if (!crm.canTransitionCaseStatus(currentCase.caseStatus, toStatus)) {
    throw conflict(`Cannot move a case from ${currentCase.caseStatus} to ${toStatus}`);
  }
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    caseStatus: toStatus,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "CASE_STATUS_CHANGED", actorEmail, {
    fromStatus: currentCase.caseStatus,
    toStatus,
  });
  return updatedCase;
}

export async function changeApplicantCustody(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantIndex: number,
  toCustody: crm.CustodyStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const caseApplicant = currentCase.applicants[applicantIndex];
  if (!caseApplicant) {
    throw badRequest(`Case has no applicant at index ${applicantIndex}`);
  }
  if (!crm.canTransitionCustody(caseApplicant.custody, toCustody)) {
    throw conflict(`Cannot move custody from ${caseApplicant.custody} to ${toCustody}`);
  }

  const nowIso = context.now().toISOString();
  const updatedApplicants = currentCase.applicants.map((applicant, index) =>
    index === applicantIndex
      ? { ...applicant, custody: toCustody, custodySince: nowIso }
      : applicant,
  );
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    applicants: updatedApplicants,
    updatedAt: nowIso,
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "CUSTODY_CHANGED", actorEmail, {
    applicantIndex,
    fromCustody: caseApplicant.custody,
    toCustody,
  });
  return updatedCase;
}

export async function changeBillingStatus(
  context: AppContext,
  tenantId: string,
  caseId: string,
  toBillingStatus: crm.BillingStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  if (!crm.canTransitionBilling(currentCase.billingStatus, toBillingStatus)) {
    throw conflict(
      `Cannot move billing from ${currentCase.billingStatus} to ${toBillingStatus}`,
    );
  }
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    billingStatus: toBillingStatus,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "BILLING_CHANGED", actorEmail, {
    fromBillingStatus: currentCase.billingStatus,
    toBillingStatus,
  });
  return updatedCase;
}

export async function listCasesByStatus(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  limit = 50,
): Promise<crm.CrmCase[]> {
  const metaItems = await context.table.queryGsi(
    "GSI1",
    caseStatusGsi1Pk(tenantId, caseStatus),
    { limit, scanForward: false },
  );
  return loadCasesFromMetaItems(context, tenantId, metaItems);
}

export async function listCasesByPartner(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  limit = 50,
): Promise<crm.CrmCase[]> {
  const metaItems = await context.table.queryGsi(
    "GSI2",
    partnerCasesGsi2Pk(tenantId, partnerId),
    { limit, scanForward: false },
  );
  return loadCasesFromMetaItems(context, tenantId, metaItems);
}

/**
 * A GSI query returns only the META item; applicants live in sibling items, so
 * each case is reassembled through the store.
 */
async function loadCasesFromMetaItems(
  context: AppContext,
  tenantId: string,
  metaItems: Array<Record<string, unknown>>,
): Promise<crm.CrmCase[]> {
  const loadedCases: crm.CrmCase[] = [];
  for (const metaItem of metaItems) {
    if (metaItem["SK"] !== CASE_META_SORT_KEY) continue;
    const loadedCase = await readCase(context, tenantId, String(metaItem["caseId"]));
    if (loadedCase) loadedCases.push(loadedCase);
  }
  return loadedCases;
}
