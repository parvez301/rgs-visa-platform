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
    remarks: "",
    courierDateRaw: "",
    paymentStatus: "",
    trackingNumber: "",
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

  it("raises a review item for a no-digit date-column value but still maps the rest of the row", () => {
    // Review round 1, Minor 5: "aposttile" contains no digit at all, so per
    // the coordinator's ruling it is COLUMN_SHIFT_JUNK (foreign content in a
    // date column), not UNPARSEABLE_DATE (a typo'd date attempt). This
    // overrides the brief's original text, which predates that ruling.
    const mapped = mapRow(buildRawRow({ subDateRaw: "aposttile" }));
    expect(mapped.reviewItems.some((item) => item.reason === "COLUMN_SHIFT_JUNK")).toBe(true);
    expect(mapped.caseDraft.destinationCountry).toBe("TR");
    expect(mapped.caseDraft.submissionDate).toBeUndefined();
  });

  it("raises UNPARSEABLE_DATE, not COLUMN_SHIFT_JUNK, for a digit-bearing malformed date", () => {
    // Review round 1, Minor 5: a cell with a digit is a mangled/out-of-window
    // date attempt, not foreign content — the two reasons must not collapse
    // into one. "31-02-2025" is day-first shaped but 31 February does not
    // exist, so it fails isRealCalendarDate while clearly containing digits.
    const mapped = mapRow(buildRawRow({ collectionRaw: "31-02-2025" }));
    const collectionReview = mapped.reviewItems.find((item) => item.fieldName === "Collection");
    expect(collectionReview?.reason).toBe("UNPARSEABLE_DATE");
    expect(collectionReview?.rawValue).toBe("31-02-2025");
    expect(mapped.legacyRaw["Collection"]).toBe("31-02-2025");
    expect(mapped.caseDraft.expectedCollectionDate).toBeUndefined();
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
    const mapped = mapRow(buildRawRow({ applicantCount: "" }));
    expect(mapped.applicantCount).toBe(1);
    // A blank count means one applicant. It is not a defect and must not
    // reach the queue, or 6,678 of the 7,156 rows become review items.
    expect(mapped.reviewItems).toEqual([]);
    expect(mapped.legacyRaw["No."]).toBeUndefined();
  });

  // --- Measured on the real workbook: 25 present cells in the `No.` column
  // --- are not a usable count -- "Evisa" x20, "0" x3, "." x1, "2 DOC" x1 --
  // --- and every one of them was silently coerced to a single applicant.
  it("flags a no-digit applicant count as column-shift junk instead of coercing it to 1", () => {
    const mapped = mapRow(buildRawRow({ applicantCount: "Evisa" }));
    // The run still proceeds with one applicant; what changes is that a human
    // is told, and the cell text survives.
    expect(mapped.applicantCount).toBe(1);
    expect(mapped.reviewItems).toEqual([
      expect.objectContaining({
        reason: "COLUMN_SHIFT_JUNK",
        fieldName: "No.",
        rawValue: "Evisa",
        proposedValue: "1",
      }),
    ]);
    expect(mapped.legacyRaw["No."]).toBe("Evisa");
  });

  it("flags a digit-bearing applicant count that is not a count as a fabricated field", () => {
    // "2 DOC" is the sharp one: Number() gives NaN, the old code used 1, and
    // that case really does have two applicants. One of them was dropped with
    // nothing recorded anywhere.
    const mapped = mapRow(buildRawRow({ applicantCount: "2 DOC" }));
    expect(mapped.applicantCount).toBe(1);
    expect(mapped.reviewItems).toEqual([
      expect.objectContaining({
        reason: "MISSING_REQUIRED_FIELD",
        fieldName: "No.",
        rawValue: "2 DOC",
      }),
    ]);
    expect(mapped.legacyRaw["No."]).toBe("2 DOC");
  });

  it("flags an applicant count of 0, which no case can have", () => {
    const mapped = mapRow(buildRawRow({ applicantCount: "0" }));
    expect(mapped.applicantCount).toBe(1);
    expect(mapped.reviewItems.map((reviewItem) => reviewItem.reason)).toEqual([
      "MISSING_REQUIRED_FIELD",
    ]);
  });

  it("keeps a real count out of the queue", () => {
    const mapped = mapRow(buildRawRow({ applicantCount: "3" }));
    expect(mapped.applicantCount).toBe(3);
    expect(mapped.reviewItems).toEqual([]);
  });

  // --- Review round 1, Major 2: courierMode/note wiring from Status into
  // caseDraft was asserted nowhere; status.test.ts only proves the
  // *normalizer* returns them, not that mapRow plumbs them through.
  it("wires a courier mode from the Status column into caseDraft", () => {
    // "DTDC" maps to custody IN_TRANSIT + courierMode DTDC per status.ts.
    const mapped = mapRow(buildRawRow({ status: "DTDC" }));
    expect(mapped.caseDraft.courierMode).toBe("DTDC");
    expect(mapped.caseDraft.custody).toBe("IN_TRANSIT");
  });

  it("wires a note from the Status column into caseDraft", () => {
    // "REC: BIO LETTER" maps to caseStatus IN_PROGRESS + a fixed note.
    const mapped = mapRow(buildRawRow({ status: "REC: BIO LETTER" }));
    expect(mapped.caseDraft.note).toBe("Biometrics letter received");
    expect(mapped.caseDraft.caseStatus).toBe("IN_PROGRESS");
  });

  // --- Review round 1, Major 3: receivedDate's happy path and all of
  // expectedCollectionDate were untested — two of mapDateField's three call
  // sites, in the very function this task's ruling is about.
  it("maps a parseable Received Date into caseDraft.receivedDate", () => {
    const mapped = mapRow(buildRawRow({ receivedDateRaw: "30-12-2024" }));
    expect(mapped.caseDraft.receivedDate).toBe("2024-12-30");
    expect(mapped.reviewItems).toEqual([]);
  });

  it("maps a parseable Collection date into caseDraft.expectedCollectionDate", () => {
    const mapped = mapRow(buildRawRow({ collectionRaw: "02/01/2025" }));
    expect(mapped.caseDraft.expectedCollectionDate).toBe("2025-01-02");
    expect(mapped.reviewItems).toEqual([]);
  });

  // --- Review round 1, Major 1: crm.normalizeCountry's visaTypeHint (e.g.
  // Country "Sri Lanka ETA" -> visaTypeHint "E_VISA") had no consumer
  // anywhere in the plan. It is a fallback: it fills in only when the Visa
  // Type column itself yielded nothing, and is dropped silently when the
  // column already named something else.
  it("falls back to the country's visaTypeHint when Visa Type is blank", () => {
    const mapped = mapRow(buildRawRow({ country: "Sri Lanka ETA", visaType: "" }));
    expect(mapped.caseDraft.visaType).toBe("E_VISA");
    expect(mapped.caseDraft.caseType).toBe("VISA");
    expect(mapped.reviewItems).toEqual([]);
  });

  it("lets an explicit Visa Type column value beat the country's visaTypeHint", () => {
    // Measured on the real workbook: 74 of 113 "Sri Lanka ETA" rows carry an
    // explicit Visa Type (Tourist/Business/Evisa - Tourist) that disagrees
    // with the country hint. The explicit column wins; the hint is dropped.
    const mapped = mapRow(buildRawRow({ country: "Sri Lanka ETA", visaType: "Tourist" }));
    expect(mapped.caseDraft.visaType).toBe("TOURIST");
    expect(mapped.caseDraft.caseType).toBe("VISA");
    expect(mapped.reviewItems).toEqual([]);
  });

  // The gate is `caseTypeFromColumns === null`, not `visaType === null`, and
  // the two differ exactly here: Status says the case is not a visa at all
  // while Visa Type is blank and the country still whispers "ETA". A hint
  // derived from the country text must not overrule a case type the Status
  // column stated outright -- that fabricates a visa product on a case the
  // sheet says is a payment.
  it("drops the country's visaTypeHint when the Status column already named the case type", () => {
    const mapped = mapRow(
      buildRawRow({ country: "Sri Lanka ETA", visaType: "", status: "Payment Only" }),
    );
    expect(mapped.caseDraft.caseType).toBe("OTHER");
    expect(mapped.caseDraft.visaType).toBeUndefined();
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
    // silently dropped or guessed into some other field. Review round 1,
    // Minor 5: it contains no digit, so the reason is COLUMN_SHIFT_JUNK.
    const mapped = mapRow(
      buildRawRow({ sourceRow: 3001, receivedDateRaw: "travel@airbournetravels.com" }),
    );
    const dateReview = mapped.reviewItems.find((item) => item.fieldName === "C");
    expect(dateReview?.reason).toBe("COLUMN_SHIFT_JUNK");
    expect(dateReview?.rawValue).toBe("travel@airbournetravels.com");
    expect(mapped.legacyRaw["C"]).toBe("travel@airbournetravels.com");
    expect(mapped.caseDraft.receivedDate).toBeUndefined();
  });

  // --- The four columns beyond "Additional Items" (3,217 populated cells) ---

  it("keeps Remarks, COURIER DATE, payment status and TRACKING NO. in legacyRaw", () => {
    const mapped = mapRow(
      buildRawRow({
        remarks: "REFUSE(DTDC)",
        courierDateRaw: "15/01/2025",
        paymentStatus: "Bill Sent",
        trackingNumber: "QG46TQUVWY",
      }),
    );
    expect(mapped.legacyRaw["Remarks"]).toBe("REFUSE(DTDC)");
    expect(mapped.legacyRaw["COURIER DATE"]).toBe("15/01/2025");
    expect(mapped.legacyRaw["payment status"]).toBe("Bill Sent");
    expect(mapped.legacyRaw["TRACKING NO."]).toBe("QG46TQUVWY");
  });

  it("maps COURIER DATE onto the case's own courierDate field", () => {
    const mapped = mapRow(buildRawRow({ courierDateRaw: "15/01/2025" }));
    // Day-first, like every other date on this sheet: 15 January, not a
    // month-15 failure.
    expect(mapped.caseDraft.courierDate).toBe("2025-01-15");
    expect(mapped.reviewItems).toEqual([]);
  });

  it("keeps a COURIER DATE courier note verbatim without calling it a broken date", () => {
    // 180 of this column's 256 populated cells look like this: a consignment
    // number and a date, or a free-text despatch note. Routing them through
    // the date-column path would queue 180 UNPARSEABLE_DATE items for cells
    // that are not dates at all and are not broken.
    const mapped = mapRow(buildRawRow({ courierDateRaw: "20778883086 - 24/2/2025" }));
    expect(mapped.caseDraft.courierDate).toBeUndefined();
    expect(mapped.legacyRaw["COURIER DATE"]).toBe("20778883086 - 24/2/2025");
    expect(mapped.reviewItems).toEqual([]);
  });

  it("carries TRACKING NO. off the row itself, not only off the year-sheet join", () => {
    const mapped = mapRow(buildRawRow({ trackingNumber: "8288303" }));
    expect(mapped.trackingNumber).toBe("8288303");
  });

  it("maps the unambiguous payment statuses onto billingStatus", () => {
    expect(mapRow(buildRawRow({ paymentStatus: "Bill Sent" })).caseDraft.billingStatus).toBe(
      "BILL_SENT",
    );
    expect(
      mapRow(buildRawRow({ paymentStatus: "Recived In Cash/UPI" })).caseDraft.billingStatus,
    ).toBe("PAID");
    expect(mapRow(buildRawRow({ paymentStatus: "Payment Receive" })).caseDraft.billingStatus).toBe(
      "PAID",
    );
  });

  it("refuses to guess a payment status it cannot read, and queues it instead", () => {
    // "In Cash" is a payment METHOD: it does not say whether the cash was
    // received or is merely expected. Reading it as PAID would put a
    // fabricated billing state on a real case.
    const mapped = mapRow(buildRawRow({ paymentStatus: "In Cash" }));
    expect(mapped.caseDraft.billingStatus).toBeUndefined();
    const paymentReview = mapped.reviewItems.find((item) => item.fieldName === "payment status");
    expect(paymentReview?.reason).toBe("UNMAPPED_STATUS");
    expect(paymentReview?.rawValue).toBe("In Cash");
    expect(mapped.legacyRaw["payment status"]).toBe("In Cash");
  });

  it("leaves billing unset, with no review item, when the payment column is blank", () => {
    const mapped = mapRow(buildRawRow({ paymentStatus: "" }));
    expect(mapped.caseDraft.billingStatus).toBeUndefined();
    expect(mapped.reviewItems).toEqual([]);
  });
});
