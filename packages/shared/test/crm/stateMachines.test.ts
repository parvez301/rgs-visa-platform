import { describe, expect, it } from "vitest";
import {
  canTransitionBilling,
  canTransitionCaseStatus,
  canTransitionCustody,
  canTransitionOutcome,
  deriveCaseStatusFromApplicants,
  isCaseClosable,
} from "../../src/crm/stateMachines";

describe("case status machine", () => {
  it("walks the happy path forward", () => {
    expect(canTransitionCaseStatus("NEW", "IN_PROGRESS")).toBe(true);
    expect(canTransitionCaseStatus("IN_PROGRESS", "APPOINTMENT_SET")).toBe(true);
    expect(canTransitionCaseStatus("APPOINTMENT_SET", "SUBMITTED")).toBe(true);
    expect(canTransitionCaseStatus("SUBMITTED", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("DECIDED", "CLOSED")).toBe(true);
  });

  it("allows skipping the appointment step, since e-visas have no appointment", () => {
    expect(canTransitionCaseStatus("IN_PROGRESS", "SUBMITTED")).toBe(true);
  });

  it("refuses to move backwards", () => {
    expect(canTransitionCaseStatus("SUBMITTED", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("DECIDED", "SUBMITTED")).toBe(false);
  });

  it("refuses to leave a terminal status", () => {
    expect(canTransitionCaseStatus("CLOSED", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("WITHDRAWN", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("DUPLICATE", "NEW")).toBe(false);
  });

  it("allows the off-ramps from any live status", () => {
    for (const liveStatus of ["NEW", "IN_PROGRESS", "APPOINTMENT_SET", "SUBMITTED"] as const) {
      expect(canTransitionCaseStatus(liveStatus, "WITHDRAWN")).toBe(true);
      expect(canTransitionCaseStatus(liveStatus, "DUPLICATE")).toBe(true);
      expect(canTransitionCaseStatus(liveStatus, "NOT_SUBMITTED")).toBe(true);
    }
  });

  it("reaches DECIDED and CLOSED from any live status, since real rows skip steps", () => {
    // REF 31376: Status "Handover" (-> CLOSED) with no prior DECIDED.
    expect(canTransitionCaseStatus("IN_PROGRESS", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("IN_PROGRESS", "CLOSED")).toBe(true);
    expect(canTransitionCaseStatus("SUBMITTED", "CLOSED")).toBe(true);
    expect(canTransitionCaseStatus("NEW", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("NEW", "CLOSED")).toBe(true);
    expect(canTransitionCaseStatus("APPOINTMENT_SET", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("APPOINTMENT_SET", "CLOSED")).toBe(true);
  });

  it("agrees with deriveCaseStatusFromApplicants once it reports DECIDED", () => {
    const derivedStatus = deriveCaseStatusFromApplicants("IN_PROGRESS", ["APPROVED"]);
    expect(derivedStatus).toBe("DECIDED");
    expect(canTransitionCaseStatus("IN_PROGRESS", derivedStatus)).toBe(true);
  });

  it("still refuses to re-enter a terminal status even after widening DECIDED/CLOSED reachability", () => {
    expect(canTransitionCaseStatus("WITHDRAWN", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("WITHDRAWN", "DECIDED")).toBe(false);
    expect(canTransitionCaseStatus("WITHDRAWN", "CLOSED")).toBe(false);
    expect(canTransitionCaseStatus("CLOSED", "DECIDED")).toBe(false);
  });
});

describe("custody machine", () => {
  it("walks a passport through the desk and back", () => {
    expect(canTransitionCustody("NOT_HELD", "WITH_RGS")).toBe(true);
    expect(canTransitionCustody("WITH_RGS", "AT_EMBASSY")).toBe(true);
    expect(canTransitionCustody("AT_EMBASSY", "WITH_RGS")).toBe(true);
    expect(canTransitionCustody("WITH_RGS", "IN_TRANSIT")).toBe(true);
    expect(canTransitionCustody("IN_TRANSIT", "RETURNED")).toBe(true);
    expect(canTransitionCustody("IN_TRANSIT", "WITH_RGS")).toBe(true);
  });

  it("allows handing a passport straight back without couriering it", () => {
    expect(canTransitionCustody("WITH_RGS", "RETURNED")).toBe(true);
  });

  it("refuses to send a passport we do not hold to an embassy", () => {
    expect(canTransitionCustody("NOT_HELD", "AT_EMBASSY")).toBe(false);
  });

  it("refuses to reopen a returned passport", () => {
    expect(canTransitionCustody("RETURNED", "WITH_RGS")).toBe(false);
  });
});

describe("billing machine", () => {
  it("walks the happy path", () => {
    expect(canTransitionBilling("UNBILLED", "BILL_SENT")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "PAID")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "PART_PAID")).toBe(true);
    expect(canTransitionBilling("PART_PAID", "PAID")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "WRITTEN_OFF")).toBe(true);
    expect(canTransitionBilling("UNBILLED", "WRITTEN_OFF")).toBe(true);
  });

  it("refuses to unpay", () => {
    expect(canTransitionBilling("PAID", "BILL_SENT")).toBe(false);
    expect(canTransitionBilling("WRITTEN_OFF", "BILL_SENT")).toBe(false);
  });

  it("lets a migrated UNKNOWN row be corrected to any real status", () => {
    expect(canTransitionBilling("UNKNOWN", "UNBILLED")).toBe(true);
    expect(canTransitionBilling("UNKNOWN", "PAID")).toBe(true);
  });

  it("never lets the CRM move a case back into UNKNOWN", () => {
    expect(canTransitionBilling("UNBILLED", "UNKNOWN")).toBe(false);
    expect(canTransitionBilling("PAID", "UNKNOWN")).toBe(false);
  });
});

describe("deriveCaseStatusFromApplicants", () => {
  it("becomes DECIDED once every applicant has an outcome", () => {
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "REJECTED"])).toBe("DECIDED");
  });

  it("stays put while any applicant is still pending", () => {
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "PENDING"])).toBe("SUBMITTED");
  });

  it("does not drag a terminal case back to DECIDED", () => {
    expect(deriveCaseStatusFromApplicants("WITHDRAWN", ["APPROVED"])).toBe("WITHDRAWN");
    expect(deriveCaseStatusFromApplicants("CLOSED", ["APPROVED"])).toBe("CLOSED");
  });

  it("treats a case with no applicants as unchanged", () => {
    expect(deriveCaseStatusFromApplicants("IN_PROGRESS", [])).toBe("IN_PROGRESS");
  });

  it("does not treat a sent-back applicant as decided", () => {
    // SENT_BACK is a file returning to work, not a decision on it.
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["SENT_BACK"])).toBe("SUBMITTED");
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "SENT_BACK"])).toBe(
      "SUBMITTED",
    );
  });
});

