import { describe, expect, it } from "vitest";
import { mapRow } from "../src/mapRow";
import type { RawMiniCrmRow } from "../src/readWorkbook";

function buildRawRow(overrides: Partial<RawMiniCrmRow> = {}): RawMiniCrmRow {
  return {
    sourceRow: 2,
    receivedDateRaw: "30-12-2024",
    caseRef: "31376",
    applicantsName: "AKSHAY JAIN",
    applicantCount: "3",
    partnerName: "Sudiva Spinners Pvt Ltd",
    country: "Turkey",
    dateOfBirthRaw: "",
    subDateRaw: "31/12/2024",
    collectionRaw: "",
    passportNumber: "V2404480",
    entries: "Single",
    visaType: "Business",
    status: "Handover",
    additionalItems: "",
    ...overrides,
  };
}

describe("mapRow — pass 1", () => {
  it("maps a clean row with no review items", () => {
    const mapped = mapRow(buildRawRow());
    expect(mapped.reviewItems).toEqual([]);
    expect(mapped.caseRef).toBe("31376");
    expect(mapped.sourceRow).toBe(2);
    expect(mapped.caseDraft.destinationCountry).toBe("TR");
    expect(mapped.caseDraft.caseType).toBe("VISA");
    expect(mapped.caseDraft.visaType).toBe("BUSINESS");
    expect(mapped.caseDraft.entryType).toBe("SINGLE");
    expect(mapped.caseDraft.processing).toBe("NORMAL");
    expect(mapped.applicantCount).toBe(3);
  });

  it("splits one Status cell across all three axes", () => {
    // "Handover" is CLOSED + RETURNED per spec §6.
    const mapped = mapRow(buildRawRow({ status: "Handover" }));
    expect(mapped.caseDraft.caseStatus).toBe("CLOSED");
    expect(mapped.caseDraft.custody).toBe("RETURNED");
  });

  it("records an outcome that lives in the Status column", () => {
    const mapped = mapRow(buildRawRow({ status: "Approved" }));
    expect(mapped.caseDraft.caseStatus).toBe("DECIDED");
    expect(mapped.caseDraft.outcome).toBe("APPROVED");
  });

  it("maps SENT BACK to SUBMITTED + SENT_BACK, never DECIDED", () => {
    // Controller ruling (task-7-ruling-date-seam.md): the embassy handing a
    // file back for correction is live work, not a verdict. 30 workbook rows
    // carry this value; importing them as DECIDED would create 30 cases
    // holding a SENT_BACK applicant with no off-ramp out.
    const mapped = mapRow(buildRawRow({ status: "Sent Back" }));
    expect(mapped.caseDraft.caseStatus).toBe("SUBMITTED");
    expect(mapped.caseDraft.outcome).toBe("SENT_BACK");
    expect(mapped.reviewItems).toEqual([]);
  });

  it("treats a BLANK cell as not-recorded, never as a review item", () => {
    const mapped = mapRow(buildRawRow({ entries: "", subDateRaw: "", status: "" }));
    expect(mapped.reviewItems).toEqual([]);
    expect(mapped.caseDraft.entryType).toBeUndefined();
    expect(mapped.caseDraft.submissionDate).toBeUndefined();
    expect(mapped.caseDraft.caseStatus).toBe("NEW");
    expect(mapped.caseDraft.custody).toBe("NOT_HELD");
    expect(mapped.caseDraft.outcome).toBe("PENDING");
  });

  it("raises a review item for a PRESENT but unmappable status", () => {
    const mapped = mapRow(buildRawRow({ status: "DEU/DEL/190126/" }));
    const statusReview = mapped.reviewItems.find((item) => item.fieldName === "Status");
    expect(statusReview?.reason).toBe("UNMAPPED_STATUS");
    expect(statusReview?.rawValue).toBe("DEU/DEL/190126/");
  });

  it("raises a review item for an unparseable date but still maps the rest of the row", () => {
    const mapped = mapRow(buildRawRow({ subDateRaw: "aposttile" }));
    expect(mapped.reviewItems.some((item) => item.reason === "UNPARSEABLE_DATE")).toBe(true);
    expect(mapped.caseDraft.destinationCountry).toBe("TR");
    expect(mapped.caseDraft.submissionDate).toBeUndefined();
  });

  it("parses ambiguous dates day-first, matching the workbook's 3261:15 split", () => {
    expect(mapRow(buildRawRow({ subDateRaw: "05/01/2025" })).caseDraft.submissionDate).toBe("2025-01-05");
  });

  it("keeps unmapped columns in legacyRaw so nothing is discarded", () => {
    const mapped = mapRow(buildRawRow({ additionalItems: "PHOTO, HOTEL, GST NO" }));
    expect(mapped.legacyRaw["Additional Items"]).toBe("PHOTO, HOTEL, GST NO");
  });

  it("lets a caseType hint in the Status column beat the Visa Type column", () => {
    const mapped = mapRow(buildRawRow({ status: "Documents attestation", visaType: "Tourist" }));
    expect(mapped.caseDraft.caseType).toBe("ATTESTATION");
  });

  it("defaults a missing applicant count to 1 rather than 0", () => {
    expect(mapRow(buildRawRow({ applicantCount: "" })).applicantCount).toBe(1);
  });

  // --- Controller ruling (task-7-ruling-date-seam.md): the reader/normalizer
  // date seam. Every date fixture above is dd-mm-yyyy, which is exactly the
  // vacuous-coverage shape the ruling warns about — it would all pass while
  // the seam bug is live. This is the test the brief was missing.
  it("accepts the ISO shape the reader actually emits for a Date cell, with no review item", () => {
    // readWorkbook.ts converts a Date cell to "YYYY-MM-DD" (UTC) at the
    // reader boundary; the mapper must accept that shape directly rather
    // than sending it to review.
    const mapped = mapRow(buildRawRow({ subDateRaw: "2025-06-12" }));
    expect(mapped.caseDraft.submissionDate).toBe("2025-06-12");
    expect(mapped.reviewItems).toEqual([]);
  });

  // --- Controller ruling: the two junk cells Task 6 pinned and left for
  // pass 1 to raise. Mini CRM row 3001 col 1 is this task's half (RawYearRow
  // / "2025 YEAR" row 1844 is Task 8's).
  it("raises column-shift junk in a date column as a review item AND keeps it in legacyRaw", () => {
    // Mini CRM row 3001, column "C": travel@airbournetravels.com — a real
    // email address left behind by a bad paste, sitting in the
    // received-date column. It must survive verbatim and must never be
    // silently dropped or guessed into some other field.
    const mapped = mapRow(
      buildRawRow({ sourceRow: 3001, receivedDateRaw: "travel@airbournetravels.com" }),
    );
    const dateReview = mapped.reviewItems.find((item) => item.fieldName === "C");
    expect(dateReview?.reason).toBe("UNPARSEABLE_DATE");
    expect(dateReview?.rawValue).toBe("travel@airbournetravels.com");
    expect(mapped.legacyRaw["C"]).toBe("travel@airbournetravels.com");
    expect(mapped.caseDraft.receivedDate).toBeUndefined();
  });
});
