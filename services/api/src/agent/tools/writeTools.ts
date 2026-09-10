import { z } from "zod";
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import {
  changeApplicantCustody,
  changeBillingStatus,
  createCase,
  getCase,
  updateCaseDetails,
} from "../../domain/crm/cases";
import { addLineItem } from "../../domain/crm/lineItems";
import type { ProposedChange } from "../approval";
import { forgetTool, rememberTool } from "./memoryTools";
import type { AgentTool } from "./registry";

/** Stands in for "there is no prior value" on a proposal with no stored case to read yet. */
const NEW_CASE_FROM = "(new case)";
/** Stands in for "this field has never been set" when reading an optional field off a stored case. */
const NOT_SET_FROM = "(not set)";

/**
 * Mints the two generated fields every proposal needs (`proposalId`,
 * `proposedAt`) and assembles the rest into a complete `ProposedChange`. This
 * is the only place a write tool's `execute` touches `context` for anything
 * other than a read -- `newId`/`context.now()` mint an id and a timestamp,
 * never a table write.
 */
function proposalFrom(
  context: AppContext,
  toolName: string,
  input: Record<string, unknown>,
  summary: ProposedChange["summary"],
  proposedBy: string,
  caseId?: string,
): ProposedChange {
  return {
    proposalId: newId("prop", context.now().getTime()),
    toolName,
    input,
    summary,
    ...(caseId !== undefined ? { caseId } : {}),
    proposedBy,
    proposedAt: context.now().toISOString(),
    status: "PENDING",
  };
}

type CreateCaseToolApplicantInput = {
  applicantRef: string;
  travellerId: string;
  passportNumber?: string;
};

type CreateCaseToolInput = {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  receivedDate: string;
  applicants: CreateCaseToolApplicantInput[];
};

const createCaseTool: AgentTool<CreateCaseToolInput> = {
  name: "create_case",
  kind: "write",
  description:
    "Propose opening a new case for a partner's applicants. Staged for human approval -- this " +
    "never writes on its own.",
  inputSchema: z.object({
    caseRef: z.string().min(1),
    caseType: z.enum(crm.CASE_TYPES),
    partnerId: z.string().min(1),
    destinationCountry: z.string().min(1),
    visaType: z.enum(crm.VISA_TYPES).optional(),
    entryType: z.enum(crm.ENTRY_TYPES).optional(),
    processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
    receivedDate: z.string().min(1),
    applicants: z
      .array(
        z.object({
          applicantRef: z.string().min(1),
          travellerId: z.string().min(1),
          passportNumber: z.string().optional(),
        }),
      )
      .min(1, "a case needs at least one applicant"),
  }),
  execute: async (context, _tenantId, input, actorEmail) => {
    // No case exists yet to read a "from" off of -- every field is new, so
    // every line in the diff shares the same constant rather than something
    // borrowed from a row that isn't there.
    const summary: ProposedChange["summary"] = [
      { field: "caseRef", from: NEW_CASE_FROM, to: input.caseRef },
      { field: "caseType", from: NEW_CASE_FROM, to: input.caseType },
      { field: "partnerId", from: NEW_CASE_FROM, to: input.partnerId },
      { field: "destinationCountry", from: NEW_CASE_FROM, to: input.destinationCountry },
      { field: "receivedDate", from: NEW_CASE_FROM, to: input.receivedDate },
      {
        field: "applicants",
        from: NEW_CASE_FROM,
        to: input.applicants.map((applicant) => applicant.applicantRef).join(", "),
      },
    ];
    if (input.visaType !== undefined) {
      summary.push({ field: "visaType", from: NEW_CASE_FROM, to: input.visaType });
    }
    if (input.entryType !== undefined) {
      summary.push({ field: "entryType", from: NEW_CASE_FROM, to: input.entryType });
    }
    if (input.processing !== undefined) {
      summary.push({ field: "processing", from: NEW_CASE_FROM, to: input.processing });
    }
    // No caseId yet -- caseId on the proposal stays unset until apply() mints one.
    return proposalFrom(context, "create_case", input, summary, actorEmail);
  },
  apply: async (context, tenantId, input, actorEmail) =>
    createCase(
      context,
      tenantId,
      {
        caseRef: input.caseRef,
        caseType: input.caseType,
        partnerId: input.partnerId,
        destinationCountry: input.destinationCountry,
        ...(input.visaType !== undefined ? { visaType: input.visaType } : {}),
        ...(input.entryType !== undefined ? { entryType: input.entryType } : {}),
        ...(input.processing !== undefined ? { processing: input.processing } : {}),
        receivedDate: input.receivedDate,
        applicants: input.applicants,
      },
      actorEmail,
    ),
};

