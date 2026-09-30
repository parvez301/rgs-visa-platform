/**
 * Every value a status-email template may reference as `{{name}}`. Shared
 * because the admin template editor advertises this list to the desk while the
 * API fills it: a name added on one side and missed on the other means the
 * editor offers a placeholder that renders blank in real mail.
 */
export const STATUS_EMAIL_VAR_NAMES = [
  "clientName",
  "countryVisaType",
  "applicationId",
  "appointmentDate",
  "appointmentTime",
  "centre",
  "applicantsBlock",
  "phone",
] as const;

export type StatusEmailVarName = (typeof STATUS_EMAIL_VAR_NAMES)[number];

export type StatusEmailVars = Record<StatusEmailVarName, string>;

/**
 * Vars no case field feeds yet (spec §4.2), so the server renders them blank on
 * every send and any line holding only these is dropped. The admin preview
 * reads this list rather than inventing samples, so it cannot show a desk agent
 * an appointment time the client will never receive.
 */
export const STATUS_EMAIL_UNPOPULATED_VARS: readonly StatusEmailVarName[] = [
  "appointmentTime",
  "centre",
];

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

function isBlank(text: string): boolean {
  return text.trim() === "";
}

/**
 * Fills `{{token}}` placeholders (spec §4.2). Three rules:
 *
 * - An unknown token becomes "" -- `{{…}}` never reaches the wire.
 * - Substitution is one pass per line, so a value that itself looks like a
 *   token (a client named "{{phone}}") is not expanded a second time.
 * - A line that held placeholders and ended up with every one of them blank
 *   is dropped whole ("Appointment: {{date}} at {{time}} at {{centre}}" with
 *   no appointment must not leave "Appointment:  at  at "). Lines the author
 *   wrote blank are paragraph spacing and stay, but a dropped line never
 *   leaves two blank lines side by side, and the result never starts or ends
 *   on a blank line.
 */
export function renderStatusEmail(template: string, vars: StatusEmailVars): string {
  const values: Record<string, string> = { ...vars };
  const keptLines: string[] = [];

  for (const templateLine of template.split("\n")) {
    let hadToken = false;
    let anyTokenFilled = false;
    const renderedLine = templateLine.replace(TOKEN_PATTERN, (_match, tokenName: string) => {
      hadToken = true;
      const value = Object.hasOwn(values, tokenName) ? (values[tokenName] ?? "") : "";
      if (!isBlank(value)) anyTokenFilled = true;
      return value;
    });
    if (hadToken && !anyTokenFilled) continue;
    keptLines.push(renderedLine);
  }

  const collapsedLines: string[] = [];
  for (const line of keptLines) {
    if (isBlank(line) && (collapsedLines.length === 0 || isBlank(collapsedLines[collapsedLines.length - 1] ?? ""))) {
      continue;
    }
    collapsedLines.push(line);
  }
  while (collapsedLines.length > 0 && isBlank(collapsedLines[collapsedLines.length - 1] ?? "")) {
    collapsedLines.pop();
  }
  return collapsedLines.join("\n");
}
