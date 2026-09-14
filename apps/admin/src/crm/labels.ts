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
 * `undefined` is a real and different answer: a case imported before the
 * roll-up existed has no summary, and "Not summarised" is the honest thing to
 * show. A zero would claim the case has no applicants.
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
