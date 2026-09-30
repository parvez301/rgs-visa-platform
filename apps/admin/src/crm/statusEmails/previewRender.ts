import { crm } from "@rgs/shared";

/**
 * The placeholders a template may use, each with the sample value the preview
 * panel substitutes. Mirrors `StatusEmailVars`
 * (services/api/src/domain/crm/statusEmailRender.ts); the admin app never
 * imports from `services/api`, so the list lives here too.
 */
export const STATUS_EMAIL_PLACEHOLDERS = [
  { name: "clientName", description: "Client or group name", sample: "Anil Sharma" },
  { name: "countryVisaType", description: "Destination and visa type", sample: "Japan Tourist Visa" },
  { name: "applicationId", description: "The case REF", sample: "38017" },
  { name: "appointmentDate", description: "Appointment date", sample: "12 Oct 2026" },
  { name: "appointmentTime", description: "Appointment time", sample: "10:30 AM" },
  { name: "centre", description: "Appointment centre", sample: "VFS Global, New Delhi" },
  { name: "applicantsBlock", description: "Numbered list of applicants", sample: "1. Anil Sharma\n2. Sita Sharma" },
  { name: "phone", description: "RGS desk phone", sample: crm.STATUS_EMAIL_PHONE },
] as const;

const SAMPLE_VALUES: Record<string, string> = Object.fromEntries(
  STATUS_EMAIL_PLACEHOLDERS.map((placeholder) => [placeholder.name, placeholder.sample]),
);

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Fills `{{token}}` placeholders with the sample values, for the preview only.
 * Unknown tokens become "", as on the server. The server additionally drops
 * lines whose placeholders are all blank; every sample value is filled, so
 * that rule can never fire here and is not reproduced.
 */
export function renderStatusEmailPreview(template: string): string {
  return template.replace(TOKEN_PATTERN, (_match, tokenName: string) =>
    Object.hasOwn(SAMPLE_VALUES, tokenName) ? (SAMPLE_VALUES[tokenName] ?? "") : "",
  );
}
