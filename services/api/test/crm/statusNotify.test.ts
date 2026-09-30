import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { changeCaseStatus, createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { META_SORT_KEY, travellerPartitionKey } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { buildStatusEmailBody, buildStatusEmailSubject } from "../../src/domain/crm/statusNotify";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("status-change email", () => {
  it("emails the partner when a case status moves and they have a contact email", async () => {
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
        caseRef: "RGS-MAIL-1",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]).toMatchObject({
      toAddress: "desk@skyline.test",
      subject: expect.stringContaining("RGS-MAIL-1"),
    });
    expect(context.email.sentEmails[0]!.bodyText).toContain("Documents Under Review");
    expect(context.email.sentEmails[0]!.bodyText).toContain("New");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(true);
  });

  it("skips email quietly when the partner has no contact email", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "No Email Travels" },
      ACTOR,
    );
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi Singh" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-2",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(0);
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
  });

  it("titles the email REF – STATUS – NAME – COUNTRY, the desk's own filing convention", async () => {
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
        caseRef: "RGS-MAIL-3",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-MAIL-3 – Documents Under Review – Asha Rao – United Arab Emirates");
  });

  it("names the first applicant and counts the rest when a case carries several", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" },
      ACTOR,
    );
    const firstTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const secondTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi Rao" });
    const thirdTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "Meera Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-4",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [
          { applicantRef: "A1", travellerId: firstTraveller.travellerId },
          { applicantRef: "A2", travellerId: secondTraveller.travellerId },
          { applicantRef: "A3", travellerId: thirdTraveller.travellerId },
        ],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-MAIL-4 – Documents Under Review – Asha Rao +2 – United Arab Emirates");
  });

  it("emails the client too when the case carries a clientEmail, and records CLIENT_NOTIFIED", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-5",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        clientEmail: "asha@example.com",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["desk@skyline.test", "asha@example.com"]);
    expect(context.email.sentEmails[0]!.subject).toBe(context.email.sentEmails[1]!.subject);
    expect(context.email.sentEmails[0]!.bodyText).toBe(context.email.sentEmails[1]!.bodyText);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const clientEvent = events.find((event) => event.eventType === "CLIENT_NOTIFIED");
    expect(clientEvent?.meta).toEqual({ channel: "email", toAddress: "asha@example.com", fromStatus: "NEW", toStatus: "DOCS_UNDER_REVIEW" });
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(true);
  });

  it("emails only the client when the partner has no address, and only the partner when the case has none", async () => {
    const context = buildTestContext();
    const partnerWithoutEmail = await createPartner(context, TENANT_ID, { canonicalName: "Quiet Travels" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const clientOnly = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-6",
        caseType: "VISA",
        partnerId: partnerWithoutEmail.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        clientEmail: "asha@example.com",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await changeCaseStatus(context, TENANT_ID, clientOnly.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["asha@example.com"]);
    const clientOnlyEvents = await listCaseEvents(context, TENANT_ID, clientOnly.caseId);
    expect(clientOnlyEvents.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
    expect(clientOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(true);

    const partnerWithEmail = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const partnerOnly = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-7",
        caseType: "VISA",
        partnerId: partnerWithEmail.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await changeCaseStatus(context, TENANT_ID, partnerOnly.caseId, "DOCS_UNDER_REVIEW", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["asha@example.com", "desk@skyline.test"]);
    const partnerOnlyEvents = await listCaseEvents(context, TENANT_ID, partnerOnly.caseId);
    expect(partnerOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(false);
  });

  it("uses the group name as NAME in the subject when the case has one", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const priya = await upsertTraveller(context, TENANT_ID, { fullName: "Priya Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: priya.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-2026-0912 – Documents Under Review – Sharma Family – France (Schengen)");
  });

  it("lists every applicant with their REF NO, name and outcome, and the appointment date, for a group", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const priya = await upsertTraveller(context, TENANT_ID, { fullName: "Priya Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: priya.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      ACTOR,
    );
    await updateCaseDetails(context, TENANT_ID, created.caseId, { appointmentDate: "2026-10-03" }, ACTOR);

    await changeCaseStatus(context, TENANT_ID, created.caseId, "APPOINTMENT_SET", ACTOR);

    const bodyText = context.email.sentEmails.at(-1)!.bodyText;
    expect(bodyText).toContain("Applicants:");
    expect(bodyText).toContain("  RGS-2026-0912 – Rahul Sharma – Pending");
    expect(bodyText).toContain("  RGS-2026-0913 – Priya Sharma – Pending");
    expect(bodyText).toContain("Appointment date: 03 Oct 2026");
  });

  it("keeps the single-applicant body free of an Applicants block or an appointment line", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "31377",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    const bodyText = context.email.sentEmails[0]!.bodyText;
    expect(bodyText).not.toContain("Applicants:");
    expect(bodyText).not.toContain("Appointment date");
    expect(bodyText).toContain("Case 31377 (destination United Arab Emirates) is now Documents Under Review (was New).");
  });

  it("writes Unnamed applicant for a traveller that cannot be read, without failing the send", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const ghost = await upsertTraveller(context, TENANT_ID, { fullName: "Ghost Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-G-1",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId },
          { applicantRef: "A2", travellerId: ghost.travellerId },
        ],
      },
      ACTOR,
    );
    await context.table.delete(travellerPartitionKey(TENANT_ID, ghost.travellerId), META_SORT_KEY);

    await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.bodyText).toContain("  A2 – Unnamed applicant – Pending");
  });

  it("builds the body as plain text in the documented order", () => {
    const bodyText = buildStatusEmailBody(
      {
        tenantId: "rgs",
        caseId: "case_1",
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: "prt_1",
        destinationCountry: "FR",
        caseStatus: "APPOINTMENT_SET",
        billingStatus: "UNBILLED",
        receivedDate: "2026-09-16",
        appointmentDate: "2026-10-03",
        groupName: "Sharma Family",
        lineItems: [],
        totalInr: 0,
        documentChecklist: [],
        applicants: [
          { applicantRef: "A1", travellerId: "trv_1", refNo: "RGS-2026-0912", custody: "NOT_HELD", outcome: "APPROVED" },
          { applicantRef: "A2", travellerId: "trv_2", refNo: "RGS-2026-0913", custody: "NOT_HELD", outcome: "REJECTED" },
        ],
        watchdogOverrides: {},
        mutedRules: [],
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      "SUBMITTED",
      "APPOINTMENT_SET",
      { trv_1: { fullName: "Rahul Sharma" }, trv_2: { fullName: "Priya Sharma" } },
    );

    expect(bodyText).toBe(
      [
        "Hello,",
        "",
        "Case RGS-2026-0912 (destination France (Schengen)) is now Appointment set (was Submitted).",
        "",
        "Applicants:",
        "  RGS-2026-0912 – Rahul Sharma – Approved",
        "  RGS-2026-0913 – Priya Sharma – Rejected",
        "",
        "Appointment date: 03 Oct 2026",
        "",
        "— Rays Global Services",
      ].join("\n"),
    );
  });

  it("builds the same subject through the exported buildStatusEmailSubject wrapper, resolving travellers itself", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-8",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    const subject = await buildStatusEmailSubject(context, TENANT_ID, created, "DOCS_UNDER_REVIEW");

    expect(subject).toBe("RGS-MAIL-8 – Documents Under Review – Asha Rao – United Arab Emirates");
  });
});
