import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { changeCaseStatus, createCase } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("partner status-change email", () => {
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

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]).toMatchObject({
      toAddress: "desk@skyline.test",
      subject: expect.stringContaining("RGS-MAIL-1"),
    });
    expect(context.email.sentEmails[0]!.bodyText).toContain("In progress");
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

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

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

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-MAIL-3 – In progress – Asha Rao – United Arab Emirates");
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

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-MAIL-4 – In progress – Asha Rao +2 – United Arab Emirates");
  });
});
