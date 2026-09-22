import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { badRequest, conflict, corruptRecord, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { collectReadableRecords, describeFirstZodIssue } from "../../lib/storedRecords";
import { readCase, readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import {
  META_SORT_KEY,
  caseIdFromPartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";
import { getPartnerOrThrow } from "./partners";
import { getTravellerOrThrow } from "./travellers";
import { findCountryChecklist } from "./countryChecklist";
import { stampDocumentChecklistFromCountry } from "./caseDocumentChecklist";
import { notifyPartnerOfCaseStatusChange } from "./partnerStatusNotify";

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
  expectedCollectionDate?: string;
  remarks?: string;
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
  // ...and 404s if any applicant cites a traveller that is not on file. The
  // repeat-traveller capability (spec §5) is worth nothing if a case can point
  // at a travellerId nobody ever created.
  for (const applicantInput of input.applicants) {
    await getTravellerOrThrow(context, tenantId, applicantInput.travellerId);
  }

  const nowIso = context.now().toISOString();
  const countryChecklist = await findCountryChecklist(context, tenantId, input.destinationCountry);
  const documentChecklist =
    countryChecklist === undefined
      ? []
      : stampDocumentChecklistFromCountry(countryChecklist.requiredDocuments);
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

/**
 * The fields `updateCaseDetails` is allowed to touch. `caseStatus`, per-
 * applicant `custody`, per-applicant `outcome` and `billingStatus` each have a
 * state machine and their own mutator (`changeCaseStatus`,
 * `changeApplicantCustody`, `changeApplicantOutcome`, `changeBillingStatus`
 * below) -- a general "update any field" route would let a caller walk around
 * every one of them.
 */
export interface UpdateCaseDetailsInput {
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  submissionDate?: string;
  appointmentDate?: string;
  expectedCollectionDate?: string;
  remarks?: string;
}

/**
 * Updates the plain-field, non-state-machine details on a case.
 *
 * The update is built one named field at a time -- never by spreading `input`
 * onto the case and deleting the axes it must not touch -- because a
 * delete-list is one forgotten key away from letting `caseStatus` or
 * `billingStatus` move through this route. Picking each name explicitly
 * means a caller cannot smuggle either axis through no matter what extra
 * properties its input object carries. `remarks` is one of those named fields.
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
  // caller supplied. Re-supplying a value the case already has must not read
  // back as a change nobody made.
  const changedFieldNames: string[] = [];
  if (input.visaType !== undefined && input.visaType !== currentCase.visaType) {
    changedFieldNames.push("visaType");
  }
  if (input.entryType !== undefined && input.entryType !== currentCase.entryType) {
    changedFieldNames.push("entryType");
  }
  if (input.processing !== undefined && input.processing !== currentCase.processing) {
    changedFieldNames.push("processing");
  }
  if (input.submissionDate !== undefined && input.submissionDate !== currentCase.submissionDate) {
    changedFieldNames.push("submissionDate");
  }
  const appointmentDateChanging =
    input.appointmentDate !== undefined && input.appointmentDate !== currentCase.appointmentDate;
  if (appointmentDateChanging) {
    changedFieldNames.push("appointmentDate");
  }
  if (
    input.expectedCollectionDate !== undefined &&
    input.expectedCollectionDate !== currentCase.expectedCollectionDate
  ) {
    changedFieldNames.push("expectedCollectionDate");
  }
  if (input.remarks !== undefined && input.remarks !== currentCase.remarks) {
    changedFieldNames.push("remarks");
  }

  // Nothing moved -- an empty input, or every supplied value already matches
  // what's stored. Returning the case as-is, before the parse/write/event
  // below, is what keeps a no-op call from bumping updatedAt and recording a
  // CASE_UPDATED event that names no real change.
  if (changedFieldNames.length === 0) {
    return currentCase;
  }

  // Unwrapped, a ZodError here is not an ApiError, and router.ts maps only
  // ApiError subclasses -- so a caller-supplied date that fails CrmCaseSchema's
  // isoDate check (or a visaType offered to a non-VISA case) would answer a
  // bare 500 instead of a 400 naming the problem. Same guard as createCase.
  let updatedCase: crm.CrmCase;
  try {
    const caseForParse = appointmentDateChanging
      ? (({ appointmentReminderSentFor: _cleared, ...rest }) => rest)(currentCase)
      : currentCase;
    updatedCase = crm.CrmCaseSchema.parse({
      ...caseForParse,
      ...(input.visaType !== undefined ? { visaType: input.visaType } : {}),
      ...(input.entryType !== undefined ? { entryType: input.entryType } : {}),
      ...(input.processing !== undefined ? { processing: input.processing } : {}),
      ...(input.submissionDate !== undefined ? { submissionDate: input.submissionDate } : {}),
      ...(input.appointmentDate !== undefined ? { appointmentDate: input.appointmentDate } : {}),
      ...(input.expectedCollectionDate !== undefined
        ? { expectedCollectionDate: input.expectedCollectionDate }
        : {}),
      ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
      updatedAt: context.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(describeFirstZodIssue(error));
    }
    throw error;
  }

  await writeCase(context, updatedCase);
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
  await notifyPartnerOfCaseStatusChange(
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
  await notifyPartnerOfCaseStatusChange(
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
  const metaItems = await context.table.queryGsi(
    "GSI1",
    caseStatusGsi1Pk(tenantId, caseStatus),
    { limit, scanForward: false },
  );
  return loadCasesFromMetaItems(context, tenantId, metaItems);
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
 * The `caseRef`s stored under one case status, read straight off the META
 * items GSI1 already returned.
 *
 * `listCasesByStatus` cannot answer this cheaply: it reassembles every case
 * through `readCase`, which costs one strongly-consistent GetItem plus one
 * strongly-consistent Query per case. Measured on the real workbook that is
 * 14,312 sequential round-trips to collect one attribute the index query had
 * already handed over.
 *
 * It cannot answer it correctly either. `readCase` throws CorruptRecordError
 * for a partition holding META with no applicant items — which `writeCase`,
 * being non-transactional, produces on any timeout between its two writes —
 * and `loadCasesFromMetaItems` then drops that case from the listing. Its
 * `caseRef` never reaches the caller, so an importer concludes the ref was
 * never imported and imports it a second time, on that run and on every run
 * after it. Reading the attribute off the META item cannot fail that way: the
 * META item is written first and carries the ref.
 */
export async function listCaseRefsByStatus(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  // No default: `queryGsi` (via `runQuery`) drains the whole partition when
  // `limit` is `undefined`, and `InMemoryTableClient` returns everything
  // unsliced for the same input. A sentinel like Number.MAX_SAFE_INTEGER
  // would instead reach DynamoDB's real `Limit` parameter, which rejects
  // anything that large with a ValidationException -- a production-only
  // failure no in-memory test would catch. The backfill sweep is the caller
  // that needs the drain; every other caller already passes an explicit page
  // size, so widening this changes no existing behaviour.
  limit?: number,
): Promise<CaseRefListing> {
  const metaItems = await context.table.queryGsi(
    "GSI1",
    caseStatusGsi1Pk(tenantId, caseStatus),
    { limit, scanForward: false },
  );
  const storedCaseRefs: StoredCaseRef[] = [];
  const unreadableCaseIds: string[] = [];
  for (const metaItem of metaItems) {
    if (metaItem["SK"] !== META_SORT_KEY) continue;
    const storedCaseRef = metaItem["caseRef"];
    const caseId = caseIdOfMetaItem(metaItem);
    if (typeof storedCaseRef === "string" && storedCaseRef.length > 0 && caseId !== undefined) {
      storedCaseRefs.push({ caseRef: storedCaseRef, caseId });
      continue;
    }
    // The index names a case whose META item carries no ref (or nothing that
    // identifies it at all). Report the caseId if the item still knows it,
    // and the storage key otherwise — it is all an operator has to find the
    // row with, and String(undefined) would report the literal id "undefined".
    unreadableCaseIds.push(caseId ?? metaItem.PK);
    console.warn(
      `CRM case META item in tenant ${tenantId} carries no usable caseRef: ${metaItem.PK}`,
    );
  }
  return { storedCaseRefs, unreadableCaseIds };
}

/**
 * The fields a "how many cases" question can group and count by. Every one of
 * these lives directly on the case META item -- `writeCase` (`caseStore.ts`)
 * spreads `...caseBody` onto it -- so counting never needs a case reassembled.
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
 * `listCasesByStatus` cannot answer a "how many" question cheaply: it hands
 * every META item to `readCase`, which costs one strongly-consistent GetItem
 * plus one strongly-consistent Query per case -- on the real ledger, 7,156
 * partition reads to answer a question the GSI1 query per status already
 * answered on its own. Every field this counts by is already sitting on the
 * META item that query returns, so the GSI1 query -- one per `CASE_STATUSES`
 * entry -- is the entire cost. No `context.table.get` or `context.table.query`
 * (the base-table, partition-scoped reads) ever runs.
 *
 * A META item whose counted field is missing or not a string is named in
 * `uncountedCaseIds` rather than counted under a bogus `"undefined"` key or
 * silently skipped -- the same rule `listCaseRefsByStatus` follows for a
 * missing `caseRef`.
 */
export async function countCasesByField(
  context: AppContext,
  tenantId: string,
  groupByField: CaseCountGroupByField,
): Promise<CaseCountByField> {
  const counts: Record<string, number> = {};
  const uncountedCaseIds: string[] = [];
  let total = 0;

  for (const caseStatus of crm.CASE_STATUSES) {
    const metaItems = await context.table.queryGsi("GSI1", caseStatusGsi1Pk(tenantId, caseStatus));
    for (const metaItem of metaItems) {
      if (metaItem["SK"] !== META_SORT_KEY) continue;
      const groupFieldValue = metaItem[groupByField];
      if (typeof groupFieldValue === "string" && groupFieldValue.length > 0) {
        counts[groupFieldValue] = (counts[groupFieldValue] ?? 0) + 1;
        total += 1;
        continue;
      }
      uncountedCaseIds.push(caseIdOfMetaItem(metaItem) ?? metaItem.PK);
    }
  }

  return { counts, total, uncountedCaseIds };
}

export async function listCasesByPartner(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  limit = 50,
): Promise<CaseListing> {
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
 * row is skipped, logged with its caseId, and named in `unreadableCaseIds` so
 * the caller can say something happened. Only CorruptRecordError is swallowed;
 * every other failure still propagates.
 */
async function loadCasesFromMetaItems(
  context: AppContext,
  tenantId: string,
  metaItems: TableItem[],
): Promise<CaseListing> {
  const caseMetaItems = metaItems.filter((metaItem) => metaItem["SK"] === META_SORT_KEY);
  const { records, unreadableRecordIds } = await collectReadableRecords(
    caseMetaItems,
    async (metaItem) => {
      const caseId = caseIdOfMetaItem(metaItem);
      if (caseId === undefined) {
        // Neither the body nor the partition key names a case — a row repaired
        // into a partition that is not a case partition at all looks like this.
        // Report the storage key: it is all an operator has to find the row
        // with, and String(undefined) used to turn this into the literal id
        // "undefined", which reads back as no case and left the loop wordless.
        throw corruptRecord("Case", metaItem.PK, "the row names no caseId at all");
      }
      const loadedCase = await readCase(context, tenantId, caseId);
      if (loadedCase) return loadedCase;
      // The index named a case whose partition holds no META item — a deleted
      // case still in an eventually consistent GSI, or an index entry pointing
      // at the wrong id. Dropping it here is what made the disappearance silent.
      throw corruptRecord(
        "Case",
        caseId,
        "the status index names it but its partition holds no case",
      );
    },
    { entityDescription: "CRM case", scopeDescription: `tenant ${tenantId}` },
  );
  return { cases: records, unreadableCaseIds: unreadableRecordIds };
}

/**
 * The caseId a META item is stored under. The body carries it, but a
 * half-written or hand-repaired item may not, and the partition key always
 * does — so the key is the fallback rather than the string "undefined".
 */
function caseIdOfMetaItem(metaItem: TableItem): string | undefined {
  const caseIdFromBody = metaItem["caseId"];
  if (typeof caseIdFromBody === "string" && caseIdFromBody.length > 0) {
    return caseIdFromBody;
  }
  return caseIdFromPartitionKey(metaItem.PK);
}
