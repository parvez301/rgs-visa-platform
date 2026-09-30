import { COUNTRY_PRODUCTS, crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { resolveCaseTravellers } from "./caseTravellers";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";

/** Desk-facing words for status emails — keep in sync with admin CASE_STATUS_LABELS. */
const CASE_STATUS_EMAIL_LABELS: Record<crm.CaseStatus, string> = {
  NEW: "New",
  DOCS_UNDER_REVIEW: "Documents Under Review",
  ADDITIONAL_DOCS_REQUIRED: "Additional Documents Required",
  READY_FOR_SUBMISSION: "Ready for Submission",
  APPOINTMENT_SET: "Appointment set",
  SUBMITTED: "Submitted",
  UNDER_PROCESS: "Under Embassy Processing",
  PASSPORT_RECEIVED: "Passport Received",
  DECIDED: "Decided",
  VISA_GRANTED: "Visa Granted",
  VISA_REFUSED: "Visa Refused",
  CLOSED: "Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};

/** Keep in sync with admin OUTCOME_LABELS. */
const OUTCOME_EMAIL_LABELS: Record<crm.ApplicantOutcome, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-03` → `03 Oct 2026`. String arithmetic only: no Date, no timezone. */
function formatDateForEmail(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  const monthIndex = Number(month) - 1;
  return `${day} ${MONTH_ABBREVIATIONS[monthIndex] ?? month} ${year}`;
}

function countryNameOf(destinationCountry: string): string {
  return (
    COUNTRY_PRODUCTS.find((product) => product.countryCode === destinationCountry)?.countryName ??
    destinationCountry
  );
}

/**
 * `REF – STATUS – NAME – COUNTRY`: the desk's own filing convention for
 * status mail (feedback round 1, 2026-09-24). NAME is the group name when the
 * case has one (spec 2026-09-25 §5.2), otherwise the first applicant plus a
 * head-count for the rest. Built exactly once here so the exported async
 * wrapper below and `notifyOnCaseStatusChange` can never drift apart (fix
 * round 1, 2026-09-25).
 */
function subjectFor(crmCase: crm.CrmCase, toStatus: crm.CaseStatus, travellers: crm.CaseTravellerMap): string {
  return `${crmCase.caseRef} – ${CASE_STATUS_EMAIL_LABELS[toStatus]} – ${subjectName(crmCase, travellers)} – ${countryNameOf(crmCase.destinationCountry)}`;
}

/** Async wrapper around `subjectFor` for callers that only have a caseId's applicants to resolve. */
export async function buildStatusEmailSubject(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  toStatus: crm.CaseStatus,
): Promise<string> {
  const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
  return subjectFor(crmCase, toStatus, travellers);
}

function subjectName(crmCase: crm.CrmCase, travellers: crm.CaseTravellerMap): string {
  if (crmCase.groupName !== undefined) return crmCase.groupName;
  const firstApplicant = crmCase.applicants[0];
  if (firstApplicant === undefined) return crm.UNNAMED_APPLICANT;
  const firstName = crm.displayApplicantName(travellers, firstApplicant);
  const extraApplicantCount = crmCase.applicants.length - 1;
  return extraApplicantCount > 0 ? `${firstName} +${extraApplicantCount}` : firstName;
}

/**
 * Plain text, in the order spec 2026-09-25 §5.3 fixes. The "Applicants:" block
 * appears only for a group (a group name, or more than one applicant); the
 * appointment line only when a date is set. Vendor and client get this same
 * text (D6).
 */
export function buildStatusEmailBody(
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  travellers: crm.CaseTravellerMap,
): string {
  const lines: string[] = [
    "Hello,",
    "",
    `Case ${crmCase.caseRef} (destination ${countryNameOf(crmCase.destinationCountry)}) is now ${CASE_STATUS_EMAIL_LABELS[toStatus]} (was ${CASE_STATUS_EMAIL_LABELS[fromStatus]}).`,
  ];
  const isGroup = crmCase.groupName !== undefined || crmCase.applicants.length > 1;
  if (isGroup) {
    lines.push("", "Applicants:");
    for (const applicant of crmCase.applicants) {
      lines.push(
        `  ${crm.displayApplicantRef(crmCase.caseRef, crmCase.applicants.length, applicant)} – ${crm.displayApplicantName(travellers, applicant)} – ${OUTCOME_EMAIL_LABELS[applicant.outcome]}`,
      );
    }
  }
  if (crmCase.appointmentDate !== undefined) {
    lines.push("", `Appointment date: ${formatDateForEmail(crmCase.appointmentDate)}`);
  }
  lines.push("", "— Rays Global Services");
  return lines.join("\n");
}

/**
 * Best-effort mail to the vendor (partner) and the client when a case status
 * moves. Each recipient is independent: no address → no send and no event for
 * that recipient only. Send failures are the email adapter's problem
 * (`BestEffortEmailSender` in production); this module records the matching
 * *_NOTIFIED event after each send attempt returns.
 */
export async function notifyOnCaseStatusChange(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<void> {
  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
  const subject = subjectFor(crmCase, toStatus, travellers);
  const bodyText = buildStatusEmailBody(crmCase, fromStatus, toStatus, travellers);

  const recipients: { eventType: "PARTNER_NOTIFIED" | "CLIENT_NOTIFIED"; toAddress: string | undefined }[] = [
    { eventType: "PARTNER_NOTIFIED", toAddress: partner.contactEmail },
    { eventType: "CLIENT_NOTIFIED", toAddress: crmCase.clientEmail },
  ];
  for (const recipient of recipients) {
    if (recipient.toAddress === undefined || recipient.toAddress.trim() === "") continue;
    await context.email.send({ toAddress: recipient.toAddress, subject, bodyText });
    await recordCrmEvent(context, tenantId, crmCase.caseId, recipient.eventType, actorEmail, {
      channel: "email",
      toAddress: recipient.toAddress,
      fromStatus,
      toStatus,
    });
  }
}
