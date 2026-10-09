import { COUNTRY_PRODUCTS, crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { CorruptRecordError } from "../../lib/errors";
import { resolveCaseTravellers } from "./caseTravellers";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";
import { getStatusEmailTemplate } from "./statusEmailTemplates";

/** Keep in sync with admin VISA_TYPE_LABELS. */
const VISA_TYPE_EMAIL_LABELS: Record<crm.VisaType, string> = {
  TOURIST: "Tourist",
  BUSINESS: "Business",
  EVISA_TOURIST: "e-Visa (tourist)",
  B1_B2: "B1/B2",
  FAMILY_VISIT: "Family visit",
  DEPENDENT: "Dependent",
  STUDY: "Study",
  WORK: "Work",
  SEAMAN: "Seaman",
  RELATIVE: "Relative",
  TRADE_FAIR: "Trade fair",
  SPORTS: "Sports",
  TRANSIT: "Transit",
  MDAC: "MDAC",
  STP: "STP",
  STR: "STR",
  F_VISA: "F visa",
  VEVO: "VEVO",
  E_VISA: "e-Visa",
  OTHER: "Other",
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

function isGroupCase(crmCase: crm.CrmCase): boolean {
  return crmCase.groupName !== undefined || crmCase.applicants.length > 1;
}

function clientNameOf(crmCase: crm.CrmCase, travellers: crm.CaseTravellerMap): string {
  if (crmCase.groupName !== undefined) return crmCase.groupName;
  const firstApplicant = crmCase.applicants[0];
  if (firstApplicant === undefined) return crm.UNNAMED_APPLICANT;
  return crm.displayApplicantName(travellers, firstApplicant);
}

function countryVisaTypeOf(crmCase: crm.CrmCase): string {
  const countryName = countryNameOf(crmCase.destinationCountry);
  return crmCase.visaType === undefined ? countryName : `${countryName} ${VISA_TYPE_EMAIL_LABELS[crmCase.visaType]}`;
}

/** One `REF – name – outcome` line per applicant; empty for an individual case. */
function applicantsBlockOf(crmCase: crm.CrmCase, travellers: crm.CaseTravellerMap): string {
  if (!isGroupCase(crmCase)) return "";
  return crmCase.applicants
    .map(
      (applicant) =>
        `${crm.displayApplicantRef(crmCase.caseRef, crmCase.applicants.length, applicant)} – ${crm.displayApplicantName(travellers, applicant)} – ${OUTCOME_EMAIL_LABELS[applicant.outcome]}`,
    )
    .join("\n");
}

/**
 * Spec 2026-09-30 §4.2. The vars listed in `crm.STATUS_EMAIL_UNPOPULATED_VARS`
 * stay blank until the case has fields to feed them; `statusNotifyVars.test.ts`
 * pins that this builder and that list agree, so the admin preview cannot
 * promise the desk a value real mail leaves out.
 */
export function buildStatusEmailVars(
  crmCase: crm.CrmCase,
  travellers: crm.CaseTravellerMap,
): crm.StatusEmailVars {
  return {
    clientName: clientNameOf(crmCase, travellers),
    countryVisaType: countryVisaTypeOf(crmCase),
    applicationId: crmCase.caseRef,
    appointmentDate: crmCase.appointmentDate === undefined ? "" : formatDateForEmail(crmCase.appointmentDate),
    appointmentTime: "",
    centre: "",
    applicantsBlock: applicantsBlockOf(crmCase, travellers),
    phone: crm.STATUS_EMAIL_PHONE,
  };
}

/**
 * Renders the announced status's template and sends it to the vendor and the
 * client. A missing DB row uses the same built-in default the admin list shows
 * (CRM-109: unseeded envs were silent while the UI looked "enabled"). A
 * disabled or corrupt template still sends nothing. Each recipient is
 * independent: no address → no send and no event for that recipient only. Send
 * failures are the email adapter's problem (`BestEffortEmailSender` in
 * production); the matching *_NOTIFIED event is recorded after each send
 * attempt returns.
 */
async function sendStatusTemplateMail(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  announcedStatus: crm.CaseStatus,
  actorEmail: string,
  eventMeta: Record<string, string>,
): Promise<void> {
  let template: crm.StatusEmailTemplate | undefined;
  try {
    template = await getStatusEmailTemplate(context, tenantId, announcedStatus);
  } catch (error) {
    // A corrupt template row is an ops problem, not the desk's: the status
    // change already succeeded, so treat it like a missing template and stay
    // silent rather than turning a 409 into a failed status change.
    if (!(error instanceof CorruptRecordError)) throw error;
    console.warn(
      `Status email skipped for case ${crmCase.caseId}: template for ${announcedStatus} is corrupt (${error.message})`,
    );
    return;
  }
  if (template === undefined) {
    const defaults = crm.defaultStatusEmailTemplate(announcedStatus);
    template = {
      tenantId,
      caseStatus: announcedStatus,
      ...defaults,
      updatedAt: "1970-01-01T00:00:00.000Z",
      updatedBy: "",
    };
  }
  if (!template.enabled) return;

  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
  const vars = buildStatusEmailVars(crmCase, travellers);
  const subject = crm.renderStatusEmail(template.subject, vars);
  const bodyText = crm.renderStatusEmail(template.body, vars);

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
      ...eventMeta,
    });
  }
}

/** Mail for a status move: the `toStatus` template, events carry `fromStatus` and `toStatus`. */
export async function notifyOnCaseStatusChange(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<void> {
  await sendStatusTemplateMail(context, tenantId, crmCase, toStatus, actorEmail, {
    fromStatus,
    toStatus,
  });
}

/**
 * Mail for a brand-new case: the template of the status it was created in
 * (Application Received for NEW). Sent once, here; the first real status move
 * afterwards uses that status's own template. Events say `reason: "CREATE"`
 * instead of a transition that never happened.
 */
export async function notifyOnCaseCreated(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  actorEmail: string,
): Promise<void> {
  await sendStatusTemplateMail(context, tenantId, crmCase, crmCase.caseStatus, actorEmail, {
    toStatus: crmCase.caseStatus,
    reason: "CREATE",
  });
}