type UpdateCaseToolInput = {
  caseId: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  submissionDate?: string;
  appointmentDate?: string;
  expectedCollectionDate?: string;
};

const updateCaseTool: AgentTool<UpdateCaseToolInput> = {
  name: "update_case",
  kind: "write",
  description:
    "Propose changing a case's visa type, entry type, processing speed, or its submission / " +
    "appointment / expected-collection dates. Staged for human approval -- this never writes on " +
    "its own, and its input schema has no caseStatus, custody, outcome or billingStatus field: " +
    "those each have their own state machine and their own tool.",
  inputSchema: z.object({
    caseId: z.string().min(1),
    visaType: z.enum(crm.VISA_TYPES).optional(),
    entryType: z.enum(crm.ENTRY_TYPES).optional(),
    processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
    submissionDate: z.string().optional(),
    appointmentDate: z.string().optional(),
    expectedCollectionDate: z.string().optional(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const currentCase = await getCase(context, tenantId, input.caseId);
    const summary: ProposedChange["summary"] = [];
    if (input.visaType !== undefined) {
      summary.push({ field: "visaType", from: currentCase.visaType ?? NOT_SET_FROM, to: input.visaType });
    }
    if (input.entryType !== undefined) {
      summary.push({ field: "entryType", from: currentCase.entryType ?? NOT_SET_FROM, to: input.entryType });
    }
    if (input.processing !== undefined) {
      summary.push({ field: "processing", from: currentCase.processing ?? NOT_SET_FROM, to: input.processing });
    }
    if (input.submissionDate !== undefined) {
      summary.push({
        field: "submissionDate",
        from: currentCase.submissionDate ?? NOT_SET_FROM,
        to: input.submissionDate,
      });
    }
    if (input.appointmentDate !== undefined) {
      summary.push({
        field: "appointmentDate",
        from: currentCase.appointmentDate ?? NOT_SET_FROM,
        to: input.appointmentDate,
      });
    }
    if (input.expectedCollectionDate !== undefined) {
      summary.push({
        field: "expectedCollectionDate",
        from: currentCase.expectedCollectionDate ?? NOT_SET_FROM,
        to: input.expectedCollectionDate,
      });
    }
    // Every field this tool can touch is optional, so `{ caseId }` alone is a
    // legal call -- and an approval card with zero rows gives the human
    // nothing to judge. Refuse it here rather than proposing an empty diff.
    if (summary.length === 0) {
      throw badRequest("update_case needs at least one field to change");
    }
    return proposalFrom(context, "update_case", input, summary, actorEmail, input.caseId);
  },
  apply: async (context, tenantId, input, actorEmail) =>
    // A six-field literal, not `input` itself: `input` is `UpdateCaseToolInput`,
    // which also carries `caseId`, and it only *happens* to be safe to hand to
    // `updateCaseDetails` wholesale because that function is allow-list based.
    // The design premise here is "never trust the caller's object shape" --
    // keeping the two independent means a future field added to one cannot
    // silently reach the other.
    updateCaseDetails(
      context,
      tenantId,
      input.caseId,
      {
        ...(input.visaType !== undefined ? { visaType: input.visaType } : {}),
        ...(input.entryType !== undefined ? { entryType: input.entryType } : {}),
        ...(input.processing !== undefined ? { processing: input.processing } : {}),
        ...(input.submissionDate !== undefined ? { submissionDate: input.submissionDate } : {}),
        ...(input.appointmentDate !== undefined ? { appointmentDate: input.appointmentDate } : {}),
        ...(input.expectedCollectionDate !== undefined
          ? { expectedCollectionDate: input.expectedCollectionDate }
          : {}),
      },
      actorEmail,
    ),
};

type AddLineItemToolInput = {
  caseId: string;
  lineItemCode: string;
  quantity: number;
  unitPriceInr: number;
};

const addLineItemTool: AgentTool<AddLineItemToolInput> = {
  name: "add_line_item",
  kind: "write",
  description:
    "Propose adding a billable line to a case. Staged for human approval -- this never writes on " +
    "its own. lineItemCode must be one of the catalog codes; an unknown code is rejected when the " +
    "proposal is applied, not here.",
  inputSchema: z.object({
    caseId: z.string().min(1),
    // Not z.enum(catalog codes): the catalog is addLineItem's to police (it
    // already produces the 400 for an unknown code), and duplicating that
    // check here is a second copy of the list that can drift from the first.
    lineItemCode: z.string().min(1),
    quantity: z.number().int().positive(),
    unitPriceInr: z.number().int().nonnegative(),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const currentCase = await getCase(context, tenantId, input.caseId);
    // addLineItem owns the totalInr arithmetic (amountInr x quantity, summed
    // over every stored line); recomputing it here would be a second copy of
    // that sum, one edit away from disagreeing with the real bill. The diff
    // describes the line being added and reports the CURRENT stored total,
    // not a total this tool worked out itself.
    return proposalFrom(
      context,
      "add_line_item",
      input,
      [
        {
          field: "lineItems",
          from: `${currentCase.lineItems.length} line(s), totalInr ${currentCase.totalInr}`,
          to: `+${input.quantity} x ${input.lineItemCode} @ ${input.unitPriceInr}/unit`,
        },
      ],
      actorEmail,
      input.caseId,
    );
  },
  apply: async (context, tenantId, input, actorEmail) =>
    addLineItem(
      context,
      tenantId,
      input.caseId,
      {
        lineItemCode: input.lineItemCode,
        quantity: input.quantity,
        unitPriceInr: input.unitPriceInr,
      },
      actorEmail,
    ),
};

type SetCustodyToolInput = {
  caseId: string;
  applicantRef: string;
  custody: crm.CustodyStatus;
};

const setCustodyTool: AgentTool<SetCustodyToolInput> = {
  name: "set_custody",
  kind: "write",
  description:
    "Propose moving one applicant's passport-custody status on a case. Staged for human approval " +
    "-- this never writes on its own.",
  inputSchema: z.object({
    caseId: z.string().min(1),
    applicantRef: z.string().min(1),
    custody: z.enum(crm.CUSTODY_STATUSES),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const currentCase = await getCase(context, tenantId, input.caseId);
    const currentApplicant = currentCase.applicants.find(
      (applicant) => applicant.applicantRef === input.applicantRef,
    );
    if (currentApplicant === undefined) {
      throw notFound("Applicant");
    }
    return proposalFrom(
      context,
      "set_custody",
      input,
      [
        {
          field: `applicants.${input.applicantRef}.custody`,
          from: currentApplicant.custody,
          to: input.custody,
        },
      ],
      actorEmail,
      input.caseId,
    );
  },
  apply: async (context, tenantId, input, actorEmail) =>
    changeApplicantCustody(context, tenantId, input.caseId, input.applicantRef, input.custody, actorEmail),
};

type SetBillingToolInput = {
  caseId: string;
  billingStatus: crm.BillingStatus;
};

const setBillingTool: AgentTool<SetBillingToolInput> = {
  name: "set_billing",
  kind: "write",
  description:
    "Propose moving a case's billing status. Staged for human approval -- this never writes on its own.",
  inputSchema: z.object({
    caseId: z.string().min(1),
    billingStatus: z.enum(crm.BILLING_STATUSES),
  }),
  execute: async (context, tenantId, input, actorEmail) => {
    // A read, to build a diff the approver can actually judge -- never a write.
    const currentCase = await getCase(context, tenantId, input.caseId);
    return proposalFrom(
      context,
      "set_billing",
      input,
      [{ field: "billingStatus", from: currentCase.billingStatus, to: input.billingStatus }],
      actorEmail,
      input.caseId,
    );
  },
  apply: async (context, tenantId, input, actorEmail) =>
    changeBillingStatus(context, tenantId, input.caseId, input.billingStatus, actorEmail),
};

export const WRITE_TOOLS: AgentTool[] = [
  createCaseTool,
  updateCaseTool,
  addLineItemTool,
  setCustodyTool,
  setBillingTool,
  rememberTool,
  forgetTool,
];
