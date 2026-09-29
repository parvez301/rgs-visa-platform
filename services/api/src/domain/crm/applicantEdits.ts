import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { assertApplicantRefNosDistinct, claimNewRefs, releaseRefKeys, staleRefKeys } from "./refClaims";
import { assertPassportFreeForTraveller, getTravellerOrThrow, updateTravellerDetails } from "./travellers";

/**
 * Custody states in which the passport is physically with RGS or on its way
 * somewhere on RGS's behalf. Removing that person from the case would lose
 * track of a passport we are holding.
 */
const PASSPORT_HELD_CUSTODIES: readonly crm.CustodyStatus[] = ["WITH_RGS", "AT_EMBASSY", "IN_TRANSIT"];

export interface UpdateApplicantInput {
  fullName?: string;
  passportNumber?: string | null;
  refNo?: string | null;
}

export interface AddApplicantInput {
  travellerId: string;
  passportNumber?: string;
  refNo?: string;
}

/** The one write path for an applicant-list change: parse, claim, write, release. */
async function persistApplicantChange(
  context: AppContext,
  tenantId: string,
  currentCase: crm.CrmCase,
  nextApplicants: crm.CaseApplicant[],
): Promise<crm.CrmCase> {
  let updatedCase: crm.CrmCase;
  try {
    updatedCase = crm.CrmCaseSchema.parse({
      ...currentCase,
      applicants: nextApplicants,
      updatedAt: context.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid case");
    }
    throw error;
  }
  assertApplicantRefNosDistinct(updatedCase);
  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, currentCase.caseId, currentCase, updatedCase);
  try {
    await writeCase(context, updatedCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, currentCase.caseId, newlyClaimedRefKeys);
    throw error;
  }
  await releaseRefKeys(context, tenantId, currentCase.caseId, staleRefKeys(currentCase, updatedCase));
  return updatedCase;
}

function findApplicantIndexOrThrow(crmCase: crm.CrmCase, applicantRef: string): number {
  const applicantIndex = crmCase.applicants.findIndex((applicant) => applicant.applicantRef === applicantRef);
  if (applicantIndex === -1) throw notFound("Applicant");
  return applicantIndex;
}

export async function updateApplicantDetails(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantRef: string,
  input: UpdateApplicantInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = findApplicantIndexOrThrow(currentCase, applicantRef);
  const currentApplicant = currentCase.applicants[applicantIndex]!;
  const traveller = await getTravellerOrThrow(context, tenantId, currentApplicant.travellerId);

  const changedFieldNames: string[] = [];
  const trimmedFullName = input.fullName?.trim();
  const fullNameChanging = trimmedFullName !== undefined && trimmedFullName !== traveller.fullName;
  if (fullNameChanging) changedFieldNames.push("fullName");
  const nextPassportNumber =
    input.passportNumber === undefined
      ? currentApplicant.passportNumber
      : (input.passportNumber?.trim().toUpperCase() || undefined);
  const passportChanging = nextPassportNumber !== currentApplicant.passportNumber;
  if (passportChanging) changedFieldNames.push("passportNumber");
  const nextRefNo = input.refNo === undefined ? currentApplicant.refNo : (input.refNo?.trim() || undefined);
  const refNoChanging = nextRefNo !== currentApplicant.refNo;
  if (refNoChanging) changedFieldNames.push("refNo");

  if (changedFieldNames.length === 0) return currentCase;

  // The passport clash is the one refusal that comes from outside this case,
  // so it is checked (no write) before anything is touched. The traveller
  // itself is written LAST, after the case and its REF claims are safely
  // persisted: a 400/409 from the case path must not leave the traveller
  // changed and the case not (passport drift).
  if (passportChanging && nextPassportNumber !== undefined && nextPassportNumber !== traveller.passportNumber) {
    await assertPassportFreeForTraveller(context, tenantId, currentApplicant.travellerId, nextPassportNumber);
  }

  const { passportNumber: _previousPassport, refNo: _previousRefNo, ...applicantBase } = currentApplicant;
  const nextApplicant: crm.CaseApplicant = {
    ...applicantBase,
    ...(nextPassportNumber !== undefined ? { passportNumber: nextPassportNumber } : {}),
    ...(nextRefNo !== undefined ? { refNo: nextRefNo } : {}),
  };
  const nextApplicants = currentCase.applicants.map((applicant, index) =>
    index === applicantIndex ? nextApplicant : applicant,
  );
  // Always rewritten, even for a name-only change: writeCase recomputes the
  // Ledger's search haystack from the traveller names.
  const updatedCase = await persistApplicantChange(context, tenantId, currentCase, nextApplicants);
  if (fullNameChanging || passportChanging) {
    await updateTravellerDetails(context, tenantId, currentApplicant.travellerId, {
      ...(fullNameChanging ? { fullName: trimmedFullName } : {}),
      ...(passportChanging ? { passportNumber: nextPassportNumber ?? null } : {}),
    });
    // writeCase stamped searchText from the traveller as it was BEFORE this
    // write; stamp again so the Ledger finds the new name/passport. Idempotent
    // and claim-free: a failure here leaves case and traveller consistent,
    // only the haystack stale until the next write.
    await writeCase(context, updatedCase);
  }
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_UPDATED", actorEmail, {
    applicantRef,
    changedFields: changedFieldNames.join(","),
  });
  return updatedCase;
}

export async function addApplicant(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: AddApplicantInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  await getTravellerOrThrow(context, tenantId, input.travellerId);
  const usedApplicantRefs = new Set(currentCase.applicants.map((applicant) => applicant.applicantRef));
  let applicantNumber = currentCase.applicants.length + 1;
  while (usedApplicantRefs.has(`A${applicantNumber}`)) applicantNumber += 1;
  const applicantRef = `A${applicantNumber}`;
  const trimmedRefNo = input.refNo?.trim();
  const newApplicant: crm.CaseApplicant = {
    applicantRef,
    travellerId: input.travellerId,
    ...(input.passportNumber !== undefined ? { passportNumber: input.passportNumber.trim().toUpperCase() } : {}),
    ...(trimmedRefNo ? { refNo: trimmedRefNo } : {}),
    custody: "NOT_HELD",
    outcome: "PENDING",
  };
  const updatedCase = await persistApplicantChange(context, tenantId, currentCase, [
    ...currentCase.applicants,
    newApplicant,
  ]);
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_ADDED", actorEmail, { applicantRef });
  return updatedCase;
}

export async function removeApplicant(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantRef: string,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = findApplicantIndexOrThrow(currentCase, applicantRef);
  if (currentCase.applicants.length === 1) {
    throw conflict("A case needs at least one applicant. Add the right person before removing this one.");
  }
  const applicantToRemove = currentCase.applicants[applicantIndex]!;
  if (PASSPORT_HELD_CUSTODIES.includes(applicantToRemove.custody)) {
    throw conflict("This person's passport is with us. Return it (custody) before removing them from the case.");
  }
  const updatedCase = await persistApplicantChange(
    context,
    tenantId,
    currentCase,
    currentCase.applicants.filter((_, index) => index !== applicantIndex),
  );
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_REMOVED", actorEmail, { applicantRef });
  return updatedCase;
}