describe("the embassy sends one file of three back for a corrected photo", () => {
  it("leaves the case workable, and lets the resubmission be recorded", () => {
    // Two of the three applicants are approved; the embassy returns the third
    // for a new photo and ops records SENT_BACK.
    const outcomesAfterTheReturn = ["APPROVED", "APPROVED", "SENT_BACK"] as const;

    // The file is actively being re-worked, so the case must NOT read DECIDED —
    // DECIDED's only successor is CLOSED, and the case would drop out of every
    // live queue while ops is still working it.
    expect(deriveCaseStatusFromApplicants("SUBMITTED", outcomesAfterTheReturn)).toBe("SUBMITTED");

    // Ops fixes the photo and resubmits: the returned applicant goes back into
    // the queue as PENDING. This is the resubmission path.
    expect(canTransitionOutcome("SENT_BACK", "PENDING")).toBe(true);
    const outcomesAfterTheResubmission = ["APPROVED", "APPROVED", "PENDING"] as const;
    expect(deriveCaseStatusFromApplicants("SUBMITTED", outcomesAfterTheResubmission)).toBe(
      "SUBMITTED",
    );

    // Only when the resubmitted file is actually decided does the case decide.
    expect(canTransitionOutcome("PENDING", "APPROVED")).toBe(true);
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "APPROVED", "APPROVED"])).toBe(
      "DECIDED",
    );
  });
});

