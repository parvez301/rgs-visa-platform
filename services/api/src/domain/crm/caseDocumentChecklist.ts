import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, notFound } from "../../lib/errors";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { findCountryChecklist } from "./countryChecklist";
import { recordCrmEvent } from "./crmEvents";

/**
 * Builds the per-case checklist from a country template: every required
 * document starts as Missing. Shared by create and ensure so the stamp has
 * one shape.
 */
export function stampDocumentChecklistFromCountry(
  requiredDocuments: readonly string[],
): crm.CaseDocumentCheck[] {
  return requiredDocuments.map((label) => ({ label, state: "MISSING" as const }));
}

/**
 * If the case still has an empty checklist and the destination has a country
 * template, stamp it. Idempotent: a case that already carries marks is left
 * alone (never re-stamped over human progress).
 */
export async function ensureCaseDocumentChecklist(
  context: AppContext,
  tenantId: string,
  caseId: string,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  if (currentCase.documentChecklist.length > 0) return currentCase;

  const countryChecklist = await findCountryChecklist(
    context,
    tenantId,
    currentCase.destinationCountry,
  );
  if (countryChecklist === undefined || countryChecklist.requiredDocuments.length === 0) {
    return currentCase;
  }

  const nowIso = context.now().toISOString();
  const updatedCase = crm.CrmCaseSchema.parse({
    ...currentCase,
    documentChecklist: stampDocumentChecklistFromCountry(countryChecklist.requiredDocuments),
    updatedAt: nowIso,
  });
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "DOCUMENT_CHECKLIST_CHANGED", actorEmail, {
    action: "stamped",
    documentCount: updatedCase.documentChecklist.length,
  });
  return updatedCase;
}

/**
 * Moves one stamped document to Missing / Received / Verified. The label must
 * already sit on the case checklist -- this route does not invent new rows.
 */
export async function setCaseDocumentCheckState(
  context: AppContext,
  tenantId: string,
  caseId: string,
  documentLabel: string,
  toState: crm.DocumentCheckState,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const trimmedLabel = documentLabel.trim();
  if (trimmedLabel === "") throw badRequest("document label is required");

  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const itemIndex = currentCase.documentChecklist.findIndex((item) => item.label === trimmedLabel);
  if (itemIndex === -1) {
    throw notFound(`Document "${trimmedLabel}" is not on this case's checklist`);
  }
  const currentItem = currentCase.documentChecklist[itemIndex]!;
  if (currentItem.state === toState) return currentCase;

  const nextChecklist = currentCase.documentChecklist.map((item, index) =>
    index === itemIndex ? { ...item, state: toState } : item,
  );
  const nowIso = context.now().toISOString();
  const updatedCase = crm.CrmCaseSchema.parse({
    ...currentCase,
    documentChecklist: nextChecklist,
    updatedAt: nowIso,
  });
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "DOCUMENT_CHECKLIST_CHANGED", actorEmail, {
    documentLabel: trimmedLabel,
    fromState: currentItem.state,
    toState,
  });
  return updatedCase;
}
