import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, corruptRecord, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { describeFirstZodIssue } from "../../lib/storedRecords";
import { readCase, readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";
import { readCasesPostgres } from "./caseStorePostgres";
import {
  countCasesByFieldPostgres,
  listCaseIdsByPartnerPostgres,
  listCaseIdsByStatusPostgres,
  listCaseRefsByStatusPostgres,
} from "./casesListPostgres";
import { requireSql } from "./postgresClient";
import type { SqlClient } from "../../lib/sql";
import { assertApplicantRefNosDistinct, claimNewRefs, releaseRefKeys, staleRefKeys } from "./refClaims";
import { getTravellerOrThrow } from "./travellers";
import { stampDocumentChecklistFromCountry } from "./caseDocumentChecklist";
import { labelsForDestinationCountry } from "./destinationRequiredDocuments";
import { notifyOnCaseCreated, notifyOnCaseStatusChange } from "./statusNotify";

export interface CreateCaseApplicantInput {
  applicantRef: string;
  travellerId: string;
  passportNumber?: string;
  refNo?: string;
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
  expectedCollectionDate?: string;
  remarks?: string;
  groupName?: string;
  clientEmail?: string;
  applicants: CreateCaseApplicantInput[];
}

/**
 * ISO dates compare as strings. A collection date before the day the desk
 * received the file is a typo every time (feedback round 1, 2026-09-24), so
 * both the create and the update path refuse it with the same sentence the
 * New Case form shows -- one rule, one wording, whichever door it came in.
 */
function assertCollectionNotBeforeReceived(receivedDate: string, expectedCollectionDate: string | undefined): void {
  if (expectedCollectionDate !== undefined && expectedCollectionDate < receivedDate) {
    throw badRequest("Collection date cannot be before the received date");
  }
}

export async function createCase(
  context: AppContext,
  tenantId: string,
  input: CreateCaseInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  // 404s if the partner is unknown — a case always belongs to someone.
  await getPartnerOrThrow(context, tenantId, input.partnerId);
  // ...and 404s if any applicant cites a traveller that is not on file. The
  // repeat-traveller capability (spec §5) is worth nothing if a case can point
  // at a travellerId nobody ever created.
  for (const applicantInput of input.applicants) {
    await getTravellerOrThrow(context, tenantId, applicantInput.travellerId);
  }

  const nowIso = context.now().toISOString();
  const documentChecklist = stampDocumentChecklistFromCountry(
    await labelsForDestinationCountry(context, input.destinationCountry),
  );
  assertCollectionNotBeforeReceived(input.receivedDate, input.expectedCollectionDate);
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
      ...(input.expectedCollectionDate !== undefined
        ? { expectedCollectionDate: input.expectedCollectionDate }
        : {}),
      ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
      ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
      ...(input.clientEmail !== undefined ? { clientEmail: input.clientEmail } : {}),
      lineItems: [],
      totalInr: 0,
      documentChecklist,
      watchdogOverrides: {},
      mutedRules: [],
      applicants: input.applicants.map((applicant) => ({
        applicantRef: applicant.applicantRef,
        travellerId: applicant.travellerId,
        ...(applicant.passportNumber !== undefined
          ? { passportNumber: applicant.passportNumber }
          : {}),
        ...(applicant.refNo !== undefined ? { refNo: applicant.refNo } : {}),
        custody: "NOT_HELD",
        outcome: "PENDING",
      })),
      createdAt: nowIso,
      updatedAt: nowIso,
      // router.ts defaults a missing `email` claim to "", and an empty string
      // is not an author — omit the field rather than record a blank one.
      ...(actorEmail !== "" ? { createdByEmail: actorEmail } : {}),
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

  assertApplicantRefNosDistinct(crmCase);
  // Claimed BEFORE the write so two racing creates cannot both land; released
  // again if the write fails, or the REF would stay taken by a case that does
  // not exist.
  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, crmCase.caseId, undefined, crmCase);
  try {
    await writeCase(context, crmCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, crmCase.caseId, newlyClaimedRefKeys);
    throw error;
  }
  await recordCrmEvent(context, tenantId, crmCase.caseId, "CASE_CREATED", actorEmail, {
    caseRef: crmCase.caseRef,
    caseType: crmCase.caseType,
  });
  await notifyOnCaseCreated(context, tenantId, crmCase, actorEmail);
  return crmCase;
}

