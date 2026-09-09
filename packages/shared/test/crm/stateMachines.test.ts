import { describe, expect, it } from "vitest";
import {
  canTransitionBilling,
  canTransitionCaseStatus,
  canTransitionCustody,
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
