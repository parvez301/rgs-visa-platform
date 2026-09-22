import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import {
  appointmentDatesInReminderWindow,
  runAppointmentReminders,
} from "../../src/domain/crm/appointmentReminders";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("appointmentDatesInReminderWindow", () => {
  it("covers tomorrow and the day after for a daily 24-48h window", () => {
    expect(appointmentDatesInReminderWindow("2026-09-22")).toEqual(["2026-09-23", "2026-09-24"]);
  });
});

describe("runAppointmentReminders", () => {
  it("emails the partner for appointments 1-2 days out and is re-runnable", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-APPT-1",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      { appointmentDate: "2026-09-23" },
      ACTOR,
    );

    const firstRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(firstRun).toMatchObject({ scanned: 1, reminded: 1, skipped: 0 });
    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.toAddress).toBe("desk@skyline.test");
    expect(context.email.sentEmails[0]!.subject).toContain("RGS-APPT-1");
    expect(context.email.sentEmails[0]!.bodyText).toContain("2026-09-23");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "APPOINTMENT_REMINDER_SENT")).toBe(true);

    const secondRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(secondRun).toMatchObject({ reminded: 0, skipped: 1 });
    expect(context.email.sentEmails).toHaveLength(1);

    await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      { appointmentDate: "2026-09-24" },
      ACTOR,
    );
    const afterReschedule = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(afterReschedule).toMatchObject({ reminded: 1, skipped: 0 });
    expect(context.email.sentEmails).toHaveLength(2);
    expect(context.email.sentEmails[1]!.bodyText).toContain("2026-09-24");
  });

  it("skips cases with no partner email and cases outside the window", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "No Mail Agency" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-APPT-2",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      { appointmentDate: "2026-09-23" },
      ACTOR,
    );

    const report = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(report.reminded).toBe(0);
    expect(context.email.sentEmails).toHaveLength(0);
  });
});