export async function getCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  return readCaseOrThrow(context, tenantId, caseId);
}

/**
 * The fields `updateCaseDetails` may move. `caseStatus`, per-applicant
 * `custody`, per-applicant `outcome` and `billingStatus` each have a state
 * machine and their own mutator (`changeCaseStatus`, `changeApplicantCustody`,
 * `changeApplicantOutcome`, `changeBillingStatus` below) -- a general "update
 * any field" route would let a caller walk around every one of them.
 */
export interface UpdateCaseDetailsInput {
  caseRef?: string;
  caseType?: crm.CaseType;
  partnerId?: string;
  destinationCountry?: string;
  receivedDate?: string;
  /** For every field below, `null` clears it; `undefined` leaves it alone. */
  visaType?: crm.VisaType | null;
  entryType?: crm.EntryType | null;
  processing?: crm.ProcessingSpeed | null;
  submissionDate?: string | null;
  appointmentDate?: string | null;
  expectedCollectionDate?: string | null;
  remarks?: string | null;
  groupName?: string | null;
  clientEmail?: string | null;
}

/**
 * Every field this route may move, by name. A closed list, never a spread of
 * the input: caseStatus, billingStatus, custody and outcome each have a state
 * machine and their own route, and anything not named here cannot reach the
 * case whatever extra keys the caller sends.
 */
const EDITABLE_CASE_FIELDS = [
  "caseRef",
  "caseType",
  "partnerId",
  "destinationCountry",
  "receivedDate",
  "visaType",
  "entryType",
  "processing",
  "submissionDate",
  "appointmentDate",
  "expectedCollectionDate",
  "remarks",
  "groupName",
  "clientEmail",
] as const satisfies readonly (keyof UpdateCaseDetailsInput & keyof crm.CrmCase)[];
type EditableCaseField = (typeof EDITABLE_CASE_FIELDS)[number];

/**
 * Updates every plain (non-state-machine) field on a case, at any stage.
 * A changed caseRef claims the new REF and frees the old one; a case type
 * other than VISA drops the visa type in the same write.
 */
