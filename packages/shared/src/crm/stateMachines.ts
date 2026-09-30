import {
  LIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  type ApplicantOutcome,
  type BillingStatus,
  type CaseStatus,
  type CustodyStatus,
} from "./statuses";

// Every live status can reach any LATER happy-path status and CLOSED, not just
// its immediate successor: real e-visas are approved with no recorded
// SUBMITTED step, and non-visa cases (ATTESTATION/APOSTILLE/PASSPORT) close
// via custody + billing without ever earning a per-applicant outcome
// (spec §5 line 229, §6 line 261; e.g. REF 31376, Status "Handover", no
// prior DECIDED). The stages between NEW and PASSPORT_RECEIVED are desk-set,
// so skipping any of them has to stay legal too.
const CASE_STATUS_HAPPY_PATH: readonly CaseStatus[] = [
  "NEW",
  "DOCS_UNDER_REVIEW",
  "ADDITIONAL_DOCS_REQUIRED",
  "READY_FOR_SUBMISSION",
  "APPOINTMENT_SET",
  "SUBMITTED",
  "UNDER_PROCESS",
  "PASSPORT_RECEIVED",
  "DECIDED",
];

// VISA_GRANTED and VISA_REFUSED are siblings, each a verdict on an individual
// case that follows DECIDED: neither leads to the other (but each may widen
// back to DECIDED, see the transition table).
const CASE_STATUS_VERDICTS: readonly CaseStatus[] = ["VISA_GRANTED", "VISA_REFUSED"];

/** Every status strictly after `fromStatus` on the happy path, plus CLOSED. */
function laterHappyPathStatuses(fromStatus: CaseStatus): readonly CaseStatus[] {
  const fromIndex = CASE_STATUS_HAPPY_PATH.indexOf(fromStatus);
  return [...CASE_STATUS_HAPPY_PATH.slice(fromIndex + 1), ...CASE_STATUS_VERDICTS, "CLOSED"];
}

// SUBMITTED is the reopen edge from every decision status, not a step
// backwards for its own sake: a decided case whose embassy hands a passport
// back is live work again. Without it a decision status absorbed the case —
// the off-ramps need a LIVE status, the derivation could not undo itself, and
// the only exit left was to CLOSE a file that had actually come back.
const CASE_STATUS_FORWARD_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  NEW: laterHappyPathStatuses("NEW"),
  DOCS_UNDER_REVIEW: laterHappyPathStatuses("DOCS_UNDER_REVIEW"),
  ADDITIONAL_DOCS_REQUIRED: laterHappyPathStatuses("ADDITIONAL_DOCS_REQUIRED"),
  READY_FOR_SUBMISSION: laterHappyPathStatuses("READY_FOR_SUBMISSION"),
  APPOINTMENT_SET: laterHappyPathStatuses("APPOINTMENT_SET"),
  SUBMITTED: laterHappyPathStatuses("SUBMITTED"),
  UNDER_PROCESS: laterHappyPathStatuses("UNDER_PROCESS"),
  PASSPORT_RECEIVED: laterHappyPathStatuses("PASSPORT_RECEIVED"),
  DECIDED: ["SUBMITTED", "VISA_GRANTED", "VISA_REFUSED", "CLOSED"],
  // A verdict may widen to DECIDED: an individual case that gains a second
  // applicant becomes a group, and a group is always DECIDED.
  VISA_GRANTED: ["SUBMITTED", "DECIDED", "CLOSED"],
  VISA_REFUSED: ["SUBMITTED", "DECIDED", "CLOSED"],
  CLOSED: [],
  NOT_SUBMITTED: [],
  WITHDRAWN: [],
  DUPLICATE: [],
};

/** Off-ramps reachable from any status a case can still move out of. */
const CASE_STATUS_OFF_RAMPS: readonly CaseStatus[] = ["NOT_SUBMITTED", "WITHDRAWN", "DUPLICATE"];

export function canTransitionCaseStatus(
  fromStatus: CaseStatus,
  toStatus: CaseStatus,
): boolean {
  if (TERMINAL_CASE_STATUSES.includes(fromStatus)) {
    return false;
  }
  if (
    CASE_STATUS_OFF_RAMPS.includes(toStatus) &&
    LIVE_CASE_STATUSES.includes(fromStatus)
  ) {
    return true;
  }
  return CASE_STATUS_FORWARD_TRANSITIONS[fromStatus].includes(toStatus);
}

const CUSTODY_TRANSITIONS: Record<CustodyStatus, readonly CustodyStatus[]> = {
  NOT_HELD: ["WITH_RGS"],
  WITH_RGS: ["AT_EMBASSY", "IN_TRANSIT", "RETURNED"],
  AT_EMBASSY: ["WITH_RGS"],
  IN_TRANSIT: ["RETURNED", "WITH_RGS"],
  RETURNED: [],
};

export function canTransitionCustody(
  fromCustody: CustodyStatus,
  toCustody: CustodyStatus,
): boolean {
  return CUSTODY_TRANSITIONS[fromCustody].includes(toCustody);
}