describe("isCaseClosable", () => {
  it("closes when every passport is back and the bill is settled", () => {
    expect(isCaseClosable(["RETURNED", "RETURNED"], "PAID")).toBe(true);
    expect(isCaseClosable(["RETURNED"], "WRITTEN_OFF")).toBe(true);
  });

  it("stays open while a passport is still out", () => {
    expect(isCaseClosable(["RETURNED", "IN_TRANSIT"], "PAID")).toBe(false);
  });

  it("stays open while the bill is unsettled", () => {
    expect(isCaseClosable(["RETURNED"], "BILL_SENT")).toBe(false);
  });

  it("never auto-closes a migrated case whose billing is UNKNOWN", () => {
    expect(isCaseClosable(["RETURNED"], "UNKNOWN")).toBe(false);
  });
});

describe("outcome machine", () => {
  it("decides a pending applicant, whichever way it goes", () => {
    expect(canTransitionOutcome("PENDING", "APPROVED")).toBe(true);
    expect(canTransitionOutcome("PENDING", "REJECTED")).toBe(true);
    expect(canTransitionOutcome("PENDING", "SENT_BACK")).toBe(true);
  });

  it("allows only the edges the spec names, plus the resubmission path", () => {
    // Spec §5 line 221 specifies exactly PENDING -> APPROVED | REJECTED |
    // SENT_BACK. Everything else this table once held was invented here, and
    // statuses and transitions come from @rgs/shared verbatim.
    for (const inventedTransition of [
      ["APPROVED", "REJECTED"],
      ["APPROVED", "SENT_BACK"],
      ["REJECTED", "APPROVED"],
      ["REJECTED", "SENT_BACK"],
      ["SENT_BACK", "APPROVED"],
      ["SENT_BACK", "REJECTED"],
    ] as const) {
      expect(canTransitionOutcome(inventedTransition[0], inventedTransition[1])).toBe(false);
    }
  });

  it("refuses to un-decide an applicant, which is what breaks the DECIDED derivation", () => {
    expect(canTransitionOutcome("APPROVED", "PENDING")).toBe(false);
    expect(canTransitionOutcome("REJECTED", "PENDING")).toBe(false);
  });

  it("sends a returned file back into the queue, because a resubmission is not a decision", () => {
    expect(canTransitionOutcome("SENT_BACK", "PENDING")).toBe(true);
  });

  it("refuses a no-op, the same as the custody and billing machines", () => {
    expect(canTransitionOutcome("PENDING", "PENDING")).toBe(false);
    expect(canTransitionOutcome("APPROVED", "APPROVED")).toBe(false);
    // The two machines this one is modelled on, for comparison.
    expect(canTransitionCustody("WITH_RGS", "WITH_RGS")).toBe(false);
    expect(canTransitionBilling("BILL_SENT", "BILL_SENT")).toBe(false);
  });

  it("keeps every applicant a DECIDED case holds out of PENDING", () => {
    // deriveCaseStatusFromApplicants short-circuits once a case is DECIDED, so
    // an applicant slipping back to PENDING would leave a DECIDED case holding
    // a pending applicant — the contradiction this machine exists to prevent.
    // Only APPROVED and REJECTED can put a case in DECIDED, so only they are
    // barred; SENT_BACK never decides a case, and must be able to go back.
    for (const decidedOutcome of ["APPROVED", "REJECTED"] as const) {
      expect(canTransitionOutcome(decidedOutcome, "PENDING")).toBe(false);
    }
  });
});
