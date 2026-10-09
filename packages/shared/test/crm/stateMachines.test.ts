import { describe, expect, it } from "vitest";
import {
  canTransitionBilling,
  canTransitionCaseStatus,
  canTransitionCustody,
  canTransitionOutcome,
  deriveCaseStatusFromApplicants,
  isCaseClosable,
  isCaseGroup,
} from "../../src/crm/stateMachines";
import { CASE_STATUSES } from "../../src/crm/statuses";

describe("case status machine", () => {
  it("allows any status to change to any other status (CRM-114)", () => {
    for (const fromStatus of CASE_STATUSES) {
      for (const toStatus of CASE_STATUSES) {
        expect(canTransitionCaseStatus(fromStatus, toStatus)).toBe(fromStatus !== toStatus);
      }
    }
  });

  it("still refuses a no-op same-status transition", () => {
    expect(canTransitionCaseStatus("SUBMITTED", "SUBMITTED")).toBe(false);
    expect(canTransitionCaseStatus("CLOSED", "CLOSED")).toBe(false);
  });

  it("lets a verdict widen to DECIDED, since DECIDED is the neutral superset of a verdict", () => {
    expect(canTransitionCaseStatus("VISA_GRANTED", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("VISA_REFUSED", "DECIDED")).toBe(true);
    const derivedStatus = deriveCaseStatusFromApplicants("VISA_GRANTED", ["APPROVED", "APPROVED"], {
      isGroup: true,
    });
    expect(derivedStatus).toBe("DECIDED");
    expect(canTransitionCaseStatus("VISA_GRANTED", derivedStatus)).toBe(true);
  });

  it("agrees with deriveCaseStatusFromApplicants once it reports a decision", () => {
    const derivedStatus = deriveCaseStatusFromApplicants("DOCS_UNDER_REVIEW", ["APPROVED"], {
      isGroup: false,
    });
    expect(derivedStatus).toBe("VISA_GRANTED");
    expect(canTransitionCaseStatus("DOCS_UNDER_REVIEW", derivedStatus)).toBe(true);
    const derivedGroupStatus = deriveCaseStatusFromApplicants(
      "DOCS_UNDER_REVIEW",
      ["APPROVED", "APPROVED"],
      { isGroup: true },
    );
    expect(derivedGroupStatus).toBe("DECIDED");
    expect(canTransitionCaseStatus("DOCS_UNDER_REVIEW", derivedGroupStatus)).toBe(true);
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

describe("isCaseGroup", () => {
  it("is true when groupName is set even for one applicant", () => {
    expect(isCaseGroup({ groupName: "Sharma Family", applicantCount: 1 })).toBe(true);
    expect(isCaseGroup({ applicantCount: 1 })).toBe(false);
    expect(isCaseGroup({ applicantCount: 2 })).toBe(true);
  });
});

describe("deriveCaseStatusFromApplicants", () => {
  it("derives VISA_GRANTED for an individual when the only applicant is APPROVED", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED"], { isGroup: false }),
    ).toBe("VISA_GRANTED");
  });

  it("derives VISA_REFUSED for an individual when the only applicant is REJECTED", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["REJECTED"], { isGroup: false }),
    ).toBe("VISA_REFUSED");
  });

  it("derives DECIDED for a group even when every applicant is APPROVED", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "APPROVED"], { isGroup: true }),
    ).toBe("DECIDED");
  });

  it("derives DECIDED for a group with mixed APPROVED and REJECTED", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "REJECTED"], { isGroup: true }),
    ).toBe("DECIDED");
  });

  it("falls back to DECIDED for a mixed outcome even when not flagged as a group", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "REJECTED"], { isGroup: false }),
    ).toBe("DECIDED");
  });

  it("stays put while any applicant is still pending", () => {
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "PENDING"], { isGroup: true }),
    ).toBe("SUBMITTED");
  });

  it("does not drag a terminal case back to a decision status", () => {
    expect(
      deriveCaseStatusFromApplicants("WITHDRAWN", ["APPROVED"], { isGroup: false }),
    ).toBe("WITHDRAWN");
    expect(deriveCaseStatusFromApplicants("CLOSED", ["APPROVED"], { isGroup: false })).toBe(
      "CLOSED",
    );
  });

  it("treats a case with no applicants as unchanged", () => {
    expect(deriveCaseStatusFromApplicants("DOCS_UNDER_REVIEW", [], { isGroup: false })).toBe(
      "DOCS_UNDER_REVIEW",
    );
  });

  it("does not treat a sent-back applicant as decided", () => {
    // SENT_BACK is a file returning to work, not a decision on it.
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["SENT_BACK"], { isGroup: false })).toBe(
      "SUBMITTED",
    );
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "SENT_BACK"], { isGroup: true }),
    ).toBe("SUBMITTED");
  });

  it("reopens VISA_GRANTED to SUBMITTED when an applicant becomes live again", () => {
    expect(
      deriveCaseStatusFromApplicants("VISA_GRANTED", ["SENT_BACK"], { isGroup: false }),
    ).toBe("SUBMITTED");
    expect(
      deriveCaseStatusFromApplicants("VISA_REFUSED", ["PENDING"], { isGroup: false }),
    ).toBe("SUBMITTED");
  });

  it("reopens a DECIDED case the moment an applicant is live again", () => {
    // The case was marked decided — by hand, or by an import — and then the
    // embassy sent one file back. Short-circuiting on DECIDED left the case
    // decided while holding a SENT_BACK applicant, with no way out but CLOSED.
    expect(
      deriveCaseStatusFromApplicants("DECIDED", ["APPROVED", "SENT_BACK"], { isGroup: true }),
    ).toBe("SUBMITTED");
    expect(deriveCaseStatusFromApplicants("DECIDED", ["SENT_BACK"], { isGroup: false })).toBe(
      "SUBMITTED",
    );
    // The resubmission puts that applicant back to PENDING; still not decided.
    expect(
      deriveCaseStatusFromApplicants("DECIDED", ["APPROVED", "PENDING"], { isGroup: true }),
    ).toBe("SUBMITTED");
  });

  it("leaves a DECIDED case decided while every applicant really is decided", () => {
    expect(
      deriveCaseStatusFromApplicants("DECIDED", ["APPROVED", "REJECTED"], { isGroup: true }),
    ).toBe("DECIDED");
    // A decided case with no applicant rows at all is not evidence of anything.
    expect(deriveCaseStatusFromApplicants("DECIDED", [], { isGroup: false })).toBe("DECIDED");
  });
});

