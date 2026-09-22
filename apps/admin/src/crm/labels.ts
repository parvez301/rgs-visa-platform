import { crm } from "@rgs/shared";

/**
 * The single display-label map. RGS reviews these in their own words, and a
 * wording change happens here and nowhere else.
 *
 * Every map is a TOTAL Record, not a lookup with a fallback: a total record
 * stops compiling the day a tenth case status is added to the shared package,
 * whereas `labels[value] ?? value` compiles forever and ships NOT_SUBMITTED to
 * a desk agent's screen.
 */
export const CASE_STATUS_LABELS: Record<crm.CaseStatus, string> = {
  NEW: "New",
  IN_PROGRESS: "In progress",
  APPOINTMENT_SET: "Appointment set",
  SUBMITTED: "Submitted",
  DECIDED: "Decided",
  CLOSED: "Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};

export const CUSTODY_LABELS: Record<crm.CustodyStatus, string> = {
  NOT_HELD: "Not held",
  WITH_RGS: "With us",
  AT_EMBASSY: "At embassy",
  IN_TRANSIT: "In transit",
  RETURNED: "Returned",
};

export const OUTCOME_LABELS: Record<crm.ApplicantOutcome, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

export const BILLING_LABELS: Record<crm.BillingStatus, string> = {
  UNBILLED: "Unbilled",
  BILL_SENT: "Bill sent",
  PAID: "Paid",
  PART_PAID: "Part paid",
  WRITTEN_OFF: "Written off",
  UNKNOWN: "Unknown",
};

export const CASE_TYPE_LABELS: Record<crm.CaseType, string> = {
  VISA: "Visa",
  ATTESTATION: "Attestation",
  APOSTILLE: "Apostille",
  PASSPORT: "Passport",
  OTHER: "Other",
};

/**
 * `ENTRY_TYPES` and `PROCESSING_SPEEDS` (packages/shared/src/crm/statuses.ts).
 * Neither the Ledger nor the Case screen renders these today -- the agent
 * panel is the first surface that has to, because `update_case` can propose
 * either of them and a proposal card showing `PREMIUM_LOUNGE` to a desk agent
 * is the raw-enum rule broken in the one place a human is being asked to
 * approve something.
 */
export const ENTRY_TYPE_LABELS: Record<crm.EntryType, string> = {
  SINGLE: "Single entry",
  DOUBLE: "Double entry",
  MULTIPLE: "Multiple entry",
};

export const PROCESSING_LABELS: Record<crm.ProcessingSpeed, string> = {
  NORMAL: "Normal",
  EXPRESS: "Express",
  PREMIUM_LOUNGE: "Premium lounge",
};

/**
 * The seven write tools the agent can propose from, as the sentence a card
 * headline uses. Deliberately NOT a total Record over a shared union: tool
 * names cross the wire as plain strings on `ProposedChange.toolName` and the
 * backend can add one this build has never heard of, which is what
 * `describeEnumValue` is for.
 */
export const PROPOSAL_TOOL_LABELS: Record<string, string> = {
  create_case: "Create a case",
  update_case: "Change case details",
  add_line_item: "Add a line item",
  set_custody: "Move passport custody",
  set_billing: "Move billing status",
  remember: "Remember a fact",
  forget: "Forget a remembered fact",
};

export const COURIER_LABELS: Record<crm.CourierMode, string> = {
  DTDC: "DTDC",
  SPEEDPOST: "Speed Post",
  BLUEDART: "Blue Dart",
  PORTER: "Porter",
  HANDOVER: "Handover",
  PICKUP: "Pickup",
};

/** VISA_TYPES has twenty members; write all twenty out. Sentence case, and the
 *  acronyms RGS actually says: "B1/B2", "e-Visa (tourist)", "MDAC", "VEVO". */
export const VISA_TYPE_LABELS: Record<crm.VisaType, string> = {
  TOURIST: "Tourist",
  BUSINESS: "Business",
  EVISA_TOURIST: "e-Visa (tourist)",
  B1_B2: "B1/B2",
  FAMILY_VISIT: "Family visit",
  DEPENDENT: "Dependent",
  STUDY: "Study",
  WORK: "Work",
  SEAMAN: "Seaman",
  RELATIVE: "Relative",
  TRADE_FAIR: "Trade fair",
  SPORTS: "Sports",
  TRANSIT: "Transit",
  MDAC: "MDAC",
  STP: "STP",
  STR: "STR",
  F_VISA: "F visa",
  VEVO: "VEVO",
  E_VISA: "e-Visa",
  OTHER: "Other",
};

/**
 * The collapsed parent row's whole job (spec §4): carry enough per-applicant
 * signal that expanding is rarely needed. One value when every applicant
 * agrees; counts, commonest first, when they do not.
 *
 * "Not summarised" deliberately covers two different inputs, not one:
 * `counts === undefined` (a case imported before the roll-up existed, so it
 * carries no summary at all) and a present-but-empty summary (every state's
 * count is zero or absent). Both get the same honest answer because neither
 * has anything truer to say -- a zero would claim the case has no
 * applicants, which is not what either input means.
 *
 * The empty-but-present case is unreachable today: `CrmCaseSchema` requires
 * at least one applicant, so a real case cannot summarise to zero states. If
 * it ever shows up in practice, the bug is upstream of this function (in
 * whatever produced the summary), not something this string should grow a
 * second message to paper over.
 */
export function describeCustodyRollUp(summary: crm.ApplicantSummary | undefined): string {
  return describeRollUp(summary?.custody, CUSTODY_LABELS);
}

export function describeOutcomeRollUp(summary: crm.ApplicantSummary | undefined): string {
  return describeRollUp(summary?.outcome, OUTCOME_LABELS);
}

function describeRollUp<StateType extends string>(
  counts: Partial<Record<StateType, number>> | undefined,
  labels: Record<StateType, string>,
): string {
  if (counts === undefined) return "Not summarised";
  const presentStates = (Object.entries(counts) as [StateType, number][])
    .filter(([, stateCount]) => stateCount > 0)
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount);
  if (presentStates.length === 0) return "Not summarised";
  const [firstState] = presentStates;
  if (presentStates.length === 1) return labels[firstState![0]];
  return presentStates
    .map(([stateName, stateCount]) => `${stateCount} ${labels[stateName].toLowerCase()}`)
    .join(" · ");
}

