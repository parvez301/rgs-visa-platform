import { describe, expect, it } from "vitest";
import { buildCaseDetailsPatch, planApplicantChanges, type CaseDraft } from "../../src/crm/case/caseEditDiff";

const ORIGINAL_DRAFT: CaseDraft = {
  caseRef: "38017",
  caseType: "VISA",
  partnerId: "ptn_1",
  destinationCountry: "JP",
  visaType: "TOURIST",
  entryType: "",
  processing: "",
  receivedDate: "2026-09-01",
  submissionDate: "",
  appointmentDate: "",
  expectedCollectionDate: "2026-09-20",
  remarks: "call first",
  groupName: "",
  clientEmail: "",
  applicants: [
    { applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "P1111111", refNo: "" },
    { applicantRef: "A2", fullName: "SITA SHARMA", passportNumber: "", refNo: "" },
  ],
};

describe("buildCaseDetailsPatch", () => {
  it("sends only changed fields, trimmed, and null for a cleared optional", () => {
    const patch = buildCaseDetailsPatch(ORIGINAL_DRAFT, {
      ...ORIGINAL_DRAFT,
      caseRef: " 38017-B ",
      remarks: "",
      expectedCollectionDate: "",
    });
    expect(patch).toEqual({ caseRef: "38017-B", remarks: null, expectedCollectionDate: null });
  });

  it("sends nothing when nothing changed", () => {
    expect(buildCaseDetailsPatch(ORIGINAL_DRAFT, { ...ORIGINAL_DRAFT, caseRef: "38017 " })).toEqual({});
  });
});

describe("planApplicantChanges", () => {
  it("splits edits into updates, additions and removals", () => {
    const plan = planApplicantChanges(ORIGINAL_DRAFT, {
      ...ORIGINAL_DRAFT,
      applicants: [
        { applicantRef: "A1", fullName: "ANIL K SHARMA", passportNumber: "P1111111", refNo: "R-1" },
        { fullName: "RIYA SHARMA", passportNumber: "", refNo: "R-3" },
      ],
    });
    expect(plan.updates).toEqual([{ applicantRef: "A1", body: { fullName: "ANIL K SHARMA", refNo: "R-1" } }]);
    expect(plan.additions).toEqual([{ fullName: "RIYA SHARMA", passportNumber: "", refNo: "R-3" }]);
    expect(plan.removals).toEqual(["A2"]);
  });

  it("clears a REF NO or passport with null", () => {
    const withValues: CaseDraft = {
      ...ORIGINAL_DRAFT,
      applicants: [{ applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "P1111111", refNo: "R-1" }],
    };
    const plan = planApplicantChanges(withValues, {
      ...withValues,
      applicants: [{ applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "", refNo: "" }],
    });
    expect(plan.updates).toEqual([{ applicantRef: "A1", body: { passportNumber: null, refNo: null } }]);
  });
});
