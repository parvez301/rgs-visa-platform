import {
  LIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  type ApplicantOutcome,
  type BillingStatus,
  type CaseStatus,
  type CustodyStatus,
} from "./statuses";

// DECIDED and CLOSED are reachable from every live status, not just their
// happy-path predecessor: real e-visas are approved with no recorded
// SUBMITTED step, and non-visa cases (ATTESTATION/APOSTILLE/PASSPORT) close
// via custody + billing without ever earning a per-applicant outcome
// (spec §5 line 229, §6 line 261; e.g. REF 31376, Status "Handover", no
// prior DECIDED).
const CASE_STATUS_FORWARD_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  NEW: ["IN_PROGRESS", "APPOINTMENT_SET", "SUBMITTED", "DECIDED", "CLOSED"],
  IN_PROGRESS: ["APPOINTMENT_SET", "SUBMITTED", "DECIDED", "CLOSED"],
  APPOINTMENT_SET: ["SUBMITTED", "DECIDED", "CLOSED"],
  SUBMITTED: ["DECIDED", "CLOSED"],
  DECIDED: ["CLOSED"],
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
 * A case becomes DECIDED once every applicant has a non-PENDING outcome.
 * Terminal cases are never dragged back — migrated rows keep the status the
 * import assigned them (spec §5).
 */
export function deriveCaseStatusFromApplicants(
  currentCaseStatus: CaseStatus,
  applicantOutcomes: readonly ApplicantOutcome[],
): CaseStatus {
  if (TERMINAL_CASE_STATUSES.includes(currentCaseStatus)) {
    return currentCaseStatus;
  }
  if (currentCaseStatus === "DECIDED" || applicantOutcomes.length === 0) {
    return currentCaseStatus;
  }
  const everyApplicantDecided = applicantOutcomes.every(
    (applicantOutcome) => applicantOutcome !== "PENDING",
  );
  return everyApplicantDecided ? "DECIDED" : currentCaseStatus;
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
