import { describe, expect, it } from "vitest";
import { buildCaseInvoicePdf } from "../../src/domain/crm/caseInvoicePdf";

describe("buildCaseInvoicePdf", () => {
  it("produces a PDF whose bytes name the case, partner, destination, lines and total", () => {
    const pdfBytes = buildCaseInvoicePdf({
      caseRef: "RGS-1001",
      partnerName: "Skyline Travels",
      destinationCountry: "AE",
      issuedAtIso: "2026-09-22T10:00:00.000Z",
      lineItems: [
        { label: "Visa service fee", quantity: 2, unitPriceInr: 5000 },
        { label: "Courier", quantity: 1, unitPriceInr: 500 },
      ],
      totalInr: 10_500,
    });

    expect(Buffer.from(pdfBytes.subarray(0, 5)).toString("utf8")).toBe("%PDF-");
    const pdfText = Buffer.from(pdfBytes).toString("latin1");
    expect(pdfText).toContain("RGS-1001");
    expect(pdfText).toContain("Skyline Travels");
    expect(pdfText).toContain("AE");
    expect(pdfText).toContain("Visa service fee");
    expect(pdfText).toContain("Courier");
    expect(pdfText).toContain("10,500");
  });
});
