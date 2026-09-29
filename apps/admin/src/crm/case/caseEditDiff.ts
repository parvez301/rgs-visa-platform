import { crm } from "@rgs/shared";
import type { CaseView, UpdateApplicantBody, UpdateCaseDetailsBody } from "../api/crmClient";

export interface ApplicantDraftRow {
  /** Absent for a person added in this edit. */
  applicantRef?: string;
  fullName: string;
  passportNumber: string;
  refNo: string;
}

/** Every editable field as the form holds it: strings, "" meaning empty. */
export interface CaseDraft {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType: crm.VisaType | "";
  entryType: crm.EntryType | "";
  processing: crm.ProcessingSpeed | "";
  receivedDate: string;
  submissionDate: string;
  appointmentDate: string;
  expectedCollectionDate: string;
  remarks: string;
  groupName: string;
  clientEmail: string;
  applicants: ApplicantDraftRow[];
}

export function draftFromCase(caseView: CaseView): CaseDraft {
  return {
    caseRef: caseView.caseRef,
    caseType: caseView.caseType,
    partnerId: caseView.partnerId,
    destinationCountry: caseView.destinationCountry,
    visaType: caseView.visaType ?? "",
    entryType: caseView.entryType ?? "",
    processing: caseView.processing ?? "",
    receivedDate: caseView.receivedDate,
    submissionDate: caseView.submissionDate ?? "",
    appointmentDate: caseView.appointmentDate ?? "",
    expectedCollectionDate: caseView.expectedCollectionDate ?? "",
    remarks: caseView.remarks ?? "",
    groupName: caseView.groupName ?? "",
    clientEmail: caseView.clientEmail ?? "",
    applicants: caseView.applicants.map((applicant) => ({
      applicantRef: applicant.applicantRef,
      fullName: caseView.travellers?.[applicant.travellerId]?.fullName ?? "",
      passportNumber: applicant.passportNumber ?? "",
      refNo: applicant.refNo ?? "",
    })),
  };
}

/** Required on the case: a blank here is a validation problem, never a clear. */
const REQUIRED_CASE_FIELDS = ["caseRef", "caseType", "partnerId", "destinationCountry", "receivedDate"] as const;
/** Optional on the case: a blank is sent as null, which the server reads as "clear". */
const CLEARABLE_CASE_FIELDS = [
  "visaType",
  "entryType",
  "processing",
  "submissionDate",
  "appointmentDate",
  "expectedCollectionDate",
  "remarks",
  "groupName",
  "clientEmail",
] as const;

export function buildCaseDetailsPatch(original: CaseDraft, edited: CaseDraft): UpdateCaseDetailsBody {
  const patch: Record<string, string | null> = {};
  for (const fieldName of REQUIRED_CASE_FIELDS) {
    const editedValue = edited[fieldName].trim();
    if (editedValue !== original[fieldName].trim()) patch[fieldName] = editedValue;
  }
  for (const fieldName of CLEARABLE_CASE_FIELDS) {
    const editedValue = edited[fieldName].trim();
    if (editedValue === original[fieldName].trim()) continue;
    patch[fieldName] = editedValue === "" ? null : editedValue;
  }
  return patch as UpdateCaseDetailsBody;
}

export function planApplicantChanges(
  original: CaseDraft,
  edited: CaseDraft,
): { updates: { applicantRef: string; body: UpdateApplicantBody }[]; additions: ApplicantDraftRow[]; removals: string[] } {
  const originalRowsByRef = new Map(
    original.applicants.map((applicantRow) => [applicantRow.applicantRef, applicantRow] as const),
  );
  const keptApplicantRefs = new Set<string>();
  const updates: { applicantRef: string; body: UpdateApplicantBody }[] = [];
  const additions: ApplicantDraftRow[] = [];

  for (const editedRow of edited.applicants) {
    if (editedRow.applicantRef === undefined) {
      additions.push(editedRow);
      continue;
    }
    keptApplicantRefs.add(editedRow.applicantRef);
    const originalRow = originalRowsByRef.get(editedRow.applicantRef);
    if (originalRow === undefined) continue;
    const body: UpdateApplicantBody = {};
    if (editedRow.fullName.trim() !== originalRow.fullName.trim()) body.fullName = editedRow.fullName.trim();
    const editedPassport = editedRow.passportNumber.trim().toUpperCase();
    if (editedPassport !== originalRow.passportNumber.trim().toUpperCase()) {
      body.passportNumber = editedPassport === "" ? null : editedPassport;
    }
    const editedRefNo = editedRow.refNo.trim();
    if (editedRefNo !== originalRow.refNo.trim()) body.refNo = editedRefNo === "" ? null : editedRefNo;
    if (Object.keys(body).length > 0) updates.push({ applicantRef: editedRow.applicantRef, body });
  }

  const removals = original.applicants
    .map((applicantRow) => applicantRow.applicantRef)
    .filter((applicantRef): applicantRef is string => applicantRef !== undefined && !keptApplicantRefs.has(applicantRef));
  return { updates, additions, removals };
}
