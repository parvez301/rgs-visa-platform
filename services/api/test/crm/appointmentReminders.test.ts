import { afterEach, describe, expect, it } from "vitest";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";
import { readCaseOrThrow } from "../../src/domain/crm/caseStore";
import { changeCaseStatus, createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import {
  appointmentDatesInReminderWindow,
  runAppointmentReminders,
} from "../../src/domain/crm/appointmentReminders";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";

afterEach(closeSqlTestContexts);

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("appointmentDatesInReminderWindow", () => {
  it("covers tomorrow and the day after for a daily 24-48h window", () => {
    expect(appointmentDatesInReminderWindow("2026-09-22")).toEqual(["2026-09-23", "2026-09-24"]);
  });
});

describe("runAppointmentReminders", () => {
  it("emails the partner for appointments 1-2 days out and is re-runnable", async () => {
    const context = await buildSqlTestContext();
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

    // Creating the case already mailed the partner (Application Received); this test counts reminders only.
    context.email.sentEmails.length = 0;

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
    const context = await buildSqlTestContext();
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

async function seedCase(
  context: SqlTestContext,
  caseRef: string,
  appointmentDate: string | undefined,
  contactEmail = "desk@skyline.test",
) {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: `Partner ${caseRef}`, contactEmail },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: `Traveller ${caseRef}` });
  const created = await createCase(
    context,
    TENANT_ID,
    {
      caseRef,
      caseType: "VISA",
      partnerId: partner.partnerId,
      destinationCountry: "AE",
      visaType: "TOURIST",
      receivedDate: "2026-09-16",
      applicants: [{ applicantRef: caseRef, travellerId: traveller.travellerId }],
    },
    ACTOR,
  );
  if (appointmentDate !== undefined) {
    await updateCaseDetails(context, TENANT_ID, created.caseId, { appointmentDate }, ACTOR);
  }
  return created;
}

describe("runAppointmentReminders on the stored case rows", () => {
  it("stamps the case with the reminded date and is re-runnable", async () => {
    const context = await buildSqlTestContext();
    const inWindow = await seedCase(context, "PG-REM-1", "2026-09-23");
    context.email.sentEmails.length = 0;

    const firstRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(firstRun).toMatchObject({ scanned: 1, reminded: 1, skipped: 0 });
    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.subject).toContain("PG-REM-1");

    const stamped = await readCaseOrThrow(context, TENANT_ID, inWindow.caseId);
    expect(stamped.appointmentReminderSentFor).toBe("2026-09-23");

    const secondRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(secondRun).toMatchObject({ reminded: 0, skipped: 1 });
    expect(context.email.sentEmails).toHaveLength(1);
  });

  it("covers both window days and ignores appointments outside it or on closed cases", async () => {
    const context = await buildSqlTestContext();
    await seedCase(context, "PG-DAY-1", "2026-09-23");
    await seedCase(context, "PG-DAY-2", "2026-09-24");
    await seedCase(context, "PG-TODAY", "2026-09-22");
    await seedCase(context, "PG-LATER", "2026-09-25");
    await seedCase(context, "PG-NONE", undefined);
    const closed = await seedCase(context, "PG-CLOSED", "2026-09-23");
    await changeCaseStatus(context, TENANT_ID, closed.caseId, "CLOSED", ACTOR);
    context.email.sentEmails.length = 0;

    const report = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");

    expect(report).toMatchObject({ scanned: 2, reminded: 2, skipped: 0 });
    const subjects = context.email.sentEmails.map((email) => email.subject).join("\n");
    expect(subjects).toContain("PG-DAY-1");
    expect(subjects).toContain("PG-DAY-2");
  });

  it("follows a reschedule, not a stale appointment", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, "PG-MOVED", "2026-09-23");
    await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      { appointmentDate: "2026-10-30" },
      ACTOR,
    );
    context.email.sentEmails.length = 0;

    const report = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");

    expect(report).toMatchObject({ scanned: 0, reminded: 0 });
    expect(context.email.sentEmails).toHaveLength(0);
  });
});