/**
 * Why the workbook import could not apply a row deterministically, in the words
 * a desk agent cleaning their own data would use. `crm.REVIEW_REASONS` is a
 * thirteen-member union (packages/shared/src/crm/reviewItem.ts), and this is a
 * TOTAL Record over it for the same reason every map above is: a fourteenth
 * reason added to the shared package must stop this file compiling rather than
 * ship `COLUMN_SHIFT_JUNK` to somebody's screen.
 *
 * Each label names WHAT IS WRONG, never what to do about it: the two merge
 * reasons state a suspicion about two rows ("May belong with another case"),
 * the UNMAPPED_* family states that one cell could not be understood, and
 * UNCONFIRMED_PAYMENT states a value that WAS understood and was deliberately
 * not applied. Those are three different kinds of work and the wording is what
 * tells them apart in a list.
 */
export const REVIEW_REASON_LABELS: Record<crm.ReviewReason, string> = {
  UNMAPPED_STATUS: "Status not recognised",
  UNMAPPED_ENTRIES: "Number of entries not recognised",
  UNMAPPED_VISA_TYPE: "Visa type not recognised",
  UNMAPPED_COUNTRY: "Country not recognised",
  UNMAPPED_PARTNER: "Partner not recognised",
  UNPARSEABLE_DATE: "Date could not be read",
  COLUMN_SHIFT_JUNK: "Columns look shifted",
  SUSPECT_PHONE: "Phone number looks wrong",
  PROPOSED_GROUP: "May belong with another case",
  DUPLICATE_REF: "Same REF as another case",
  MISSING_REQUIRED_FIELD: "Required value missing from the sheet",
  UNREADABLE_STORED_CASE: "Stored case could not be read",
  UNCONFIRMED_PAYMENT: "Payment not confirmed",
};

export const LINE_ITEM_KIND_LABELS: Record<crm.LineItemKind, string> = {
  SERVICE: "Service",
  GOVT_FEE: "Government fee",
  ADDON: "Add-on",
};

/**
 * The three memory scope KINDS, as words. Deliberately NOT a total Record over
 * a shared union: `CrmMemorySchema.scope` is a free `z.string().min(1)`
 * (schemas.ts:156), so an unrecognised kind is reachable in a way an
 * unrecognised case status is not -- `describeEnumValue` below is what names
 * it rather than rendering a blank.
 *
 * These are the KIND half of a stored scope, never the whole stored value:
 * see `describeMemoryScope` below, which is the only thing that should read
 * this map.
 */
export const MEMORY_SCOPE_LABELS: Record<"ORG" | "PARTNER" | "USER", string> = {
  ORG: "the whole organisation",
  PARTNER: "one partner",
  USER: "one desk",
};

const MEMORY_SCOPE_SEPARATOR = "#";

