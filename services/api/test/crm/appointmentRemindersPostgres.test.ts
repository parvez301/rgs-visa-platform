import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { runAppointmentReminders } from "../../src/domain/crm/appointmentReminders";
import { readCaseOrThrow } from "../../src/domain/crm/caseStore";
import { createCase, changeCaseStatus, updateCaseDetails } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { casePartitionKey } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("runAppointmentReminders with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let context: ReturnType<typeof buildTestContext> & AppContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    // Dynamo stays empty: a reminders pass that still read it would find nothing.
    context = { ...buildTestContext(), crmStore: "postgres", sql };
  });

  async function seedCase(caseRef: string, appointmentDate: string | undefined, contactEmail = "desk@skyline.test") {
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

  it("reminds from Postgres, stamps the Postgres case, records the event, and is re-runnable", async () => {
    const inWindow = await seedCase("PG-REM-1", "2026-09-23");
    context.email.sentEmails.length = 0;

    const firstRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(firstRun).toMatchObject({ scanned: 1, reminded: 1, skipped: 0 });
    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.subject).toContain("PG-REM-1");

    const stamped = await readCaseOrThrow(context, TENANT_ID, inWindow.caseId);
    expect(stamped.appointmentReminderSentFor).toBe("2026-09-23");
    const events = await listCaseEvents(context, TENANT_ID, inWindow.caseId);
    expect(events.some((event) => event.eventType === "APPOINTMENT_REMINDER_SENT")).toBe(true);
    // Nothing reached the frozen Dynamo copy.
    expect(await context.table.query(casePartitionKey(TENANT_ID, inWindow.caseId))).toEqual([]);

    const secondRun = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");
    expect(secondRun).toMatchObject({ reminded: 0, skipped: 1 });
    expect(context.email.sentEmails).toHaveLength(1);
  });

  it("covers both window days and ignores appointments outside it or on closed cases", async () => {
    await seedCase("PG-DAY-1", "2026-09-23");
    await seedCase("PG-DAY-2", "2026-09-24");
    await seedCase("PG-TODAY", "2026-09-22");
    await seedCase("PG-LATER", "2026-09-25");
    await seedCase("PG-NONE", undefined);
    const closed = await seedCase("PG-CLOSED", "2026-09-23");
    await changeCaseStatus(context, TENANT_ID, closed.caseId, "CLOSED", ACTOR);
    context.email.sentEmails.length = 0;

    const report = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");

    expect(report).toMatchObject({ scanned: 2, reminded: 2, skipped: 0 });
    expect(context.email.sentEmails.map((email) => email.subject).join("\n")).toMatch(/PG-DAY-1[\s\S]*PG-DAY-2|PG-DAY-2[\s\S]*PG-DAY-1/);
  });

  it("follows a reschedule made on Postgres, not a stale appointment", async () => {
    const created = await seedCase("PG-MOVED", "2026-09-23");
    await updateCaseDetails(context, TENANT_ID, created.caseId, { appointmentDate: "2026-10-30" }, ACTOR);
    context.email.sentEmails.length = 0;

    const report = await runAppointmentReminders(context, TENANT_ID, "2026-09-22");

    expect(report).toMatchObject({ scanned: 0, reminded: 0 });
    expect(context.email.sentEmails).toHaveLength(0);
  });
});
