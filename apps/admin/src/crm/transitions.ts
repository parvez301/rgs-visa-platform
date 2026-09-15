import { crm } from "@rgs/shared";

/**
 * What each state machine actually allows, as the option list a `<select>` can
 * be built from.
 *
 * A dropdown listing every value invites a click that 409s.
 * `crm.canTransition*` are the same rules the server enforces, so the offered
 * list and the server agree by construction. The current value always stays in
 * the list -- a `<select>` whose `value` names an absent `<option>` renders
 * blank.
 *
 * One home for all four because two screens now need them: the Ledger's
 * `EditableCell` (case status, billing) and the Case screen (those two plus
 * the per-applicant custody and outcome axes). A second copy of the
 * "filter the enum by the state machine, keep the current value" rule is how
 * the two screens end up offering different options for the same case.
 */
export function allowedCaseStatusOptions(currentCaseStatus: crm.CaseStatus): crm.CaseStatus[] {
  return crm.CASE_STATUSES.filter(
    (candidateCaseStatus) =>
      candidateCaseStatus === currentCaseStatus ||
      crm.canTransitionCaseStatus(currentCaseStatus, candidateCaseStatus),
  );
}

export function allowedBillingStatusOptions(currentBillingStatus: crm.BillingStatus): crm.BillingStatus[] {
  return crm.BILLING_STATUSES.filter(
    (candidateBillingStatus) =>
      candidateBillingStatus === currentBillingStatus ||
      crm.canTransitionBilling(currentBillingStatus, candidateBillingStatus),
  );
}

export function allowedCustodyOptions(currentCustody: crm.CustodyStatus): crm.CustodyStatus[] {
  return crm.CUSTODY_STATUSES.filter(
    (candidateCustody) =>
      candidateCustody === currentCustody || crm.canTransitionCustody(currentCustody, candidateCustody),
  );
}

export function allowedOutcomeOptions(currentOutcome: crm.ApplicantOutcome): crm.ApplicantOutcome[] {
  return crm.APPLICANT_OUTCOMES.filter(
    (candidateOutcome) =>
      candidateOutcome === currentOutcome || crm.canTransitionOutcome(currentOutcome, candidateOutcome),
  );
}

/**
 * True when the only option a control can offer is the value it already holds
 * -- `RETURNED` custody, a decided `APPROVED`/`REJECTED` outcome, a `CLOSED`
 * case. Such a control is rendered disabled with a reason rather than as a
 * one-item dropdown that looks live and does nothing.
 */
export function hasNoLegalMove(allowedOptions: readonly string[]): boolean {
  return allowedOptions.length <= 1;
}