/**
 * Names the scope a memory was remembered for, from the value actually stored
 * on it.
 *
 * Fix round 1, F1. A memory's `scope` is a COMPOSITE string -- `"ORG"`,
 * `"PARTNER#<partnerId>"` or `"USER#<email>"` (services/api/src/domain/crm/
 * keys.ts:154-156, "never a (kind, key) pair") -- and
 * `recordCrmEvent`/`MEMORY_REMEMBERED` carries that composite through verbatim
 * (domain/crm/memory.ts:180). Looking the whole composite up in
 * `MEMORY_SCOPE_LABELS`, which is keyed on the three KINDS the caller-facing
 * `?scope=` query parameter uses, therefore matched only `"ORG"`: the other
 * two thirds of the vocabulary rendered as "an unrecognised value
 * (PARTNER#partner_1)".
 *
 * The key is named as well as the kind, because "one partner" without saying
 * WHICH partner is barely more use on an audit surface than the raw string
 * was. The split takes the FIRST separator only: an email local part may
 * legally contain one, and truncating a scope at the second `#` would rename
 * the desk it belongs to.
 */
export function describeMemoryScope(storedScope: string | undefined): string {
  if (storedScope === undefined) return "not recorded";
  const separatorIndex = storedScope.indexOf(MEMORY_SCOPE_SEPARATOR);
  const scopeKind = separatorIndex === -1 ? storedScope : storedScope.slice(0, separatorIndex);
  const scopeKey = separatorIndex === -1 ? undefined : storedScope.slice(separatorIndex + 1);
  // Widened before indexing: `MEMORY_SCOPE_LABELS` is keyed on a three-member
  // union, and `scopeKind` is whatever the backend stored, so under
  // `noUncheckedIndexedAccess` the narrow type would reject the lookup rather
  // than admit the `undefined` that is the whole point of the branch below.
  const scopeKindLabels: Readonly<Record<string, string>> = MEMORY_SCOPE_LABELS;
  const scopeKindLabel = scopeKindLabels[scopeKind];
  // A kind this build has never heard of is named whole, separator included:
  // splitting a scope we cannot interpret would hide half of what an operator
  // needs to report.
  if (scopeKindLabel === undefined) return describeEnumValue(storedScope, scopeKindLabels);
  return scopeKey === undefined ? scopeKindLabel : `${scopeKindLabel} (${scopeKey})`;
}

/**
 * `CrmMemorySchema.createdBy` -- "what kind of author", not who. The same
 * human-vs-machine distinction `autoApplied` draws on PROPOSAL_APPROVED, which
 * is why it is rendered rather than dropped.
 */
export const MEMORY_AUTHOR_LABELS: Record<"agent" | "human", string> = {
  agent: "the agent",
  human: "a person",
};

/**
 * The field names `updateCaseDetails` can put in a `CASE_UPDATED` event's
 * comma-joined `changedFields` (services/api/src/domain/crm/cases.ts:152-174),
 * as the words a sentence about them uses. Lower case: these are read mid
 * sentence ("Changed appointment date and visa type"), never as a heading.
 */
export const CASE_FIELD_LABELS: Record<string, string> = {
  visaType: "visa type",
  entryType: "entry type",
  processing: "processing speed",
  submissionDate: "submission date",
  appointmentDate: "appointment date",
  expectedCollectionDate: "expected collection date",
  remarks: "remarks",
};

/**
 * One money format for the whole desk. Rupees, no paise: every stored amount
 * is `z.number().int()` (schemas.ts), so a decimal place would be two digits
 * of precision the data does not have.
 */
const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function formatInr(amountInr: number): string {
  return inrFormatter.format(amountInr);
}

/**
 * The combined "Type" reading the Ledger's own Type column shows, shared with
 * the Case screen so the two never drift apart. Structurally typed rather than
 * taking a `LedgerRow`: a `CrmCase` carries the same two fields and has as much
 * right to this sentence.
 */
export function describeCaseType(caseFields: {
  caseType: crm.CaseType;
  visaType?: crm.VisaType;
}): string {
  const caseTypeLabel = CASE_TYPE_LABELS[caseFields.caseType];
  if (caseFields.visaType === undefined) return caseTypeLabel;
  return `${caseTypeLabel} · ${VISA_TYPE_LABELS[caseFields.visaType]}`;
}

/**
 * A label for a value that arrived over the wire as a plain string.
 *
 * The label maps above are total Records over their unions, which is what
 * makes a missing label a compile error rather than a blank on screen -- but a
 * value read out of an event's `meta` is a `string`, not a union member, and
 * nothing stops a backend plan from writing one this build has never heard of.
 * Naming it (rather than rendering the bare value as though it were a label,
 * or rendering nothing at all) is the same bargain the timeline strikes with
 * an unrecognised event type: an operator can report what they saw.
 */
export function describeEnumValue(
  rawValue: string | undefined,
  labels: Readonly<Record<string, string>>,
): string {
  if (rawValue === undefined) return "not recorded";
  return labels[rawValue] ?? `an unrecognised value (${rawValue})`;
}
