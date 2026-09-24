import { COUNTRY_PRODUCTS, type crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";
import { getTravellerOrThrow } from "./travellers";

/** Desk-facing words for status emails — keep in sync with admin CASE_STATUS_LABELS. */
const CASE_STATUS_EMAIL_LABELS: Record<crm.CaseStatus, string> = {
  NEW: "New",
  IN_PROGRESS: "In progress",
  APPOINTMENT_SET: "Appointment set",
  SUBMITTED: "Submitted",
  DECIDED: "Decided",
  CLOSED: "Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};

/**
 * `REF – STATUS – NAME – COUNTRY`: the desk's own filing convention for
 * status mail (feedback round 1, 2026-09-24), so a partner's inbox sorts and
 * searches the way their paper files do. NAME is the first applicant plus a
 * head-count for the rest; COUNTRY is the destination's full name, falling
 * back to the ISO code when the catalogue has no entry for it.
 */
export async function buildStatusEmailSubject(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  toStatus: crm.CaseStatus,
): Promise<string> {
  const firstApplicant = crmCase.applicants[0];
  const firstTraveller =
    firstApplicant === undefined
      ? undefined
      : await getTravellerOrThrow(context, tenantId, firstApplicant.travellerId);
  const extraApplicantCount = crmCase.applicants.length - 1;
  const applicantName =
    firstTraveller === undefined
      ? "Unnamed applicant"
      : extraApplicantCount > 0
        ? `${firstTraveller.fullName} +${extraApplicantCount}`
        : firstTraveller.fullName;
  const countryName =
    COUNTRY_PRODUCTS.find((product) => product.countryCode === crmCase.destinationCountry)?.countryName ??
    crmCase.destinationCountry;
  return `${crmCase.caseRef} – ${CASE_STATUS_EMAIL_LABELS[toStatus]} – ${applicantName} – ${countryName}`;
}

/**
 * Best-effort partner email when a case status moves. No contact email → no
 * send and no event. Send failures are the email adapter's problem
 * (`BestEffortEmailSender` in production); this module always records a
 * PARTNER_NOTIFIED event after a successful send attempt returns.
 */
export async function notifyPartnerOfCaseStatusChange(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<void> {
  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  if (partner.contactEmail === undefined || partner.contactEmail.trim() === "") {
    return;
  }

  const fromLabel = CASE_STATUS_EMAIL_LABELS[fromStatus];
  const toLabel = CASE_STATUS_EMAIL_LABELS[toStatus];
  await context.email.send({
    toAddress: partner.contactEmail,
    subject: await buildStatusEmailSubject(context, tenantId, crmCase, toStatus),
    bodyText: [
      `Hello,`,
      ``,
      `Case ${crmCase.caseRef} (destination ${crmCase.destinationCountry}) is now ${toLabel} (was ${fromLabel}).`,
      ``,
      `— Rays Global Services`,
    ].join("\n"),
  });

  await recordCrmEvent(context, tenantId, crmCase.caseId, "PARTNER_NOTIFIED", actorEmail, {
    channel: "email",
    toAddress: partner.contactEmail,
    fromStatus,
    toStatus,
  });
}
