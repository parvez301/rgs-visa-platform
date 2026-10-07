import { describe, expect, it } from "vitest";
import {
  UNNAMED_APPLICANT,
  displayApplicantName,
  displayApplicantRef,
  uniqueApplicantDisplayRefs,
} from "../../src/crm/applicantDisplay";

describe("displayApplicantRef", () => {
  it("prefers the applicant's own refNo", () => {
    expect(displayApplicantRef("RGS-1", 3, { applicantRef: "A2", refNo: "RGS-2" })).toBe("RGS-2");
  });

  it("shows the case REF for a single-applicant case with no refNo (the imported shape)", () => {
    expect(displayApplicantRef("31377", 1, { applicantRef: "1" })).toBe("31377");
  });

  it("falls back to applicantRef on a multi-applicant case with no refNo", () => {
    expect(displayApplicantRef("RGS-1", 2, { applicantRef: "A2" })).toBe("A2");
  });
});

describe("uniqueApplicantDisplayRefs", () => {
  it("returns every unique family REF NO in applicant order", () => {
    expect(
      uniqueApplicantDisplayRefs("38599", [
        { applicantRef: "A1", refNo: "38599" },
        { applicantRef: "A2", refNo: "38600" },
        { applicantRef: "A3", refNo: "38600" },
        { applicantRef: "A4", refNo: "38601" },
      ]),
    ).toEqual(["38599", "38600", "38601"]);
  });
});

describe("displayApplicantName", () => {
  it("reads the traveller's full name from the map", () => {
    expect(displayApplicantName({ trv_1: { fullName: "Asha Rao" } }, { travellerId: "trv_1" })).toBe("Asha Rao");
  });

  it("says Unnamed applicant when the map is missing or has no entry", () => {
    expect(displayApplicantName(undefined, { travellerId: "trv_1" })).toBe(UNNAMED_APPLICANT);
    expect(displayApplicantName({}, { travellerId: "trv_1" })).toBe(UNNAMED_APPLICANT);
  });
});