export async function updateCaseDetails(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: UpdateCaseDetailsInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);

  // Named for the audit trail: a field that actually MOVED, not merely one the
  // caller supplied. `null` reads as "absent", so clearing an absent field is
  // no change at all.
  const nextFieldValues: Partial<Record<EditableCaseField, unknown>> = {};
  const changedFieldNames: EditableCaseField[] = [];
  for (const fieldName of EDITABLE_CASE_FIELDS) {
    const requestedValue = input[fieldName];
    if (requestedValue === undefined) continue;
    const nextValue = requestedValue ?? undefined;
    if (nextValue === currentCase[fieldName]) continue;
    nextFieldValues[fieldName] = nextValue;
    changedFieldNames.push(fieldName);
  }
  const nextCaseType = (nextFieldValues.caseType ?? currentCase.caseType) as crm.CaseType;
  if (nextCaseType !== "VISA" && currentCase.visaType !== undefined && !("visaType" in nextFieldValues)) {
    nextFieldValues.visaType = undefined;
    changedFieldNames.push("visaType");
  }

  // Nothing moved: return before the parse/write/event so a no-op call does
  // not bump updatedAt or record a CASE_UPDATED that names no real change.
  if (changedFieldNames.length === 0) return currentCase;

  if ("partnerId" in nextFieldValues) {
    await getPartnerOrThrow(context, tenantId, nextFieldValues.partnerId as string);
  }
  const nextReceivedDate = (nextFieldValues.receivedDate ?? currentCase.receivedDate) as string;
  const nextCollectionDate =
    "expectedCollectionDate" in nextFieldValues
      ? (nextFieldValues.expectedCollectionDate as string | undefined)
      : currentCase.expectedCollectionDate;
  assertCollectionNotBeforeReceived(nextReceivedDate, nextCollectionDate);

  // Unwrapped, a ZodError is not an ApiError, and router.ts maps only ApiError
  // subclasses -- a bad date or a VISA with no visa type would answer a bare
  // 500 instead of a 400 naming the problem. Same guard as createCase.
  let updatedCase: crm.CrmCase;
  try {
    const { appointmentReminderSentFor, ...caseWithoutReminderStamp } = currentCase;
    const appointmentDateChanging = "appointmentDate" in nextFieldValues;
    const mergedCase: Record<string, unknown> = {
      ...caseWithoutReminderStamp,
      // A moved appointment must earn a fresh reminder; an unmoved one keeps its stamp.
      ...(appointmentDateChanging || appointmentReminderSentFor === undefined ? {} : { appointmentReminderSentFor }),
      ...nextFieldValues,
      updatedAt: context.now().toISOString(),
    };
    // DynamoDB refuses an undefined attribute; a cleared field must be absent.
    for (const [fieldName, fieldValue] of Object.entries(mergedCase)) {
      if (fieldValue === undefined) delete mergedCase[fieldName];
    }
    updatedCase = crm.CrmCaseSchema.parse(mergedCase);
  } catch (error) {
    if (error instanceof ZodError) throw badRequest(describeFirstZodIssue(error));
    throw error;
  }

  // Claimed BEFORE the write so two racing edits cannot both land; released
  // again if the write fails. The OLD REF is freed only after the write lands.
  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, caseId, currentCase, updatedCase);
  try {
    await writeCase(context, updatedCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, caseId, newlyClaimedRefKeys);
    throw error;
  }
  await releaseRefKeys(context, tenantId, caseId, staleRefKeys(currentCase, updatedCase));

  await recordCrmEvent(context, tenantId, caseId, "CASE_UPDATED", actorEmail, {
    // meta values are scalars only (crmEvents.ts) -- a joined string is how an
    // array of changed field names travels through that constraint.
    changedFields: changedFieldNames.join(","),
  });
  return updatedCase;
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
  await notifyOnCaseStatusChange(
    context,
    tenantId,
    updatedCase,
    currentCase.caseStatus,
    toStatus,
    actorEmail,
  );
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
  if (!crm.canTransitionOutcome(caseApplicant.outcome, nextOutcome)) {
    throw conflict(`Cannot move outcome from ${caseApplicant.outcome} to ${nextOutcome}`);
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

  // A case *becomes* DECIDED once every applicant is APPROVED or REJECTED, and
  // *reopens* to SUBMITTED when one of them is SENT_BACK or back to PENDING.
  // Both directions are automatic (spec §5), not a manual gate.
  const derivedCaseStatus = crm.deriveCaseStatusFromApplicants(
    updatedCase.caseStatus,
    updatedApplicants.map((applicant) => applicant.outcome),
    {
      isGroup: crm.isCaseGroup({
        groupName: updatedCase.groupName,
        applicantCount: updatedApplicants.length,
      }),
    },
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
  await notifyOnCaseStatusChange(
    context,
    tenantId,
    updatedCase,
    crmCase.caseStatus,
    candidateCaseStatus,
    actorEmail,
  );
  return updatedCase;
}

/**
 * A case listing plus the ids of the rows it could not read. The skipped ids
 * travel with the payload on purpose: a case that silently drops out of a queue
 * is indistinguishable from a case that was never there, and a console.warn
 * nobody is watching does not make that visible to the operator looking at it.
 */
export interface CaseListing {
  cases: crm.CrmCase[];
  unreadableCaseIds: string[];
}

export async function listCasesByStatus(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  limit = 50,
): Promise<CaseListing> {
  const sql = requireSql(context);
  return loadCasesFromPostgres(
    sql,
    tenantId,
    await listCaseIdsByStatusPostgres(sql, tenantId, caseStatus, limit),
  );
}

export interface StoredCaseRef {
  caseRef: string;
  caseId: string;
}

export interface CaseRefListing {
  /** Every `caseRef` legible on a META item in this status partition. */
  storedCaseRefs: StoredCaseRef[];
  /**
   * META items that name no usable `caseRef`. Named rather than dropped: a
   * stored case whose ref cannot be read is a case an importer cannot know it
   * has already imported, which is the one thing the caller must be told.
   */
  unreadableCaseIds: string[];
}

/**
 * The `caseRef`s stored under one case status, read straight off the case
 * rows without reassembling any case.
 */
export async function listCaseRefsByStatus(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  // No default: `undefined` drains the whole status.
  limit?: number,
): Promise<CaseRefListing> {
  return listCaseRefsByStatusPostgres(requireSql(context), tenantId, caseStatus, limit);
}

/**
 * The fields a "how many cases" question can group and count by. Every one of
 * these is a column on the case row, so counting never needs a case reassembled.
 */
export const CASE_COUNT_GROUP_BY_FIELDS = [
  "caseStatus",
  "destinationCountry",
  "billingStatus",
  "partnerId",
] as const;
export type CaseCountGroupByField = (typeof CASE_COUNT_GROUP_BY_FIELDS)[number];

/**
 * A count-by-field result plus the ids of the rows it could not count. Named
 * rather than dropped in silence, for the same reason `CaseListing` names its
 * unreadable rows: a case missing from a count an owner will act on is worse
 * than one missing from a list, because nothing about a bare number signals
 * that some cases never made it into it.
 */
export interface CaseCountByField {
  counts: Record<string, number>;
  total: number;
  uncountedCaseIds: string[];
}

/**
 * Counts every case in the tenant by one field, grouped by that field's
 * value, without reassembling a single case.
 *
 * A single grouped query answers it; no case is reassembled.
 *
 * A row whose counted field is missing or not a string is named in
 * `uncountedCaseIds` rather than counted under a bogus `"undefined"` key or
 * silently skipped.
 */
export async function countCasesByField(
  context: AppContext,
  tenantId: string,
  groupByField: CaseCountGroupByField,
): Promise<CaseCountByField> {
  return countCasesByFieldPostgres(requireSql(context), tenantId, groupByField);
}

export async function listCasesByPartner(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  limit = 50,
): Promise<CaseListing> {
  const sql = requireSql(context);
  return loadCasesFromPostgres(
    sql,
    tenantId,
    await listCaseIdsByPartnerPostgres(sql, tenantId, partnerId, limit),
  );
}

/**
 * Reassembles the listed ids in one batched read, in the order the index query
 * gave them. A row that exists but cannot be parsed (e.g. no applicant rows) is
 * named in `unreadableCaseIds`; an id that vanished
 * between the two statements is simply absent.
 */
async function loadCasesFromPostgres(
  sql: SqlClient,
  tenantId: string,
  caseIds: string[],
): Promise<CaseListing> {
  const { cases, unreadableCaseIds } = await readCasesPostgres(sql, tenantId, caseIds);
  if (unreadableCaseIds.length > 0) {
    console.warn(
      `Skipped ${unreadableCaseIds.length} unreadable CRM case(s) in tenant ${tenantId}: ${unreadableCaseIds.join(", ")}`,
    );
  }
  const unreadable = new Set(unreadableCaseIds);
  return {
    cases: caseIds.flatMap((caseId) => {
      const crmCase = cases.get(caseId);
      return crmCase === undefined ? [] : [crmCase];
    }),
    unreadableCaseIds: caseIds.filter((caseId) => unreadable.has(caseId)),
  };
}
