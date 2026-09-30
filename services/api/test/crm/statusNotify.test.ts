import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { changeCaseStatus, createCase, getCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { META_SORT_KEY, travellerPartitionKey } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertStatusEmailTemplate } from "../../src/domain/crm/statusEmailTemplates";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

interface SeedCaseOptions {
  caseRef: string;
  partnerContactEmail?: string;
  clientEmail?: string;
  destinationCountry?: string;
  groupName?: string;
  applicantNames?: string[];
  refNos?: string[];
}

/** One partner, its travellers, and a case -- the create mail fires inside. */
async function seedCase(context: TestContext, options: SeedCaseOptions) {
  const partner = await createPartner(
    context,
    TENANT_ID,
    {
      canonicalName: `Partner for ${options.caseRef}`,
      ...(options.partnerContactEmail !== undefined ? { contactEmail: options.partnerContactEmail } : {}),
    },
    ACTOR,
  );
  const applicantNames = options.applicantNames ?? ["Asha Rao"];
  const travellerIds: string[] = [];
  for (const fullName of applicantNames) {
    travellerIds.push((await upsertTraveller(context, TENANT_ID, { fullName })).travellerId);
  }
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef: options.caseRef,
      caseType: "VISA",
      partnerId: partner.partnerId,
      destinationCountry: options.destinationCountry ?? "AE",
      visaType: "TOURIST",
      receivedDate: "2026-09-16",
      ...(options.clientEmail !== undefined ? { clientEmail: options.clientEmail } : {}),
      ...(options.groupName !== undefined ? { groupName: options.groupName } : {}),
      applicants: travellerIds.map((travellerId, index) => ({
        applicantRef: `A${index + 1}`,
        travellerId,
        ...(options.refNos?.[index] !== undefined ? { refNo: options.refNos[index] } : {}),
      })),
    },
    ACTOR,
  );
}