/**
 * PENDING decides in any direction — spec §5 line 221 specifies exactly
 * `PENDING -> APPROVED | REJECTED | SENT_BACK`, and nothing else. SENT_BACK is
 * the one outcome that is not a decision — the embassy has handed the file back
 * for a correction — so it returns to PENDING when the corrected file is
 * resubmitted. Without that edge a returned file could never be re-recorded.
 *
 * A correction path for a mistyped decided outcome (APPROVED <-> REJECTED, and
 * either into SENT_BACK) was deliberately removed: those six edges were
 * invented here, not specified, and this table is the verbatim copy of the
 * spec's machine. If ops genuinely needs to fix a mistyped outcome, that is a
 * spec change, not an edit to this table.
 *
 * A no-op is refused, as in the two machines above.
 */
const OUTCOME_TRANSITIONS: Record<ApplicantOutcome, readonly ApplicantOutcome[]> = {
  PENDING: ["APPROVED", "REJECTED", "SENT_BACK"],
  APPROVED: [],
  REJECTED: [],
  SENT_BACK: ["PENDING"],
};

export function canTransitionOutcome(
  fromOutcome: ApplicantOutcome,
  toOutcome: ApplicantOutcome,
): boolean {
  return OUTCOME_TRANSITIONS[fromOutcome].includes(toOutcome);
}

const BILLING_TRANSITIONS: Record<BillingStatus, readonly BillingStatus[]> = {
  UNKNOWN: ["UNBILLED", "BILL_SENT", "PAID", "PART_PAID", "WRITTEN_OFF"],
  UNBILLED: ["BILL_SENT", "WRITTEN_OFF"],
  BILL_SENT: ["PAID", "PART_PAID", "WRITTEN_OFF"],
  PART_PAID: ["PAID", "WRITTEN_OFF"],
  PAID: [],
  WRITTEN_OFF: [],
};

export function canTransitionBilling(
  fromBilling: BillingStatus,
  toBilling: BillingStatus,
): boolean {
  return BILLING_TRANSITIONS[fromBilling].includes(toBilling);
}

/**
 * A group is a case with a groupName or more than one applicant. Its
 * applicants' verdicts are individual, so no single visa outcome describes the
 * whole case.
 */
export function isCaseGroup(input: {
  groupName?: string | undefined;
  applicantCount: number;
}): boolean {
  return input.groupName !== undefined || input.applicantCount > 1;
}

/**
 * A case becomes a decision status once every applicant is APPROVED or
 * REJECTED, and reopens to SUBMITTED the moment one of them is live again.
 *
 * Which decision status depends on the case shape. A group is always DECIDED —
 * "every applicant approved" is still not one visa granted. An individual case
 * reads VISA_GRANTED or VISA_REFUSED, so the client hears the actual verdict.
 * A mixed outcome can only be a group, but falls back to DECIDED rather than
 * guessing if a caller reports it as an individual.
 *
 * SENT_BACK deliberately does NOT count as a decision. The embassy returning
 * one file for a corrected photo is that file going back into work, not a
 * verdict on it.
 *
 * The reopen half matters as much as the decide half. This used to short-circuit
 * on DECIDED, which meant a case marked decided — by hand via the status route,
 * where the skip-ahead NEW -> DECIDED is legal and intended, or by an import —
 * stayed decided while holding a SENT_BACK or PENDING applicant. Every off-ramp
 * needs a LIVE status, so the only exit left was CLOSED: closing a file the
 * embassy had actually handed back. VISA_GRANTED and VISA_REFUSED reopen the
 * same way.
 *
 * Terminal cases are never dragged back — migrated rows keep the status the
 * import assigned them (spec §5).
 */
export function deriveCaseStatusFromApplicants(
  currentCaseStatus: CaseStatus,
  applicantOutcomes: readonly ApplicantOutcome[],
  options: { isGroup: boolean },
): CaseStatus {
  if (TERMINAL_CASE_STATUSES.includes(currentCaseStatus)) {
    return currentCaseStatus;
  }
  if (applicantOutcomes.length === 0) {
    return currentCaseStatus;
  }
  const everyApplicantDecided = applicantOutcomes.every(
    (applicantOutcome) => applicantOutcome === "APPROVED" || applicantOutcome === "REJECTED",
  );
  if (everyApplicantDecided) {
    if (options.isGroup) {
      return "DECIDED";
    }
    if (applicantOutcomes.every((applicantOutcome) => applicantOutcome === "APPROVED")) {
      return "VISA_GRANTED";
    }
    if (applicantOutcomes.every((applicantOutcome) => applicantOutcome === "REJECTED")) {
      return "VISA_REFUSED";
    }
    return "DECIDED";
  }
  const isDecisionStatus =
    currentCaseStatus === "DECIDED" ||
    currentCaseStatus === "VISA_GRANTED" ||
    currentCaseStatus === "VISA_REFUSED";
  return isDecisionStatus ? "SUBMITTED" : currentCaseStatus;
}

/**
 * Closable when every passport is back with its owner and the bill is settled.
 * UNKNOWN billing (migrated rows only) never satisfies this.
 */
export function isCaseClosable(
  applicantCustodies: readonly CustodyStatus[],
  billingStatus: BillingStatus,
): boolean {
  if (applicantCustodies.length === 0) {
    return false;
  }
  const everyPassportReturned = applicantCustodies.every(
    (applicantCustody) => applicantCustody === "RETURNED",
  );
  const billingSettled = billingStatus === "PAID" || billingStatus === "WRITTEN_OFF";
  return everyPassportReturned && billingSettled;
}
