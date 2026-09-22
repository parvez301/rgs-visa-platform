import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { readCaseOrThrow } from "./caseStore";
import { buildCaseInvoicePdf } from "./caseInvoicePdf";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";

export interface CaseInvoicePayload {
  fileName: string;
  contentType: "application/pdf";
  pdfBase64: string;
}

/**
 * Builds a downloadable invoice PDF for a case that already has line items.
 * Empty bills are refused -- an invoice with no lines is not a bill.
 */
export async function generateCaseInvoice(
  context: AppContext,
  tenantId: string,
  caseId: string,
  actorEmail: string,
): Promise<CaseInvoicePayload> {
  const crmCase = await readCaseOrThrow(context, tenantId, caseId);
  if (crmCase.lineItems.length === 0) {
    throw badRequest("This case has no line items, so there is nothing to invoice.");
  }

  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  const issuedAtIso = context.now().toISOString();
  const pdfBytes = buildCaseInvoicePdf({
    caseRef: crmCase.caseRef,
    partnerName: partner.canonicalName,
    destinationCountry: crmCase.destinationCountry,
    issuedAtIso,
    lineItems: crmCase.lineItems.map((lineItem) => ({
      label: lineItem.label,
      quantity: lineItem.quantity,
      unitPriceInr: lineItem.amountInr,
    })),
    totalInr: crmCase.totalInr,
  });

  const safeRef = crmCase.caseRef.replace(/[^A-Za-z0-9._-]+/g, "-");
  const payload: CaseInvoicePayload = {
    fileName: `invoice-${safeRef}.pdf`,
    contentType: "application/pdf",
    pdfBase64: Buffer.from(pdfBytes).toString("base64"),
  };

  await recordCrmEvent(context, tenantId, caseId, "INVOICE_GENERATED", actorEmail, {
    fileName: payload.fileName,
    totalInr: crmCase.totalInr,
    lineItemCount: crmCase.lineItems.length,
  });

  return payload;
}