describe("status-change email", () => {
  it("emails the partner with the new status's template when a case status moves", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, { caseRef: "RGS-MAIL-1", partnerContactEmail: "desk@skyline.test" });
    context.email.sentEmails.length = 0;

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]).toMatchObject({
      toAddress: "desk@skyline.test",
      subject: expect.stringContaining("RGS-MAIL-1"),
    });
    const bodyText = context.email.sentEmails[0]!.bodyText;
    expect(bodyText).toContain("under document review");
    expect(bodyText).toContain("Dear Asha Rao,");
    expect(bodyText).toContain("Application ID: RGS-MAIL-1");
    expect(bodyText).not.toContain("{{");
    expect(bodyText).not.toContain("is now");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    // The clock is frozen, so create and change events tie on time: pick by meta, not by position.
    const changeNotification = events.find(
      (event) => event.eventType === "PARTNER_NOTIFIED" && event.meta["toStatus"] === "DOCS_UNDER_REVIEW",
    );
    expect(changeNotification?.meta).toEqual({
      channel: "email",
      toAddress: "desk@skyline.test",
      fromStatus: "NEW",
      toStatus: "DOCS_UNDER_REVIEW",
    });
  });

  it("skips email quietly when the partner has no contact email", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, { caseRef: "RGS-MAIL-2" });

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(0);
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
  });

  it("titles the email REF – STATUS – NAME – COUNTRY + visa type from the seeded subject", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, { caseRef: "RGS-MAIL-3", partnerContactEmail: "desk@skyline.test" });

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.at(-1)!.subject).toBe(
      "RGS-MAIL-3 – Documents Under Review – Asha Rao – United Arab Emirates Tourist",
    );
  });

  it("names the first applicant only in {{clientName}} when a case carries several and no group name", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-MAIL-4",
      partnerContactEmail: "desk@skyline.test",
      applicantNames: ["Asha Rao", "Ravi Rao", "Meera Rao"],
    });

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.at(-1)!.subject).toBe(
      "RGS-MAIL-4 – Documents Under Review – Asha Rao – United Arab Emirates Tourist",
    );
  });

  it("emails the client too when the case carries a clientEmail, and records CLIENT_NOTIFIED", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-MAIL-5",
      partnerContactEmail: "desk@skyline.test",
      clientEmail: "asha@example.com",
    });
    context.email.sentEmails.length = 0;

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual([
      "desk@skyline.test",
      "asha@example.com",
    ]);
    expect(context.email.sentEmails[0]!.subject).toBe(context.email.sentEmails[1]!.subject);
    expect(context.email.sentEmails[0]!.bodyText).toBe(context.email.sentEmails[1]!.bodyText);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const clientChangeEvent = events
      .filter((event) => event.eventType === "CLIENT_NOTIFIED")
      .find((event) => event.meta["reason"] === undefined);
    expect(clientChangeEvent?.meta).toEqual({
      channel: "email",
      toAddress: "asha@example.com",
      fromStatus: "NEW",
      toStatus: "DOCS_UNDER_REVIEW",
    });
  });

  it("emails only the client when the partner has no address, and only the partner when the case has none", async () => {
    const context = buildTestContext();
    const clientOnly = await seedCase(context, { caseRef: "RGS-MAIL-6", clientEmail: "asha@example.com" });
    context.email.sentEmails.length = 0;
    await changeCaseStatus(context, TENANT_ID, clientOnly.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["asha@example.com"]);
    const clientOnlyEvents = await listCaseEvents(context, TENANT_ID, clientOnly.caseId);
    expect(clientOnlyEvents.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
    expect(clientOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(true);

    const partnerOnly = await seedCase(context, { caseRef: "RGS-MAIL-7", partnerContactEmail: "desk@skyline.test" });
    context.email.sentEmails.length = 0;
    await changeCaseStatus(context, TENANT_ID, partnerOnly.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["desk@skyline.test"]);
    const partnerOnlyEvents = await listCaseEvents(context, TENANT_ID, partnerOnly.caseId);
    expect(partnerOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(false);
  });

  it("uses the group name as {{clientName}} in the subject and body when the case has one", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-2026-0912",
      partnerContactEmail: "desk@skyline.test",
      destinationCountry: "FR",
      groupName: "Sharma Family",
      applicantNames: ["Rahul Sharma", "Priya Sharma"],
      refNos: ["RGS-2026-0912", "RGS-2026-0913"],
    });

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    const email = context.email.sentEmails.at(-1)!;
    expect(email.subject).toBe(
      "RGS-2026-0912 – Documents Under Review – Sharma Family – France (Schengen) Tourist",
    );
    expect(email.bodyText).toContain("Dear Sharma Family,");
  });

  it("renders {{applicantsBlock}} as REF – name – outcome lines for a group", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-2026-0912",
      partnerContactEmail: "desk@skyline.test",
      destinationCountry: "FR",
      groupName: "Sharma Family",
      applicantNames: ["Rahul Sharma", "Priya Sharma"],
      refNos: ["RGS-2026-0912", "RGS-2026-0913"],
    });
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "DOCS_UNDER_REVIEW",
      { subject: "{{applicationId}}", body: "Hello {{clientName}}\n\n{{applicantsBlock}}", enabled: true },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.at(-1)!.bodyText).toBe(
      [
        "Hello Sharma Family",
        "",
        "RGS-2026-0912 – Rahul Sharma – Pending",
        "RGS-2026-0913 – Priya Sharma – Pending",
      ].join("\n"),
    );
  });

  it("leaves the applicants lines out for a single-applicant case", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, { caseRef: "31377", partnerContactEmail: "desk@skyline.test" });
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "DOCS_UNDER_REVIEW",
      { subject: "s", body: "Hello\n\n{{applicantsBlock}}\n\nBye", enabled: true },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.at(-1)!.bodyText).toBe("Hello\n\nBye");
  });

  it("fills the appointment date as DD MMM YYYY when set, without broken 'at' copy from the blank time and centre", async () => {
    const context = buildTestContext();
    const withDate = await seedCase(context, { caseRef: "RGS-APPT-A", partnerContactEmail: "desk@skyline.test" });
    await updateCaseDetails(context, TENANT_ID, withDate.caseId, { appointmentDate: "2026-10-03" }, ACTOR);
    await changeCaseStatus(context, TENANT_ID, withDate.caseId, "APPOINTMENT_SET", ACTOR);

    const bodyWithDate = context.email.sentEmails.at(-1)!.bodyText;
    expect(bodyWithDate).toContain("Your visa appointment for United Arab Emirates Tourist has been confirmed.");
    expect(bodyWithDate).toContain("Appointment date: 03 Oct 2026");
    expect(bodyWithDate).not.toContain("Appointment time");
    expect(bodyWithDate).not.toContain("Centre:");
    expect(bodyWithDate).not.toMatch(/at\s+at/);
    expect(bodyWithDate).not.toMatch(/\bat\s*\./);
    expect(bodyWithDate).not.toContain("{{");
  });

  it("drops the whole appointment block when no date is set", async () => {
    const context = buildTestContext();
    const withoutDate = await seedCase(context, { caseRef: "RGS-APPT-B", partnerContactEmail: "desk@skyline.test" });
    await changeCaseStatus(context, TENANT_ID, withoutDate.caseId, "APPOINTMENT_SET", ACTOR);

    const bodyText = context.email.sentEmails.at(-1)!.bodyText;
    expect(bodyText).toContain("has been confirmed.");
    expect(bodyText).not.toContain("Appointment date");
    expect(bodyText).not.toMatch(/at\s+at/);
    expect(bodyText).not.toMatch(/\bat\s*\./);
    expect(bodyText).not.toMatch(/\n\n\n/);
    expect(bodyText).not.toContain("{{");
  });

  it("writes Unnamed applicant for a traveller that cannot be read, without failing the send", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-G-1",
      partnerContactEmail: "desk@skyline.test",
      destinationCountry: "FR",
      groupName: "Sharma Family",
      applicantNames: ["Rahul Sharma", "Ghost Sharma"],
    });
    const ghostTravellerId = created.applicants[1]!.travellerId;
    await context.table.delete(travellerPartitionKey(TENANT_ID, ghostTravellerId), META_SORT_KEY);
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "DOCS_UNDER_REVIEW",
      { subject: "s", body: "{{applicantsBlock}}", enabled: true },
      ACTOR,
    );
    context.email.sentEmails.length = 0;

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.bodyText).toContain("A2 – Unnamed applicant – Pending");
  });

  it("sends nothing when the status's template is disabled, but the status still changes", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-OFF-1",
      partnerContactEmail: "desk@skyline.test",
      clientEmail: "asha@example.com",
    });
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "DOCS_UNDER_REVIEW",
      { subject: "s", body: "b", enabled: false },
      ACTOR,
    );
    context.email.sentEmails.length = 0;

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(0);
    expect((await getCase(context, TENANT_ID, created.caseId)).caseStatus).toBe("DOCS_UNDER_REVIEW");
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const changeNotifications = events.filter(
      (event) =>
        (event.eventType === "PARTNER_NOTIFIED" || event.eventType === "CLIENT_NOTIFIED") &&
        event.meta["toStatus"] === "DOCS_UNDER_REVIEW",
    );
    expect(changeNotifications).toHaveLength(0);
  });

  it("sends nothing when no template row exists, and never falls back to a generic body", async () => {
    const context = buildTestContext({ seedStatusEmailTemplates: false });
    const created = await seedCase(context, { caseRef: "RGS-NOROW-1", partnerContactEmail: "desk@skyline.test" });

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(0);
    expect((await getCase(context, TENANT_ID, created.caseId)).caseStatus).toBe("DOCS_UNDER_REVIEW");
  });

  it("uses an edited template verbatim, subject included", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, { caseRef: "RGS-EDIT-1", partnerContactEmail: "desk@skyline.test" });
    await upsertStatusEmailTemplate(
      context,
      TENANT_ID,
      "DOCS_UNDER_REVIEW",
      { subject: "Custom {{applicationId}}", body: "Custom body for {{clientName}}", enabled: true },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.at(-1)).toMatchObject({
      subject: "Custom RGS-EDIT-1",
      bodyText: "Custom body for Asha Rao",
    });
  });
});

