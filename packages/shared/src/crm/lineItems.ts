import type { LineItemKind } from "./statuses";

export interface LineItemDefinition {
  code: string;
  label: string;
  kind: LineItemKind;
}

/** Seeded from what the workbook already sells (spec §6). */
export const LINE_ITEM_CATALOG: readonly LineItemDefinition[] = [
  { code: "VISA_SERVICE_FEE", label: "Visa service fee", kind: "SERVICE" },
  { code: "GOVT_FEE", label: "Government / embassy fee", kind: "GOVT_FEE" },
  { code: "ATTESTATION", label: "Attestation", kind: "SERVICE" },
  { code: "APOSTILLE", label: "Apostille", kind: "SERVICE" },
  { code: "PCC", label: "Police clearance certificate", kind: "SERVICE" },
  { code: "PHOTO_MAKING", label: "Photo making", kind: "ADDON" },
  { code: "FORM_FILLING", label: "Form filling", kind: "ADDON" },
  { code: "HOTEL_BOOKING", label: "Hotel booking", kind: "ADDON" },
  { code: "TICKET_BOOKING", label: "Ticket booking", kind: "ADDON" },
  { code: "COLLECTION_CHARGE", label: "Collection charge", kind: "ADDON" },
  { code: "COURIER_CHARGE", label: "Courier charge", kind: "ADDON" },
  { code: "CHINESE_TRANSLATION", label: "Chinese translation", kind: "ADDON" },
];

const DEFINITION_BY_CODE = new Map(
  LINE_ITEM_CATALOG.map((lineItemDefinition) => [lineItemDefinition.code, lineItemDefinition]),
);

export function getLineItemDefinition(lineItemCode: string): LineItemDefinition | undefined {
  return DEFINITION_BY_CODE.get(lineItemCode);
}
