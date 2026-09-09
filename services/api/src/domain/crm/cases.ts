import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { CorruptRecordError, badRequest, conflict, notFound } from "../../lib/errors";
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
  let crmCase: crm.CrmCase;
  try {
    crmCase = crm.CrmCaseSchema.parse({
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
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(
        firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid case",
      );
    }
    throw error;
  }

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
  applicantRef: string,
  toCustody: crm.CustodyStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = currentCase.applicants.findIndex(
    (applicant) => applicant.applicantRef === applicantRef,
  );
  const caseApplicant = currentCase.applicants[applicantIndex];
  if (applicantIndex === -1 || !caseApplicant) {
    throw notFound("Applicant");
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
    applicantRef,
    fromCustody: caseApplicant.custody,
    toCustody,
  });

  // A case *becomes* CLOSED once every passport is back and the bill is
  // settled — this is automatic (spec §5), not a manual gate.
  const allApplicantCustodies = updatedApplicants.map((applicant) => applicant.custody);
  if (crm.isCaseClosable(allApplicantCustodies, updatedCase.billingStatus)) {
    return applyDerivedCaseStatusIfLegal(context, tenantId, updatedCase, "CLOSED", actorEmail);
  }
  return updatedCase;
}

export async function changeApplicantOutcome(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantRef: string,
  nextOutcome: crm.ApplicantOutcome,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = currentCase.applicants.findIndex(
    (applicant) => applicant.applicantRef === applicantRef,
  );
  const caseApplicant = currentCase.applicants[applicantIndex];
  if (applicantIndex === -1 || !caseApplicant) {
    throw notFound("Applicant");
  }
  if (!crm.APPLICANT_OUTCOMES.includes(nextOutcome)) {
    throw badRequest(`Unknown applicant outcome ${nextOutcome}`);
  }

  const nowIso = context.now().toISOString();
  const updatedApplicants = currentCase.applicants.map((applicant, index) =>
    index === applicantIndex ? { ...applicant, outcome: nextOutcome } : applicant,
  );
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    applicants: updatedApplicants,
    updatedAt: nowIso,
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_OUTCOME_CHANGED", actorEmail, {
    applicantRef,
    fromOutcome: caseApplicant.outcome,
    toOutcome: nextOutcome,
  });

  // A case *becomes* DECIDED once every applicant has a non-PENDING outcome —
  // this is automatic (spec §5), not a manual gate.
  const derivedCaseStatus = crm.deriveCaseStatusFromApplicants(
    updatedCase.caseStatus,
    updatedApplicants.map((applicant) => applicant.outcome),
  );
  return applyDerivedCaseStatusIfLegal(context, tenantId, updatedCase, derivedCaseStatus, actorEmail);
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

  // A case *becomes* CLOSED once every passport is back and the bill is
  // settled — this is automatic (spec §5), not a manual gate.
  const allApplicantCustodies = updatedCase.applicants.map((applicant) => applicant.custody);
  if (crm.isCaseClosable(allApplicantCustodies, updatedCase.billingStatus)) {
    return applyDerivedCaseStatusIfLegal(context, tenantId, updatedCase, "CLOSED", actorEmail);
  }
  return updatedCase;
}

/**
 * Applies a derived case-status transition (DECIDED from applicant outcomes,
 * CLOSED from custody + billing) only when the shared machine allows it, and
 * logs it as its own CASE_STATUS_CHANGED event. If the candidate status is
 * unchanged or illegal (e.g. the case is already terminal), the case is left
 * untouched — the mutation that triggered this check has already succeeded
 * on its own axis, so this never throws.
 */
async function applyDerivedCaseStatusIfLegal(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  candidateCaseStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  if (
    candidateCaseStatus === crmCase.caseStatus ||
    !crm.canTransitionCaseStatus(crmCase.caseStatus, candidateCaseStatus)
  ) {
    return crmCase;
  }
  const updatedCase: crm.CrmCase = {
    ...crmCase,
    caseStatus: candidateCaseStatus,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, crmCase.caseId, "CASE_STATUS_CHANGED", actorEmail, {
    fromStatus: crmCase.caseStatus,
    toStatus: candidateCaseStatus,
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
 *
 * One case that cannot be reassembled (a half-written partition) must not hide
 * the healthy ones — a whole tenant's queue would go down with it — so the bad
 * row is skipped and logged with its caseId. Only CorruptRecordError is
 * swallowed; every other failure still propagates.
 */
async function loadCasesFromMetaItems(
  context: AppContext,
  tenantId: string,
  metaItems: Array<Record<string, unknown>>,
): Promise<crm.CrmCase[]> {
  const loadedCases: crm.CrmCase[] = [];
  for (const metaItem of metaItems) {
    if (metaItem["SK"] !== CASE_META_SORT_KEY) continue;
    const caseId = String(metaItem["caseId"]);
    try {
      const loadedCase = await readCase(context, tenantId, caseId);
      if (loadedCase) loadedCases.push(loadedCase);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      console.warn(
        `Skipped unreadable CRM case ${caseId} in tenant ${tenantId}: ${error.message}`,
      );
    }
  }
  return loadedCases;
}
