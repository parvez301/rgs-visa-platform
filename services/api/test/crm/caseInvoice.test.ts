import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { createCase } from "../../src/domain/crm/cases";
import { generateCaseInvoice } from "../../src/domain/crm/caseInvoice";
import { addLineItem } from "../../src/domain/crm/lineItems";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT_ID = "rgs";
const ACTOR = "ops@rgs.test";

describe("generateCaseInvoice", () => {
  it("refuses a case with no line items", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-INV-1",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await expect(generateCaseInvoice(context, TENANT_ID, created.caseId, ACTOR)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("returns a PDF payload and records INVOICE_GENERATED", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-INV-2",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await addLineItem(
      context,
      TENANT_ID,
      created.caseId,
      { lineItemCode: "VISA_SERVICE_FEE", quantity: 1, unitPriceInr: 3500 },
      ACTOR,
    );

    const invoice = await generateCaseInvoice(context, TENANT_ID, created.caseId, ACTOR);

    expect(invoice.contentType).toBe("application/pdf");
    expect(invoice.fileName).toBe("invoice-RGS-INV-2.pdf");
    expect(Buffer.from(invoice.pdfBase64, "base64").subarray(0, 5).toString("utf8")).toBe("%PDF-");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.some((event) => event.eventType === "INVOICE_GENERATED")).toBe(true);
  });
});
