import type { CaseStatus } from "./statuses";

/** Default RGS desk phone footer until a tenant setting exists (spec §4.2). */
export const STATUS_EMAIL_PHONE = "+91 98180 67432 / 011-41011617";

/** Subject status segment — keep in sync with admin `CASE_STATUS_LABELS`. */
const STATUS_EMAIL_SUBJECT_LABELS: Record<CaseStatus, string> = {
  NEW: "Application Received",
  DOCS_UNDER_REVIEW: "Documents Under Review",
  ADDITIONAL_DOCS_REQUIRED: "Additional Documents Required",
  READY_FOR_SUBMISSION: "Ready for Submission",
  APPOINTMENT_SET: "Appointment Booked",
  ONLINE_SUBMISSION_DONE: "Online Submission Done",
  SUBMITTED: "Application Submitted",
  UNDER_PROCESS: "Under Embassy Processing",
  PASSPORT_RECEIVED: "Passport Received",
  DECIDED: "Decision Received",
  VISA_GRANTED: "Visa Granted",
  VISA_REFUSED: "Visa Refused",
  CLOSED: "Application Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};

const FOOTER = ["Regards,", "Rays Global Services (RGS)", "📞 {{phone}}"].join("\n");

function defaultSubject(caseStatus: CaseStatus): string {
  const label = STATUS_EMAIL_SUBJECT_LABELS[caseStatus];
  return `{{applicationId}} – ${label} – {{clientName}} – {{countryVisaType}}`;
}

function offRampBody(plainStatusWords: string): string {
  return [
    "Dear {{clientName}},",
    "",
    `Your application {{applicationId}} has been marked as ${plainStatusWords}.`,
    "",
    FOOTER,
  ].join("\n");
}

const DEFAULT_BODIES: Record<CaseStatus, string> = {
  NEW: [
    "Dear {{clientName}},",
    "",
    "Thank you for choosing Rays Global Services (RGS).",
    "",
    "Your visa application for {{countryVisaType}} has been successfully registered in our system.",
    "",
    "Application ID: {{applicationId}}",
    "",
    "Our team will review the documents and update you regarding the next step.",
    "",
    FOOTER,
  ].join("\n"),

  DOCS_UNDER_REVIEW: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application is currently under document review by our RGS team.",
    "",
    "We will contact you if any additional information or documents are required.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  ADDITIONAL_DOCS_REQUIRED: [
    "Dear {{clientName}},",
    "",
    "Additional documents/information are required to proceed with your {{countryVisaType}} application.",
    "",
    "Please check your RGS portal / contact our team for the required documents.",
    "",
    "Application ID: {{applicationId}}",
    "",
    "Kindly provide the requested documents at the earliest to avoid unnecessary delays.",
    "",
    FOOTER,
  ].join("\n"),

  READY_FOR_SUBMISSION: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application is ready for submission. Our team will coordinate the appointment/submission process and keep you updated.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  APPOINTMENT_SET: [
    "Dear {{clientName}},",
    "",
    "Your visa appointment for {{countryVisaType}} has been confirmed.",
    "",
    // One token per line: the renderer drops a line whose tokens are all blank,
    // so an unset date, or the reserved time/centre, never leaves "at  at ." behind.
    "Appointment date: {{appointmentDate}}",
    "Appointment time: {{appointmentTime}}",
    "Centre: {{centre}}",
    "",
    "Please ensure you carry all required original documents.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  ONLINE_SUBMISSION_DONE: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application has been submitted online. We will update you when further information is available.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  SUBMITTED: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application has been successfully submitted. Your application is now under processing by the concerned authorities. We will update you when further information is available.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  UNDER_PROCESS: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application is currently under processing with the concerned Embassy/Consulate/Visa Centre. Processing time may vary depending on the authorities. We will keep you informed of any update.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  PASSPORT_RECEIVED: [
    "Dear {{clientName}},",
    "",
    "We have received your passport/document from the concerned visa authority. Our team is processing the next step. Please await confirmation regarding collection/delivery.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  DECIDED: [
    "Dear {{clientName}},",
    "",
    "A decision has been received on your {{countryVisaType}} application. Please contact/visit RGS for the next steps and document collection.",
    "",
    "Application ID: {{applicationId}}",
    "",
    "{{applicantsBlock}}",
    "",
    FOOTER,
  ].join("\n"),

  VISA_GRANTED: [
    "Dear {{clientName}},",
    "",
    "🎉 Congratulations! Your {{countryVisaType}} visa has been granted.",
    "",
    "Please contact RGS for passport collection/delivery and further travel guidance.",
    "",
    "Thank you for choosing Rays Global Services (RGS).",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  VISA_REFUSED: [
    "Dear {{clientName}},",
    "",
    "A decision has been received on your {{countryVisaType}} application. Unfortunately, the application has not been granted.",
    "",
    "Please contact our team to discuss the decision letter and available next steps.",
    "",
    "Application ID: {{applicationId}}",
    "",
    FOOTER,
  ].join("\n"),

  CLOSED: [
    "Dear {{clientName}},",
    "",
    "Your {{countryVisaType}} application {{applicationId}} has been marked as closed in our system.",
    "",
    "For any clarification or further assistance, please contact RGS.",
    "",
    FOOTER,
  ].join("\n"),

  NOT_SUBMITTED: offRampBody("not submitted"),
  WITHDRAWN: offRampBody("withdrawn"),
  DUPLICATE: offRampBody("duplicate"),
};

export function defaultStatusEmailTemplate(
  caseStatus: CaseStatus,
): { subject: string; body: string; enabled: boolean } {
  return {
    subject: defaultSubject(caseStatus),
    body: DEFAULT_BODIES[caseStatus],
    enabled: true,
  };
}
