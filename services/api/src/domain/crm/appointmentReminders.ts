import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { DEFAULT_LEDGER_PAGE_LIMIT, listLedgerRows } from "./ledger";
import { getPartnerOrThrow } from "./partners";

export const APPOINTMENT_REMINDER_ACTOR = "appointment-reminders@system";

export interface AppointmentReminderReport {
  scanned: number;
  reminded: number;
  skipped: number;
}

/** Calendar dates that fall in the daily 24–48h reminder window for `todayIso`. */
export function appointmentDatesInReminderWindow(todayIso: string): [string, string] {
  return [addCalendarDays(todayIso, 1), addCalendarDays(todayIso, 2)];
}

function addCalendarDays(isoDate: string, dayCount: number): string {
  const [yearText, monthText, dayText] = isoDate.split("-");
  const utcDate = new Date(
    Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)),
  );
  utcDate.setUTCDate(utcDate.getUTCDate() + dayCount);
  return utcDate.toISOString().slice(0, 10);
}

/**
 * Nightly (or on-demand) pass: live cases whose appointment is tomorrow or the
 * day after get one partner email. Stamp `appointmentReminderSentFor` so a
 * re-run for the same appointment date is a no-op.
 */
export async function runAppointmentReminders(
  context: AppContext,
  tenantId: string,
  todayIso: string,
  actorEmail: string = APPOINTMENT_REMINDER_ACTOR,
): Promise<AppointmentReminderReport> {
  const reminderDates = new Set(appointmentDatesInReminderWindow(todayIso));
  const report: AppointmentReminderReport = { scanned: 0, reminded: 0, skipped: 0 };

  let cursor: string | undefined;
  do {
    const page = await listLedgerRows(context, tenantId, {
      statuses: [...crm.LIVE_CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    for (const row of page.rows) {
      if (row.appointmentDate === undefined || !reminderDates.has(row.appointmentDate)) {
        continue;
      }
      report.scanned += 1;

      const crmCase = await readCaseOrThrow(context, tenantId, row.caseId);
      if (crmCase.appointmentReminderSentFor === crmCase.appointmentDate) {
        report.skipped += 1;
        continue;
      }

      const sent = await sendAppointmentReminder(context, tenantId, crmCase, actorEmail);
      if (sent) {
        report.reminded += 1;
      }
    }

    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return report;
}

async function sendAppointmentReminder(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  actorEmail: string,
): Promise<boolean> {
  if (crmCase.appointmentDate === undefined) {
    return false;
  }

  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  if (partner.contactEmail === undefined || partner.contactEmail.trim() === "") {
    return false;
  }

  await context.email.send({
    toAddress: partner.contactEmail,
    subject: `Appointment reminder: case ${crmCase.caseRef} on ${crmCase.appointmentDate}`,
    bodyText: [
      `Hello,`,
      ``,
      `This is a reminder that case ${crmCase.caseRef} (destination ${crmCase.destinationCountry}) has an appointment on ${crmCase.appointmentDate}.`,
      ``,
      `— Rays Global Services`,
    ].join("\n"),
  });

  const stampedCase: crm.CrmCase = {
    ...crmCase,
    appointmentReminderSentFor: crmCase.appointmentDate,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, stampedCase);

  await recordCrmEvent(context, tenantId, crmCase.caseId, "APPOINTMENT_REMINDER_SENT", actorEmail, {
    channel: "email",
    toAddress: partner.contactEmail,
    appointmentDate: crmCase.appointmentDate,
  });

  return true;
}