describe("status email on create", () => {
  it("sends the Application Received (NEW) template once when a case is created", async () => {
    const context = buildTestContext();

    const created = await seedCase(context, { caseRef: "RGS-NEW-1", partnerContactEmail: "desk@skyline.test" });

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]).toMatchObject({
      toAddress: "desk@skyline.test",
      subject: "RGS-NEW-1 – Application Received – Asha Rao – United Arab Emirates Tourist",
    });
    expect(context.email.sentEmails[0]!.bodyText).toContain("successfully registered in our system");
    expect(context.email.sentEmails[0]!.bodyText).toContain("Application ID: RGS-NEW-1");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const partnerEvent = events.find((event) => event.eventType === "PARTNER_NOTIFIED");
    expect(partnerEvent?.meta).toEqual({
      channel: "email",
      toAddress: "desk@skyline.test",
      toStatus: "NEW",
      reason: "CREATE",
    });
  });

  it("emails the client on create too, and the later status change sends that status's template, not NEW again", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, {
      caseRef: "RGS-NEW-2",
      partnerContactEmail: "desk@skyline.test",
      clientEmail: "asha@example.com",
    });
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual([
      "desk@skyline.test",
      "asha@example.com",
    ]);

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(4);
    const changeEmails = context.email.sentEmails.slice(2);
    expect(changeEmails.map((email) => email.toAddress)).toEqual(["desk@skyline.test", "asha@example.com"]);
    for (const email of changeEmails) {
      expect(email.subject).toContain("Documents Under Review");
      expect(email.bodyText).not.toContain("successfully registered");
    }
  });

  it("sends nothing on create when the partner and client have no address", async () => {
    const context = buildTestContext();

    const created = await seedCase(context, { caseRef: "RGS-NEW-3" });

    expect(context.email.sentEmails).toHaveLength(0);
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
    expect(events.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(false);
  });

  it("sends nothing on create when the NEW template is disabled, and still creates the case", async () => {
    const context = buildTestContext();
    await upsertStatusEmailTemplate(context, TENANT_ID, "NEW", { subject: "s", body: "b", enabled: false }, ACTOR);

    const created = await seedCase(context, { caseRef: "RGS-NEW-4", partnerContactEmail: "desk@skyline.test" });

    expect(context.email.sentEmails).toHaveLength(0);
    expect((await getCase(context, TENANT_ID, created.caseId)).caseRef).toBe("RGS-NEW-4");
  });
});
