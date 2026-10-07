import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest } from "../../lib/errors";
import { describeFirstZodIssue } from "../../lib/storedRecords";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";

export interface AddLineItemInput {
  lineItemCode: string;
  quantity: number;
  unitPriceInr: number;
}

/**
 * Appends a billable line to a case and recomputes `totalInr` from the whole
 * `lineItems` array. `createCase` has always set `lineItems: []`, and nothing
 * before this function has ever appended to it -- `totalInr` has therefore
 * never moved off `0` for any case in the system.
 *
 * The catalog (`LINE_ITEM_CATALOG`) carries no prices, only `code`/`label`/
 * `kind`, so `label` and `kind` on the stored line come from the catalog
 * definition and the price comes from the caller. `amountInr` is the UNIT
 * price (see `LineItemSchema.amountInr`); `totalInr` is always the sum, over
 * every stored line, of `amountInr × quantity`, recomputed from scratch on
 * every call rather than incremented. A running total drifts the first time
 * anything else edits a line -- or the moment the stored total is wrong for a
 * reason unrelated to this call -- and that drift is invisible until someone
 * reconciles a bill by hand; recomputing from the full list is immune to it.
 */
export async function addLineItem(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: AddLineItemInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const lineItemDefinition = crm.getLineItemDefinition(input.lineItemCode);
  if (lineItemDefinition === undefined) {
    throw badRequest(
      `${input.lineItemCode} is not a line item this business sells; the catalog holds ${crm.LINE_ITEM_CATALOG.map((catalogEntry) => catalogEntry.code).join(", ")}`,
    );
  }

  const currentCase = await readCaseOrThrow(context, tenantId, caseId);

  // Unwrapped, a ZodError here is not an ApiError, and router.ts maps only
  // ApiError subclasses -- so a caller-supplied quantity or unit price that
  // fails LineItemSchema (zero, negative, non-integer) would answer a bare
  // 500 instead of a 400 naming the problem.
  let newLineItem: crm.LineItem;
  try {
    newLineItem = crm.LineItemSchema.parse({
      code: lineItemDefinition.code,
      label: lineItemDefinition.label,
      kind: lineItemDefinition.kind,
      amountInr: input.unitPriceInr,
      quantity: input.quantity,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest(describeFirstZodIssue(error));
    }
    throw error;
  }

  const appendedLineItems = [...currentCase.lineItems, newLineItem];
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    lineItems: appendedLineItems,
    totalInr: appendedLineItems.reduce(
      (runningTotal, lineItem) => runningTotal + lineItem.amountInr * lineItem.quantity,
      0,
    ),
    updatedAt: context.now().toISOString(),
  };

  await writeCase(context, updatedCase);
  const lineTotalInr = newLineItem.amountInr * newLineItem.quantity;
  await recordCrmEvent(context, tenantId, caseId, "LINE_ITEM_ADDED", actorEmail, {
    lineItemCode: input.lineItemCode,
    quantity: input.quantity,
    // The UNIT price -- matches the stored line's own amountInr field. See
    // lineTotalInr below for what this line actually moved the case total by.
    amountInr: input.unitPriceInr,
    // amountInr above is the unit price, so a quantity > 1 line makes a
    // reader multiply to see what it did to the case total. Naming that
    // product explicitly means an audit-trail reader never has to.
    lineTotalInr,
  });
  await notifyStaffOfLineItem(context, updatedCase, {
    lineItemCode: input.lineItemCode,
    label: newLineItem.label,
    quantity: input.quantity,
    unitPriceInr: input.unitPriceInr,
    lineTotalInr,
    actorEmail,
  });
  return updatedCase;
}

async function notifyStaffOfLineItem(
  context: AppContext,
  caseRecord: crm.CrmCase,
  details: {
    lineItemCode: string;
    label: string;
    quantity: number;
    unitPriceInr: number;
    lineTotalInr: number;
    actorEmail: string;
  },
): Promise<void> {
  const recipients = await resolveStaffNotificationEmails(context);
  if (recipients.length === 0) return;

  const subject = `Line item added — ${caseRecord.caseRef}`;
  const bodyText = [
    `Case: ${caseRecord.caseRef}`,
    `Item: ${details.label} (${details.lineItemCode})`,
    `Quantity: ${details.quantity}`,
    `Unit price: ₹${details.unitPriceInr.toLocaleString("en-IN")}`,
    `Line total: ₹${details.lineTotalInr.toLocaleString("en-IN")}`,
    `Case total now: ₹${caseRecord.totalInr.toLocaleString("en-IN")}`,
    `Added by: ${details.actorEmail}`,
  ].join("\n");

  for (const toAddress of recipients) {
    await context.email.send({ toAddress, subject, bodyText });
  }
}

async function resolveStaffNotificationEmails(
  context: AppContext,
): Promise<string[]> {
  if (context.cognitoAdmins === undefined) {
    return context.adminNotificationAddress.trim() === ""
      ? []
      : [context.adminNotificationAddress];
  }
  const users = await context.cognitoAdmins.listUsers();
  const emails = users
    .filter((user) => user.enabled && user.email.trim() !== "")
    .map((user) => user.email.trim());
  return [...new Set(emails)];
}