describe("the embassy sends one file of three back for a corrected photo", () => {
  it("leaves the case workable, and lets the resubmission be recorded", () => {
    // Two of the three applicants are approved; the embassy returns the third
    // for a new photo and ops records SENT_BACK.
    const outcomesAfterTheReturn = ["APPROVED", "APPROVED", "SENT_BACK"] as const;

    // The file is actively being re-worked, so the case must NOT read DECIDED —
    // DECIDED cannot reach the off-ramps and only reopens to SUBMITTED, so the
    // case would drop out of every live queue while ops is still working it.
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", outcomesAfterTheReturn, { isGroup: true }),
    ).toBe("SUBMITTED");

    // Ops fixes the photo and resubmits: the returned applicant goes back into
    // the queue as PENDING. This is the resubmission path.
    expect(canTransitionOutcome("SENT_BACK", "PENDING")).toBe(true);
    const outcomesAfterTheResubmission = ["APPROVED", "APPROVED", "PENDING"] as const;
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", outcomesAfterTheResubmission, {
        isGroup: true,
      }),
    ).toBe("SUBMITTED");

    // Only when the resubmitted file is actually decided does the case decide —
    // a group reads DECIDED, never VISA_GRANTED, even with all three approved.
    expect(canTransitionOutcome("PENDING", "APPROVED")).toBe(true);
    expect(
      deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "APPROVED", "APPROVED"], {
        isGroup: true,
      }),
    ).toBe("DECIDED");
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

  it("keeps a decided applicant from being silently un-decided", () => {
    // APPROVED and REJECTED are verdicts: the embassy has ruled, and the CRM
    // has no edge that quietly unrules it. SENT_BACK is not a verdict — it is
    // the file coming back for a correction — so it must be able to go back to
    // PENDING, and a case that reads DECIDED reopens when it does.
    for (const decidedOutcome of ["APPROVED", "REJECTED"] as const) {
      expect(canTransitionOutcome(decidedOutcome, "PENDING")).toBe(false);
    }
  });
});
