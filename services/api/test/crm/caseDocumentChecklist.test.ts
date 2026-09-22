import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { createCase } from "../../src/domain/crm/cases";
import { putCountryChecklist } from "../../src/domain/crm/countryChecklist";
import {
  ensureCaseDocumentChecklist,
  setCaseDocumentCheckState,
} from "../../src/domain/crm/caseDocumentChecklist";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

async function seedPartnerAndTraveller() {
  const context = buildTestContext();
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: "Skyline Travels" },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
  return { context, partnerId: partner.partnerId, travellerId: traveller.travellerId };
}

describe("case document checklist", () => {
  it("stamps the destination country's required documents as Missing when a case is opened", async () => {
    const { context, partnerId, travellerId } = await seedPartnerAndTraveller();
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Passport", "Photo"] },
      ACTOR,
    );

    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-DOC-1",
        caseType: "VISA",
        partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId }],
      },
      ACTOR,
    );

    expect(created.documentChecklist).toEqual([
      { label: "Passport", state: "MISSING" },
      { label: "Photo", state: "MISSING" },
    ]);
  });

  it("opens with an empty checklist when the destination has no country list", async () => {
    const { context, partnerId, travellerId } = await seedPartnerAndTraveller();

    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-DOC-2",
        caseType: "VISA",
        partnerId,
        destinationCountry: "JP",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId }],
      },
      ACTOR,
    );

    expect(created.documentChecklist).toEqual([]);
  });

  it("ensures an empty existing case picks up the country list once", async () => {
    const { context, partnerId, travellerId } = await seedPartnerAndTraveller();
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-DOC-3",
        caseType: "VISA",
        partnerId,
        destinationCountry: "SG",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId }],
      },
      ACTOR,
    );
    expect(created.documentChecklist).toEqual([]);

    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "SG", requiredDocuments: ["Passport", "Bank statement"] },
      ACTOR,
    );

    const ensured = await ensureCaseDocumentChecklist(context, TENANT_ID, created.caseId, ACTOR);
    expect(ensured.documentChecklist).toEqual([
      { label: "Passport", state: "MISSING" },
      { label: "Bank statement", state: "MISSING" },
    ]);

    const again = await ensureCaseDocumentChecklist(context, TENANT_ID, created.caseId, ACTOR);
    expect(again.documentChecklist).toEqual(ensured.documentChecklist);
  });

  it("moves one document's state and records DOCUMENT_CHECKLIST_CHANGED", async () => {
    const { context, partnerId, travellerId } = await seedPartnerAndTraveller();
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Passport", "Photo"] },
      ACTOR,
    );
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-DOC-4",
        caseType: "VISA",
        partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId }],
      },
      ACTOR,
    );

    const updated = await setCaseDocumentCheckState(
      context,
      TENANT_ID,
      created.caseId,
      "Passport",
      "RECEIVED",
      ACTOR,
    );
    expect(updated.documentChecklist).toEqual([
      { label: "Passport", state: "RECEIVED" },
      { label: "Photo", state: "MISSING" },
    ]);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const changeEvent = events.find((event) => event.eventType === "DOCUMENT_CHECKLIST_CHANGED");
    expect(changeEvent?.meta).toMatchObject({
      documentLabel: "Passport",
      fromState: "MISSING",
      toState: "RECEIVED",
    });
  });
});
