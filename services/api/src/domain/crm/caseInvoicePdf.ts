/**
 * Minimal single-page PDF writer for CRM invoices. No third-party PDF
 * dependency: Lambda stays lean, and the only requirement is that a desk
 * agent can download a printable bill from the case screen.
 *
 * Helvetica Type1 only -- PDF string escaping covers ( ) \ ; non-ASCII in
 * partner/line labels is replaced with '?' so a bad name cannot corrupt the
 * content stream.
 */

export interface CaseInvoiceLineInput {
  label: string;
  quantity: number;
  unitPriceInr: number;
}

export interface CaseInvoicePdfInput {
  caseRef: string;
  partnerName: string;
  destinationCountry: string;
  issuedAtIso: string;
  lineItems: readonly CaseInvoiceLineInput[];
  totalInr: number;
}

function escapePdfString(rawText: string): string {
  return rawText
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function formatInrPlain(amountInr: number): string {
  return `INR ${amountInr.toLocaleString("en-IN")}`;
}

function buildContentStream(input: CaseInvoicePdfInput): string {
  const lines: string[] = [];
  const pushText = (fontSize: number, x: number, y: number, text: string) => {
    lines.push(`BT /F1 ${fontSize} Tf ${x} ${y} Td (${escapePdfString(text)}) Tj ET`);
  };

  pushText(18, 50, 750, "Rays Global Services");
  pushText(12, 50, 730, "Invoice");
  pushText(10, 50, 710, `Case REF: ${input.caseRef}`);
  pushText(10, 50, 695, `Partner: ${input.partnerName}`);
  pushText(10, 50, 680, `Destination: ${input.destinationCountry}`);
  pushText(10, 50, 665, `Issued: ${input.issuedAtIso.slice(0, 10)}`);

  pushText(10, 50, 635, "Item");
  pushText(10, 280, 635, "Qty");
  pushText(10, 340, 635, "Unit");
  pushText(10, 440, 635, "Line total");

  let rowY = 615;
  for (const lineItem of input.lineItems) {
    const lineTotal = lineItem.unitPriceInr * lineItem.quantity;
    pushText(10, 50, rowY, lineItem.label);
    pushText(10, 280, rowY, String(lineItem.quantity));
    pushText(10, 340, rowY, formatInrPlain(lineItem.unitPriceInr));
    pushText(10, 440, rowY, formatInrPlain(lineTotal));
    rowY -= 16;
  }

  pushText(12, 50, rowY - 10, `Total: ${formatInrPlain(input.totalInr)}`);
  return lines.join("\n");
}

/**
 * Assembles a valid PDF-1.4 document containing the invoice content stream.
 * Object offsets are computed after the body is known so the xref is honest.
 */
export function buildCaseInvoicePdf(input: CaseInvoicePdfInput): Uint8Array {
  const contentStream = buildContentStream(input);
  const contentLength = Buffer.byteLength(contentStream, "utf8");

  const objects: string[] = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  );
  objects.push(`4 0 obj\n<< /Length ${contentLength} >>\nstream\n${contentStream}\nendstream\nendobj\n`);
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const objectBody of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += objectBody;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let objectIndex = 1; objectIndex <= objects.length; objectIndex += 1) {
    pdf += `${String(offsets[objectIndex]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "utf8"));
}
