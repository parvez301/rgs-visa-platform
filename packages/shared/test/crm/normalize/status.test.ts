import { describe, expect, it } from "vitest";
import { normalizeStatus } from "../../../src/crm/normalize/status";

describe("normalizeStatus — case progress", () => {
  it("maps the in-progress spellings", () => {
    expect(normalizeStatus("Working on It").caseStatus).toBe("IN_PROGRESS");
    expect(normalizeStatus("In Progress").caseStatus).toBe("IN_PROGRESS");
  });

  it("maps the misspelled appointment status", () => {
    expect(normalizeStatus("Appoinment Scheduled").caseStatus).toBe("APPOINTMENT_SET");
  });

  it("maps submission and places the passport at the embassy", () => {
    const submitted = normalizeStatus("Submitted");
    expect(submitted.caseStatus).toBe("SUBMITTED");
    expect(submitted.custody).toBe("AT_EMBASSY");

    const onlineSubmitted = normalizeStatus("ONLINE SUBMITTED");
    expect(onlineSubmitted.caseStatus).toBe("SUBMITTED");
    expect(onlineSubmitted.custody).toBe("AT_EMBASSY");
  });

  it("maps the not-submitted spellings", () => {
    expect(normalizeStatus("Not submitted").caseStatus).toBe("NOT_SUBMITTED");
    expect(normalizeStatus("NOT PROCESSED").caseStatus).toBe("NOT_SUBMITTED");
  });

  it("maps withdrawal and duplicates", () => {
    expect(normalizeStatus("WITHDRAWAL").caseStatus).toBe("WITHDRAWN");
    expect(normalizeStatus("duplicate entry").caseStatus).toBe("DUPLICATE");
  });
});

describe("normalizeStatus — outcomes", () => {
  it("maps an approval onto the outcome axis, not the case axis alone", () => {
    const approved = normalizeStatus("Approved");
    expect(approved.caseStatus).toBe("DECIDED");
    expect(approved.outcome).toBe("APPROVED");
  });

  it("maps rejection and send-back", () => {
    expect(normalizeStatus("Rejected").outcome).toBe("REJECTED");
    expect(normalizeStatus("SENT BACK").outcome).toBe("SENT_BACK");
  });

  it("imports a rejection as a decided case", () => {
    expect(normalizeStatus("Rejected").caseStatus).toBe("DECIDED");
  });

  // 30 rows of the workbook carry `SENT BACK`. Importing each of them as
  // DECIDED would have manufactured, thirty times over, the exact state the
  // reopen fix exists to prevent: a decided case holding a live applicant, cut
  // off from every off-ramp, whose only exit is to CLOSE a file the embassy had
  // handed back. A sent-back file is with RGS and still live work.
  it("imports the 30 SENT BACK rows as live work, not as decided cases", () => {
    const sentBack = normalizeStatus("SENT BACK");
    expect(sentBack.caseStatus).toBe("SUBMITTED");
    expect(sentBack.outcome).toBe("SENT_BACK");
    // Custody stays unmapped: the sheet says the file came back, not where the
    // passport physically is, and inventing a custody value is a guess.
    expect(sentBack.custody).toBeNull();
    expect(sentBack.needsReview).toBe(false);
  });
});

describe("normalizeStatus — custody and courier", () => {
  it("treats 'Sent on Courier' as custody, leaving the courier unknown", () => {
    const result = normalizeStatus("Sent on Courier");
    expect(result.custody).toBe("IN_TRANSIT");
    expect(result.courierMode).toBeNull();
    expect(result.caseStatus).toBeNull();
  });

  it("reads the named couriers as both custody and mode", () => {
    expect(normalizeStatus("DTDC")).toMatchObject({ custody: "IN_TRANSIT", courierMode: "DTDC" });
    expect(normalizeStatus("SPEED POST")).toMatchObject({
      custody: "IN_TRANSIT",
      courierMode: "SPEEDPOST",
    });
  });

  it("closes the case when the passport goes back by hand", () => {
    for (const [rawValue, expectedMode] of [
      ["Handover", "HANDOVER"],
      ["Pickup", "PICKUP"],
      ["PORTER", "PORTER"],
    ] as const) {
      const result = normalizeStatus(rawValue);
      expect(result.caseStatus).toBe("CLOSED");
      expect(result.custody).toBe("RETURNED");
      expect(result.courierMode).toBe(expectedMode);
    }
  });

  it("maps Delivered to closed and returned with no courier named", () => {
    const result = normalizeStatus("Delivered");
    expect(result.caseStatus).toBe("CLOSED");
    expect(result.custody).toBe("RETURNED");
    expect(result.courierMode).toBeNull();
  });

  it("maps the passport-in-hand statuses to custody only", () => {
    for (const rawValue of ["PASSPORT COLLECTION", "PASSPORT ONLY"]) {
      const result = normalizeStatus(rawValue);
      expect(result.custody).toBe("WITH_RGS");
      expect(result.caseStatus).toBeNull();
    }
  });
});

describe("normalizeStatus — values that are not statuses", () => {
  it("turns service lines into case-type hints", () => {
    expect(normalizeStatus("Payment Only").caseTypeHint).toBe("OTHER");
    expect(normalizeStatus("Documents attestation").caseTypeHint).toBe("ATTESTATION");
  });

  it("turns a booked ticket into a line-item hint, not a status", () => {
    const result = normalizeStatus("TICKET BOOKED");
    expect(result.lineItemHint).toBe("TICKET_BOOKING");
    expect(result.caseStatus).toBeNull();
  });

  it("keeps the biometrics letter as a note on an in-progress case", () => {
    const result = normalizeStatus("REC: Bio Letter");
    expect(result.caseStatus).toBe("IN_PROGRESS");
    expect(result.note).toBe("Biometrics letter received");
  });

  it("sends column-shift junk to review with the original preserved", () => {
    const passportInStatusColumn = "DEU/DEL/190126/0027/01 Passport No: Z7789186";
    const result = normalizeStatus(passportInStatusColumn);
    expect(result.needsReview).toBe(true);
    expect(result.caseStatus).toBeNull();
    expect(result.rawValue).toBe(passportInStatusColumn);

    expect(normalizeStatus("Visa Category: Short Stay").needsReview).toBe(true);
    expect(normalizeStatus("").needsReview).toBe(true);
  });

  it("never throws on a non-string cell, routing it to review instead", () => {
    expect(() => normalizeStatus(undefined)).not.toThrow();
    expect(normalizeStatus(undefined).needsReview).toBe(true);
    expect(normalizeStatus(undefined).rawValue).toBe("");

    expect(() => normalizeStatus(null)).not.toThrow();
    expect(normalizeStatus(null).needsReview).toBe(true);
    expect(normalizeStatus(null).rawValue).toBe("");

    expect(() => normalizeStatus(45658)).not.toThrow();
    const numericResult = normalizeStatus(45658);
    expect(numericResult.needsReview).toBe(true);
    expect(numericResult.rawValue).toBe("45658");
  });
});
