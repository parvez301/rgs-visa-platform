import type { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";

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
    subject: `Case ${crmCase.caseRef} status update: ${toLabel}`,
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
