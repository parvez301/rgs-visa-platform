import { crm } from "@rgs/shared";

interface PlaceholderSample {
  description: string;
  /** "" for a var the server has no case field for — see `omittedFromMail`. */
  sample: string;
}

const PLACEHOLDER_SAMPLES: Record<crm.StatusEmailVarName, PlaceholderSample> = {
  clientName: { description: "Client or group name", sample: "Anil Sharma" },
  countryVisaType: { description: "Destination and visa type", sample: "Japan Tourist Visa" },
  applicationId: { description: "The case REF", sample: "38017" },
  appointmentDate: { description: "Appointment date", sample: "12 Oct 2026" },
  appointmentTime: { description: "Appointment time", sample: "" },
  centre: { description: "Appointment centre", sample: "" },
  applicantsBlock: {
    description: "Numbered list of applicants",
    sample: "1. Anil Sharma\n2. Sita Sharma",
  },
  phone: { description: "RGS desk phone", sample: crm.STATUS_EMAIL_PHONE },
};

/**
 * The placeholders a template may use, in the order the server declares them.
 * Names come from `crm.STATUS_EMAIL_VAR_NAMES` so the editor can never
 * advertise a token the server does not fill. `omittedFromMail` marks the vars
 * no case field feeds yet: their samples are blank, and because the preview
 * runs the server's own renderer, a line holding only those disappears here
 * exactly as it will in the client's inbox.
 */
export const STATUS_EMAIL_PLACEHOLDERS = crm.STATUS_EMAIL_VAR_NAMES.map((varName) => ({
  name: varName,
  description: PLACEHOLDER_SAMPLES[varName].description,
  sample: PLACEHOLDER_SAMPLES[varName].sample,
  omittedFromMail: crm.STATUS_EMAIL_UNPOPULATED_VARS.includes(varName),
}));

const SAMPLE_VARS: crm.StatusEmailVars = Object.fromEntries(
  STATUS_EMAIL_PLACEHOLDERS.map((placeholder) => [placeholder.name, placeholder.sample]),
) as crm.StatusEmailVars;

/** Renders the template with sample values, through the server's renderer. */
export function renderStatusEmailPreview(template: string): string {
  return crm.renderStatusEmail(template, SAMPLE_VARS);
}
