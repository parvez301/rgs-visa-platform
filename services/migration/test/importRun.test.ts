import { afterEach, describe, expect, it } from "vitest";
import {
  buildTestContext,
  closeTestContexts,
  interceptSql,
  type TestContext,
} from "@rgs/api/test/helpers";
import { readCase } from "@rgs/api/src/domain/crm/caseStore";
import {
  listCaseRefsByStatus,
  listCasesByPartner,
  listCasesByStatus,
} from "@rgs/api/src/domain/crm/cases";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import { listPartners } from "@rgs/api/src/domain/crm/partners";
import { getTravellerOrThrow } from "@rgs/api/src/domain/crm/travellers";
import { readCaseRefReservation } from "@rgs/api/src/domain/crm/caseRefIndex";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import { runImport } from "../src/importRun";
import { passthroughResidueResolver } from "../src/residueResolver";
import type { ResidueResolution, ResidueResolver } from "../src/residueResolver";
import type { MappedRow } from "../src/mapRow";

afterEach(closeTestContexts);

function buildMappedRow(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    caseRef: "31376",
    sourceSheet: "Mini CRM",
    sourceRow: 2,
    partnerName: "VWI Mumbai",
    travellerFullName: "AKSHAY JAIN",
    passportNumber: "V2404480",
    applicantCount: 1,
    caseDraft: {
      caseType: "VISA",
      destinationCountry: "TR",
      visaType: "BUSINESS",
      caseStatus: "CLOSED",
      custody: "RETURNED",
      outcome: "APPROVED",
      // Present by default so tests unrelated to the missing-required-field
      // fix (pass-1 review items, residue resolution) don't incidentally
      // also trip the receivedDate MISSING_REQUIRED_FIELD item. Tests that
      // specifically exercise a blank receivedDate override this.
      receivedDate: "2025-01-02",
    },
    reviewItems: [],
    legacyRaw: {},
    ...overrides,
  } as MappedRow;
}

const baseInput = {
  contactDetails: new Map(),
  proposedGroups: [],
  residueResolver: passthroughResidueResolver,
  actorEmail: "ops@rgs.test",
  dryRun: false,
};

describe("runImport", () => {
  it("imports a row into a case, partner and traveller", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });
    expect(summary.casesCreated).toBe(1);
    expect(summary.partnersCreated).toBe(1);
    expect(summary.travellersCreated).toBe(1);
  });

  it("is idempotent: a second run creates nothing", async () => {
    const context = await buildTestContext();
    const rows = [buildMappedRow()];
    await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedAlreadyImported).toBe(1);
    expect(secondSummary.partnersCreated).toBe(0);
    expect(secondSummary.rowsMatchedToExistingPartner).toBe(1);
  });

  it("reuses one partner across spelling variants instead of creating two", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({ caseRef: "1", partnerName: "VWI Mumbai" }),
        buildMappedRow({ caseRef: "2", partnerName: "VWI BOM", passportNumber: "X9999999" }),
      ],
    });
    expect(summary.partnersCreated).toBe(1);
    expect(summary.rowsMatchedToExistingPartner).toBe(1);
    expect((await listPartners(context, "rgs")).partners).toHaveLength(1);
  });

  it("imports every migrated case with UNKNOWN billing, never UNBILLED", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    // Spec §5: migrated rows carry no billing evidence, and UNKNOWN is what
    // the billing_overdue watchdog excludes. UNBILLED would nag on all 7,156 imported cases.
    expect(importedCase!.billingStatus).toBe("UNKNOWN");
  });

  it("keeps provenance on every imported case so any value traces back", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ legacyRaw: { "Additional Items": "PHOTO, HOTEL" } })],
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.sourceSheet).toBe("Mini CRM");
    expect(importedCase!.sourceRow).toBe(2);
    expect(importedCase!.caseRef).toBe("31376");
    expect(importedCase!.legacyRaw).toEqual({ "Additional Items": "PHOTO, HOTEL" });
  });

  // CrmCaseSchema refines that only a VISA case may carry a visaType, and
  // `mapRow` reads caseType (from Status) and visaType (from the Visa Type
  // column) independently -- so the two disagree on 16 of the 7,156 real
  // rows, always an OTHER from "Payment Only" alongside a real Visa Type.
  // The structured field has to go, or the parse aborts the whole run. The
  // value must not go with it: legacyRaw is the only place it survives.
  it("keeps a dropped visa type in legacyRaw when the case type says it cannot be structured", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseDraft: {
            caseType: "OTHER",
            destinationCountry: "TR",
            visaType: "BUSINESS",
            caseStatus: "CLOSED",
            custody: "RETURNED",
            outcome: "APPROVED",
            receivedDate: "2025-01-02",
          },
        }),
      ],
    });
    expect(summary.casesCreated).toBe(1);

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.caseType).toBe("OTHER");
    expect(importedCase!.visaType).toBeUndefined();
    expect(importedCase!.legacyRaw).toEqual({ "Visa Type": "BUSINESS" });
  });

  // The other side of the same branch: a VISA case keeps its visa type in the
  // structured field and must NOT also duplicate it into legacyRaw, or every
  // one of the 7,140 well-formed rows grows a redundant provenance key.
  it("does not copy a visa type into legacyRaw when the structured field keeps it", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.visaType).toBe("BUSINESS");
    expect(importedCase!.legacyRaw).toEqual({});
  });

  it("records pass-1 review items in the queue", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          reviewItems: [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "DEU/DEL/190126/" }],
        }),
      ],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open.reviewItems[0]!.rawValue).toBe("DEU/DEL/190126/");
    expect(open.reviewItems[0]!.sourceRow).toBe(2);
  });

  it("records proposed groups as review items rather than applying them", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      proposedGroups: [
        { caseRefs: ["31376", "31377"], partnerName: "VWI Mumbai", destinationCountry: "TR", receivedDate: "2025-01-02" },
      ],
    });
    expect(summary.groupsProposed).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open.reviewItems.some((item) => item.reason === "PROPOSED_GROUP")).toBe(true);
  });

  it("does not re-record a PROPOSED_GROUP on an unchanged second run, once every member case is already imported", async () => {
    const context = await buildTestContext();
    const input = {
      ...baseInput,
      mappedRows: [
        buildMappedRow({ caseRef: "40001", sourceRow: 10 }),
        buildMappedRow({ caseRef: "40002", sourceRow: 11, passportNumber: "X1111111" }),
      ],
      proposedGroups: [
        {
          caseRefs: ["40001", "40002"],
          partnerName: "VWI Mumbai",
          destinationCountry: "TR",
          receivedDate: "2025-01-02",
        },
      ],
    };

    const firstSummary = await runImport(context, "rgs", input);
    expect(firstSummary.casesCreated).toBe(2);
    expect(firstSummary.groupsProposed).toBe(1);
    const afterFirstRun = await listReviewItems(context, "rgs", "OPEN");
    expect(afterFirstRun.reviewItems.filter((item) => item.reason === "PROPOSED_GROUP")).toHaveLength(1);

    // SAME input, second call. A store that merely started empty and stayed
    // empty would prove nothing -- run 1 above populated the store for real,
    // so this is testing that run 2 recognizes the group as already fully
    // imported and adds nothing more, not that an empty store stays empty.
    const secondSummary = await runImport(context, "rgs", input);
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.groupsProposed).toBe(0);
    const afterSecondRun = await listReviewItems(context, "rgs", "OPEN");
    expect(afterSecondRun.reviewItems.filter((item) => item.reason === "PROPOSED_GROUP")).toHaveLength(1);
  });

  it("re-records a PROPOSED_GROUP when a new row extends an already-imported group", async () => {
    const context = await buildTestContext();
    const proposedGroups = [
      {
        caseRefs: ["50001", "50002"],
        partnerName: "VWI Mumbai",
        destinationCountry: "TR",
        receivedDate: "2025-01-02",
      },
    ];

    const firstSummary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ caseRef: "50001", sourceRow: 20 })],
      proposedGroups,
    });
    expect(firstSummary.groupsProposed).toBe(1);

    // The group now has a second member the first run never saw. The group
    // has genuinely changed, so it must be re-proposed even though it was
    // already recorded once -- this is what tells the dedup guard apart from
    // a guard that just suppresses PROPOSED_GROUP forever after its first run.
    const secondSummary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({ caseRef: "50001", sourceRow: 20 }),
        buildMappedRow({ caseRef: "50002", sourceRow: 21, passportNumber: "X2222222" }),
      ],
      proposedGroups,
    });
    expect(secondSummary.casesCreated).toBe(1);
    expect(secondSummary.groupsProposed).toBe(1);
  });

  it("writes nothing on a dry run but still reports what it would do", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      dryRun: true,
    });
    expect(summary.casesCreated).toBe(1);
    expect((await listPartners(context, "rgs")).partners).toHaveLength(0);
    expect((await listReviewItems(context, "rgs", "OPEN")).reviewItems).toHaveLength(0);
  });

  // --- Ruling (task-9): findPartnerByName must be memoised, not scanned per row ---

  it("looks up a shared partner name at most a constant number of times, not once per row", async () => {
    const context = await buildTestContext();
    let partnerListQueryCount = 0;
    interceptSql(context, async ({ text }, run) => {
      if (/\bfrom\s+crm_partners\b/i.test(text)) partnerListQueryCount += 1;
      return run();
    });

    const rowCount = 50;
    const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
      buildMappedRow({
        caseRef: String(rowIndex + 1),
        sourceRow: rowIndex + 2,
        partnerName: "A Brand New Partner Nobody Has Seen",
        passportNumber: `PASS${String(rowIndex).padStart(4, "0")}`,
      }),
    );

    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    expect(summary.partnersCreated).toBe(1);
    expect(summary.rowsMatchedToExistingPartner).toBe(rowCount - 1);
    // Un-memoised, this would be >= rowCount (one partner scan per row).
    // Memoised, it is a small constant: our own pre-check plus createPartner's
    // internal duplicate-name check, both on the first row only.
    expect(partnerListQueryCount).toBeLessThanOrEqual(3);
  });

  // --- J5: the traveller lookup must be memoised the way the partner one is ---

  it("looks a repeat traveller up once, not once per row", async () => {
    const context = await buildTestContext();
    let travellerLookupCount = 0;
    interceptSql(context, async ({ text }, run) => {
      if (/\bfrom\s+crm_travellers\b/i.test(text) && /(?:normalized_name|passport_number)\s*=/i.test(text)) {
        travellerLookupCount += 1;
      }
      return run();
    });

    const rowCount = 20;
    const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
      buildMappedRow({
        caseRef: String(rowIndex + 1),
        sourceRow: rowIndex + 2,
        travellerFullName: "RAHUL SHARMA",
        passportNumber: "R1234567",
      }),
    );

    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    expect(summary.travellersCreated).toBe(1);
    expect(summary.rowsMatchedToExistingTraveller).toBe(rowCount - 1);
    // Un-memoised this was >= rowCount; memoised it is the first row's two
    // misses plus upsertTraveller's own internal passport check.
    expect(travellerLookupCount).toBeLessThanOrEqual(3);
  });

  it("reports the same traveller counts on a dry run as on a real one", async () => {
    const rows = [
      buildMappedRow({ caseRef: "1", sourceRow: 2, travellerFullName: "RAHUL SHARMA", passportNumber: "R1234567" }),
      buildMappedRow({ caseRef: "2", sourceRow: 3, travellerFullName: "RAHUL SHARMA", passportNumber: "R1234567" }),
      buildMappedRow({ caseRef: "3", sourceRow: 4, travellerFullName: "PRIYA DESAI", passportNumber: "P7654321" }),
    ];

    const dryRunSummary = await runImport(await buildTestContext(), "rgs", {
      ...baseInput,
      mappedRows: rows,
      dryRun: true,
    });
    const committedSummary = await runImport(await buildTestContext(), "rgs", {
      ...baseInput,
      mappedRows: rows,
    });

    // The dry run is the operator's only pre-flight signal and the safety
    // feature the CLI is built around. With nothing written every lookup
    // missed, so it used to claim 3 travellers created where a real run
    // creates 2 -- on the real workbook, 7,156 against 5,534.
    expect(committedSummary.travellersCreated).toBe(2);
    expect(dryRunSummary.travellersCreated).toBe(committedSummary.travellersCreated);
    expect(dryRunSummary.rowsMatchedToExistingTraveller).toBe(committedSummary.rowsMatchedToExistingTraveller);
  });

  // --- Ruling (task-9): partner names are passed RAW, not canonicalized ---

  it("passes the partner name to the API raw, preserving its exact casing", async () => {
    const context = await buildTestContext();
    await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ partnerName: "VWI Mumbai" })],
    });

    const partnerListing = await listPartners(context, "rgs");
    expect(partnerListing.partners).toHaveLength(1);
    // If the importer pre-normalized before calling createPartner, this would
    // read back as the canonical key ("VWI") or an uppercased string, not the
    // raw sheet text.
    expect(partnerListing.partners[0]!.canonicalName).toBe("VWI Mumbai");
  });

  // --- JoinedContactDetails: phone / trackingNumber / flaggedPhoneRaw ---

  it("records a phone recovered from the 2025 YEAR join on a newly-created traveller", async () => {
    const context = await buildTestContext();
    const contactDetails = new Map([["31376", { phone: "9876543210" }]]);
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      contactDetails,
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    const traveller = await getTravellerOrThrow(
      context,
      "rgs",
      importedCase!.applicants[0]!.travellerId,
    );
    expect(traveller.phone).toBe("9876543210");
  });

  it("carries the tracking number from the phone join onto the case's applicant", async () => {
    const context = await buildTestContext();
    const contactDetails = new Map([["31376", { trackingNumber: "DTDC9911" }]]);
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()], contactDetails });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.applicants[0]!.trackingNumber).toBe("DTDC9911");
  });

  it("records a SUSPECT_PHONE review item and keeps the flagged phone in legacyRaw", async () => {
    const context = await buildTestContext();
    const contactDetails = new Map([["31376", { flaggedPhoneRaw: "Mukesh Kumar" }]]);
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()], contactDetails });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.legacyRaw).toMatchObject({ Phone: "Mukesh Kumar" });

    const open = await listReviewItems(context, "rgs", "OPEN");
    const suspectPhoneItem = open.reviewItems.find((item) => item.reason === "SUSPECT_PHONE");
    expect(suspectPhoneItem).toBeDefined();
    expect(suspectPhoneItem!.rawValue).toBe("Mukesh Kumar");
  });

  // --- Schema-required fields the workbook does not always supply --------

  it("substitutes a sentinel destinationCountry when the country is blank, and raises a MISSING_REQUIRED_FIELD review item", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ caseDraft: { ...buildMappedRow().caseDraft, destinationCountry: "" } })],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.destinationCountry).toBe("ZZ");
    const open = await listReviewItems(context, "rgs", "OPEN");
    const missingFieldItem = open.reviewItems.find((item) => item.reason === "MISSING_REQUIRED_FIELD");
    expect(missingFieldItem?.fieldName).toBe("Country");
    expect(missingFieldItem?.rawValue).toBe("");
    expect(missingFieldItem?.proposedValue).toBe("ZZ");
  });

  it("substitutes a sentinel receivedDate when the date is blank, and raises a MISSING_REQUIRED_FIELD review item", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ caseDraft: { ...buildMappedRow().caseDraft, receivedDate: undefined } })],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.receivedDate).toBe("1970-01-01");
    const open = await listReviewItems(context, "rgs", "OPEN");
    const missingFieldItem = open.reviewItems.find((item) => item.reason === "MISSING_REQUIRED_FIELD");
    expect(missingFieldItem?.fieldName).toBe("C");
    expect(missingFieldItem?.rawValue).toBe("");
    expect(missingFieldItem?.proposedValue).toBe("1970-01-01");

    // The detail text is the only thing telling a reviewer where to look for
    // the row, so it has to be true. Partner listings are newest-first, and
    // 1970-01-01 sorts LAST, not first. The shipped text said "front" and was
    // false on all 225 of them.
    expect(missingFieldItem?.detail).toContain("END");
    expect(missingFieldItem?.detail).not.toContain("front");
  });

  it("puts a sentinel-dated case at the END of its partner's listing, as the review item claims", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseRef: "1",
          sourceRow: 2,
          caseDraft: { ...buildMappedRow().caseDraft, receivedDate: undefined },
        }),
        buildMappedRow({
          caseRef: "2",
          sourceRow: 3,
          passportNumber: "X9999999",
          caseDraft: { ...buildMappedRow().caseDraft, receivedDate: "2025-06-01" },
        }),
      ],
    });
    expect(summary.casesCreated).toBe(2);

    const importedCases = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    const partnerListing = await listCasesByPartner(context, "rgs", importedCases!.partnerId);
    // Newest first, so the 1970 placeholder is last -- which at the route's
    // default page size of 50 is where it stops being reachable at all.
    expect(partnerListing.cases.map((storedCase) => storedCase.caseRef)).toEqual(["2", "1"]);
  });

  it("substitutes a per-row sentinel travellerFullName when the name is blank, and raises a MISSING_REQUIRED_FIELD review item", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ travellerFullName: "  ", passportNumber: undefined, sourceRow: 4435 })],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    expect(summary.casesCreated).toBe(1);
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    const traveller = await getTravellerOrThrow(context, "rgs", importedCase!.applicants[0]!.travellerId);
    expect(traveller.fullName).toBe("(name not recorded, row 4435)");
    const open = await listReviewItems(context, "rgs", "OPEN");
    const missingFieldItem = open.reviewItems.find((item) => item.reason === "MISSING_REQUIRED_FIELD");
    expect(missingFieldItem?.fieldName).toBe("APPLICANTS NAME");
    expect(missingFieldItem?.rawValue).toBe("");
    expect(missingFieldItem?.proposedValue).toBe("(name not recorded, row 4435)");
  });

  it("does not merge two different blank-name rows onto the same traveller", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseRef: "6977",
          travellerFullName: "",
          passportNumber: undefined,
          sourceRow: 6977,
        }),
        buildMappedRow({
          caseRef: "6978",
          travellerFullName: "",
          passportNumber: undefined,
          sourceRow: 6978,
        }),
      ],
    });
    expect(summary.casesCreated).toBe(2);
    expect(summary.travellersCreated).toBe(2);
    const firstCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    const secondCase = await readCase(context, "rgs", summary.createdCaseIds[1]!);
    expect(firstCase!.applicants[0]!.travellerId).not.toBe(secondCase!.applicants[0]!.travellerId);
  });

  // --- Written-but-never-read field audit: applicantCount, Status note ---

  it("surfaces a headcount above one in legacyRaw", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ applicantCount: 3 })],
    });
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.legacyRaw).toMatchObject({ "No.": "3" });
  });

  it("does not clutter legacyRaw with a headcount of exactly one", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ applicantCount: 1, legacyRaw: {} })],
    });
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.legacyRaw).toEqual({});
  });

  it("surfaces the Status column's note text in legacyRaw", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseDraft: { ...buildMappedRow().caseDraft, note: "Biometrics letter received" },
        }),
      ],
    });
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.legacyRaw).toMatchObject({ "Status note": "Biometrics letter received" });
  });

  // --- Residue resolver seam (pass 2) -------------------------------------

  it("auto-applies a high-confidence residue resolution to the draft instead of queuing it", async () => {
    const context = await buildTestContext();
    const highConfidenceResolver: ResidueResolver = {
      async resolve(): Promise<ResidueResolution[]> {
        return [{ fieldName: "Status", proposedValue: "SUBMITTED", confidence: 0.95 }];
      },
    };
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      residueResolver: highConfidenceResolver,
      mappedRows: [
        buildMappedRow({
          reviewItems: [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "ONLINE SUB." }],
        }),
      ],
    });
    expect(summary.reviewItemsRecorded).toBe(0);
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.caseStatus).toBe("SUBMITTED");
    expect((await listReviewItems(context, "rgs", "OPEN")).reviewItems).toHaveLength(0);
  });

  // N5: ReviewItemSchema requires confidence in [0, 1] and nothing validates
  // what a resolver returns. Below the auto-apply threshold it lands on the
  // review item, where a bare .parse() threw an untyped ZodError out of the
  // middle of a run that had already written cases -- straight into C1.
  it("does not let a resolver's out-of-range confidence abort the run", async () => {
    const context = await buildTestContext();
    const misbehavingResolver: ResidueResolver = {
      async resolve(): Promise<ResidueResolution[]> {
        return [{ fieldName: "Status", proposedValue: "SUBMITTED", confidence: -0.2 }];
      },
    };
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      residueResolver: misbehavingResolver,
      mappedRows: [
        buildMappedRow({
          reviewItems: [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "ONLINE SUB." }],
        }),
      ],
    });
    // The case is imported and the item is queued; only the unusable number
    // is dropped, and the item says so rather than losing it silently.
    expect(summary.casesCreated).toBe(1);
    expect(summary.reviewItemsRecorded).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open.reviewItems[0]!.proposedValue).toBe("SUBMITTED");
    expect(open.reviewItems[0]!.confidence).toBeUndefined();
    expect(open.reviewItems[0]!.detail).toContain("-0.2");
  });

  it("queues a low-confidence residue resolution with its proposed value and confidence attached", async () => {
    const context = await buildTestContext();
    const lowConfidenceResolver: ResidueResolver = {
      async resolve(): Promise<ResidueResolution[]> {
        return [{ fieldName: "Status", proposedValue: "SUBMITTED", confidence: 0.4 }];
      },
    };
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      residueResolver: lowConfidenceResolver,
      mappedRows: [
        buildMappedRow({
          reviewItems: [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "ONLINE SUB." }],
        }),
      ],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open.reviewItems[0]!.proposedValue).toBe("SUBMITTED");
    expect(open.reviewItems[0]!.confidence).toBe(0.4);
    // Low confidence never touches the draft: the case status stays whatever
    // mapRow (here, the test fixture) computed on its own.
    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.caseStatus).toBe("CLOSED");
  });

  // --- CORRUPT_RECORD on a write path: one bad partner row must not abort the run ---

  it("isolates a corrupt stored partner record to one row instead of aborting the whole run", async () => {
    const context = await buildTestContext();
    // Deliberately missing partner_type, which PartnerSchema requires.
    await context.sql.query(
      `insert into crm_partners (tenant_id, partner_id, canonical_name, canonical_key, updated_at)
       values ($1, $2, $3, $4, now())`,
      ["rgs", "prt_corrupt", "A Corrupt Partner", "A CORRUPT PARTNER"],
    );

    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({ caseRef: "1", partnerName: "A Corrupt Partner", passportNumber: "P1111111" }),
        buildMappedRow({ caseRef: "2", partnerName: "VWI Mumbai", passportNumber: "P2222222" }),
      ],
    });

    // The second row imports normally despite the first row's corrupt partner.
    expect(summary.casesCreated).toBe(1);
    expect(summary.createdCaseIds).toHaveLength(1);
    const survivingCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(survivingCase!.caseRef).toBe("2");

    const open = await listReviewItems(context, "rgs", "OPEN");
    const unmappedPartnerItem = open.reviewItems.find(
      (item) => item.reason === "UNMAPPED_PARTNER" && item.caseRef === "1",
    );
    expect(unmappedPartnerItem).toBeDefined();
  });

  // --- listCasesByStatus's own default limit (50) must not cap the sweep ---

  it("seeds idempotency past listCasesByStatus's own default page limit of 50", async () => {
    const context = await buildTestContext();
    const rowCount = 55;
    const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
      buildMappedRow({
        caseRef: String(rowIndex + 1),
        sourceRow: rowIndex + 2,
        passportNumber: `PASS${String(rowIndex).padStart(4, "0")}`,
        // caseStatus stays "CLOSED" (the fixture default) for every row, so
        // all 55 land in the SAME status partition.
      }),
    );

    await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedAlreadyImported).toBe(rowCount);
  });

  it("sweeps past the default page limit when deciding a group is unchanged", async () => {
    const context = await buildTestContext();
    const rowCount = 55;
    const rows = Array.from({ length: rowCount }, (_unused, rowIndex) =>
      buildMappedRow({
        caseRef: String(rowIndex + 1),
        sourceRow: rowIndex + 2,
        passportNumber: `PASS${String(rowIndex).padStart(4, "0")}`,
      }),
    );
    // One group covering every ref, so the "has a member nobody imported yet"
    // test has to see all 55 of them in the sweep to conclude "unchanged".
    const proposedGroups = [
      {
        caseRefs: rows.map((row) => row.caseRef),
        partnerName: "VWI Mumbai",
        destinationCountry: "TR",
        receivedDate: "2025-01-02",
      },
    ];

    const firstSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows, proposedGroups });
    expect(firstSummary.groupsProposed).toBe(1);

    // Delete every reservation item, so the SWEEP is the only thing left that
    // can recognise these 55 cases.
    //
    // Without this, NEW-3's fix would quietly make this test vacuous: the
    // group check now prefers the reservation reads, which are per-ref and
    // have no page limit at all, so `CASE_REF_SWEEP_PAGE_LIMIT` could go back
    // to 50 and every assertion below would still pass. That is precisely the
    // shape of failure the review found in the index-lag test. A store with
    // no reservations is also a real state -- it is what a tenant imported
    // before reservations existed looks like -- and it is the one state in
    // which the sweep's page limit is load-bearing.
    await context.sql.query("delete from crm_case_ref_reservations where tenant_id = $1", ["rgs"]);

    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows, proposedGroups });
    // Capped at the domain default of 50 the sweep would miss 5 of the refs,
    // re-import them, call the group changed, and re-queue a proposal a human
    // already has.
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedAlreadyImported).toBe(rowCount);
    expect(secondSummary.groupsProposed).toBe(0);
  });

  // --- J1: the four Mini CRM columns nothing used to read -------------------

  it("prefers Mini CRM's own TRACKING NO. over the 2025 YEAR join", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ trackingNumber: "8288303" })],
      // The year sheet is a strict SUBSET of Mini CRM by REF NO, so it is the
      // fallback, never the source: 31 tracking numbers exist only on Mini
      // CRM and were lost outright while the join was the only source.
      contactDetails: new Map([["31376", { trackingNumber: "STALE-YEAR-SHEET" }]]),
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.applicants[0]!.trackingNumber).toBe("8288303");
  });

  it("still falls back to the 2025 YEAR tracking number when Mini CRM has none", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      contactDetails: new Map([["31376", { trackingNumber: "25DEL3G0012679" }]]),
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.applicants[0]!.trackingNumber).toBe("25DEL3G0012679");
  });

  it("imports the billing status the payment column actually recorded", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseDraft: { ...buildMappedRow().caseDraft, billingStatus: "BILL_SENT" },
        }),
      ],
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    // "Migrated rows carry no billing evidence" was false for 32 rows: the
    // sheet's payment status column says it outright.
    expect(importedCase!.billingStatus).toBe("BILL_SENT");
  });

  it("writes the courier date the sheet recorded onto the case", async () => {
    const context = await buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          caseDraft: { ...buildMappedRow().caseDraft, courierDate: "2025-01-15" },
        }),
      ],
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.courierDate).toBe("2025-01-15");
  });

  // --- C1/C2: what a part-way death and a damaged case row leave behind ------
  //
  // `writeCase` is one SQL transaction now, so a death between a case's META
  // and its applicants can no longer happen. What survives is the window
  // between a ref's reservation and its case (reserved, no case row), and
  // damage done after the fact (applicants lost, a ref blanked). Each test
  // below builds one of those states directly.

  /** Makes every statement matching `shouldFail` reject, as a timeout would. */
  function failStatements(context: TestContext, shouldFail: (text: string) => boolean): () => void {
    const healthyClient = context.sql;
    interceptSql(context, async ({ text }, run) => {
      if (shouldFail(text)) throw new Error("simulated write timeout");
      return run();
    });
    return () => {
      context.sql = healthyClient;
    };
  }

  const isCaseInsert = (text: string): boolean => /insert\s+into\s+crm_cases\b/i.test(text);

  async function storedCaseRefsInStatus(
    context: TestContext,
    caseStatus: "CLOSED",
  ): Promise<string[]> {
    const listing = await listCaseRefsByStatus(context, "rgs", caseStatus, 1000);
    return listing.storedCaseRefs.map((storedCaseRef) => storedCaseRef.caseRef);
  }

  /**
   * Leaves a case row whose applicants are gone, and its reservation reopened:
   * the state a run that died mid-repair, or hand damage, would leave.
   */
  async function damageCaseKeepingReservationOpen(context: TestContext, caseId: string, caseRef: string): Promise<void> {
    await context.sql.query("delete from crm_applicants where tenant_id = $1 and case_id = $2", ["rgs", caseId]);
    await context.sql.query(
      "update crm_case_ref_reservations set completed_at = null where tenant_id = $1 and case_ref = $2",
      ["rgs", caseRef],
    );
  }

  it("never re-imports the ref of an unreadable reserved case, and flags it instead", async () => {
    const context = await buildTestContext();
    const rows = [buildMappedRow()];
    const firstSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    await damageCaseKeepingReservationOpen(context, firstSummary.createdCaseIds[0]!, "31376");
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toEqual(["31376"]);

    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    // The whole point: the ref is spoken for, so nothing new is written under
    // it. Re-importing would leave two cases sharing REF 31376, one of them
    // permanently invisible to every listing in the API.
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedUnreadable).toBe(1);
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toEqual(["31376"]);

    const open = await listReviewItems(context, "rgs", "OPEN");
    const unreadableItems = open.reviewItems.filter(
      (item) => item.reason === "UNREADABLE_STORED_CASE",
    );
    expect(unreadableItems).toHaveLength(1);
    expect(unreadableItems[0]!.rawValue).toBe("31376");
    expect(unreadableItems[0]!.detail).toMatch(/unreadable state/);

    // ...and it stays skipped: a third run must not quietly decide otherwise.
    const thirdSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(thirdSummary.casesCreated).toBe(0);
    expect(thirdSummary.casesSkippedUnreadable).toBe(1);
  });

  // The legacy shape of the same bug, and the one the reservation index
  // cannot answer: a case imported by a build that had no reservations, whose
  // applicants have since been lost. There is no reservation to consult, so
  // the status sweep is the only thing standing between this ref and a second
  // case under it. The sweep reads `case_ref` straight off the raw case row
  // for exactly this reason -- a Zod parse of the case would fail here.
  it("never re-imports a ref held by a pre-reservation case whose applicants are gone", async () => {
    const context = await buildTestContext();
    const rows = [buildMappedRow()];
    const firstSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    const caseId = firstSummary.createdCaseIds[0]!;

    // Delete the reservation, so the ref looks like one imported before the
    // reservation index existed, and the applicants, so the case no longer
    // reassembles.
    await context.sql.query("delete from crm_case_ref_reservations where tenant_id = $1", ["rgs"]);
    await context.sql.query("delete from crm_applicants where tenant_id = $1 and case_id = $2", ["rgs", caseId]);
    expect(await readCase(context, "rgs", caseId).catch((error: Error) => error)).toBeInstanceOf(
      CorruptRecordError,
    );

    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedUnreadable).toBe(1);
    // One case under REF 31376, not two.
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toEqual(["31376"]);

    const open = await listReviewItems(context, "rgs", "OPEN");
    const unreadableItems = open.reviewItems.filter(
      (item) => item.reason === "UNREADABLE_STORED_CASE",
    );
    expect(unreadableItems).toHaveLength(1);
    expect(unreadableItems[0]!.rawValue).toBe("31376");
  });

  it("repairs a ref that was reserved before a run died, under the reserved caseId", async () => {
    const context = await buildTestContext();
    const rows = [buildMappedRow()];

    // The case's own insert fails, so the ref is reserved and no case exists
    // at all.
    const restoreHealthyClient = failStatements(context, isCaseInsert);
    await expect(
      runImport(context, "rgs", { ...baseInput, mappedRows: rows }),
    ).rejects.toThrow(/simulated write timeout/);
    restoreHealthyClient();
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toEqual([]);

    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    expect(secondSummary.casesCreated).toBe(1);
    const repairedCase = await readCase(context, "rgs", secondSummary.createdCaseIds[0]!);
    expect(repairedCase!.caseRef).toBe("31376");

    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(
      open.reviewItems.filter((item) => item.reason === "UNREADABLE_STORED_CASE"),
    ).toHaveLength(1);

    // A third run finds a completed reservation and leaves it alone -- the
    // repair must not itself become a source of duplicates.
    const thirdSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(thirdSummary.casesCreated).toBe(0);
    expect(thirdSummary.casesSkippedAlreadyImported).toBe(1);
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toEqual(["31376"]);
  });

  // NEW-3's own symptom, narrowed to a single unreadable member: a group is
  // only re-proposed while at least one of its refs is genuinely unaccounted
  // for. A ref held by an unreadable stored case IS accounted for -- the
  // operator already has an UNREADABLE_STORED_CASE item naming it -- so it
  // must count as settled here exactly like an already-imported ref does.
  it("does not re-propose a group whose only unsettled member is an unreadable case", async () => {
    const context = await buildTestContext();
    const unreadableRow = buildMappedRow({ caseRef: "31376", sourceRow: 2 });
    const cleanlyImportedRow = buildMappedRow({
      caseRef: "31377",
      sourceRow: 3,
      passportNumber: "V2404481",
    });
    const proposedGroups = [
      {
        caseRefs: ["31376", "31377"],
        partnerName: "VWI Mumbai",
        destinationCountry: "TR",
        receivedDate: "2025-01-02",
      },
    ];

    // Two settled states, established independently: one case imports
    // cleanly, the other is left reserved but unreadable.
    const importedSummary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [unreadableRow, cleanlyImportedRow],
    });
    await damageCaseKeepingReservationOpen(context, importedSummary.createdCaseIds[0]!, "31376");

    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [unreadableRow, cleanlyImportedRow],
      proposedGroups,
    });
    expect(summary.casesSkippedUnreadable).toBe(1);
    expect(summary.casesSkippedAlreadyImported).toBe(1);
    expect(summary.groupsProposed).toBe(0);

    // And it stays quiet: unchanged members must not get a different answer
    // on a following run.
    const repeatedSummary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [unreadableRow, cleanlyImportedRow],
      proposedGroups,
    });
    expect(repeatedSummary.groupsProposed).toBe(0);
  });

  /**
   * N11, checkpointing half. The caseRef reservation index already IS the
   * checkpoint: there is no checkpoint file, no `--resume` flag and no run-id.
   * The reservation rows are the durable per-ref record of what this import
   * has and has not finished, written ahead of the case itself.
   *
   * Resuming is therefore just "run the same command again", which is exactly
   * what the abort message tells the operator to do.
   */
  it("resumes from the reservation index after a part-way death, repairing rather than duplicating", async () => {
    const context = await buildTestContext();
    const rows = Array.from({ length: 6 }, (_unused, rowIndex) =>
      buildMappedRow({
        caseRef: String(60_001 + rowIndex),
        sourceRow: rowIndex + 2,
        passportNumber: `P${String(rowIndex).padStart(7, "0")}`,
      }),
    );
    const firstFourRows = rows.slice(0, 4);

    // A first run that finished: four completed reservations.
    const finishedSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: firstFourRows });
    expect(finishedSummary.casesCreated).toBe(4);

    // A second run over all six that dies between a ref's reservation and its
    // case -- the one window left between reserve and write.
    const restoreHealthyClient = failStatements(context, isCaseInsert);
    await expect(
      runImport(context, "rgs", { ...baseInput, mappedRows: rows }),
    ).rejects.toThrow(/simulated write timeout/);
    restoreHealthyClient();

    // The state that leaves: four refs complete, one reserved and unwritten.
    const unfinishedReservations = [];
    for (const row of rows) {
      const reservation = await readCaseRefReservation(context, "rgs", row.caseRef);
      if (reservation !== undefined && reservation.completedAt === undefined) {
        unfinishedReservations.push(reservation);
      }
    }
    expect(unfinishedReservations).toHaveLength(1);
    expect(await storedCaseRefsInStatus(context, "CLOSED")).toHaveLength(4);

    const resumedSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    // Completed refs skipped -- the checkpoint doing its job -- and the rest
    // written.
    expect(resumedSummary.casesSkippedAlreadyImported).toBe(4);
    expect(resumedSummary.casesCreated).toBe(2);

    // Repaired under the RESERVED caseId, not a fresh one. A fresh id is how a
    // second case ends up under one REF NO., which is C1's failure and the
    // reason a checkpoint has to name the id as well as the ref.
    for (const unfinishedReservation of unfinishedReservations) {
      const repairedCase = await readCase(context, "rgs", unfinishedReservation.caseId);
      expect({ caseRef: repairedCase?.caseRef, caseId: repairedCase?.caseId }).toEqual({
        caseRef: unfinishedReservation.caseRef,
        caseId: unfinishedReservation.caseId,
      });
    }

    const refsAfterResume = await storedCaseRefsInStatus(context, "CLOSED");
    expect(refsAfterResume.sort()).toEqual(rows.map((row) => row.caseRef).sort());
    expect(new Set(refsAfterResume).size).toBe(rows.length);

    // And the resumed run is itself a fixed point.
    const thirdSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(thirdSummary.casesCreated).toBe(0);
    expect(thirdSummary.casesSkippedAlreadyImported).toBe(rows.length);
  });

  it("completes each reservation, so a re-run reads no case at all", async () => {
    const context = await buildTestContext();
    const rows = [
      buildMappedRow({ caseRef: "1", sourceRow: 2, passportNumber: "P1111111" }),
      buildMappedRow({ caseRef: "2", sourceRow: 3, passportNumber: "P2222222" }),
    ];
    await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    // Half of the reserve -> write -> COMPLETE sequence. Without the third
    // step the reservation exists but is unfinished, which by design means
    // "a run died between the two writes".
    for (const row of rows) {
      const reservation = await readCaseRefReservation(context, "rgs", row.caseRef);
      expect(reservation?.completedAt).toBeTypeOf("string");
    }

    // NEW-5: and this is what the completion marker BUYS. An unfinished
    // reservation sends `claimCaseRef` down the repair path, which calls
    // `readCase` and then silently heals the marker, so the run still reports
    // the right counts. Only the reads tell you.
    let caseReads = 0;
    interceptSql(context, async ({ text }, run) => {
      if (/\bfrom\s+crm_applicants\b/i.test(text)) caseReads += 1;
      return run();
    });
    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });

    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedAlreadyImported).toBe(2);
    expect(caseReads).toBe(0);
  });

  it("still re-proposes a group extended by a newly imported row", async () => {
    const context = await buildTestContext();
    const firstRow = buildMappedRow({ caseRef: "1", sourceRow: 2, passportNumber: "P1111111" });
    const secondRow = buildMappedRow({ caseRef: "2", sourceRow: 3, passportNumber: "P2222222" });
    const proposedGroups = [
      {
        caseRefs: ["1", "2"],
        partnerName: "VWI Mumbai",
        destinationCountry: "TR",
        receivedDate: "2025-01-02",
      },
    ];
    await runImport(context, "rgs", { ...baseInput, mappedRows: [firstRow], proposedGroups });

    // Ref "2" is genuinely new, so the changed group is proposed again.
    const secondSummary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [firstRow, secondRow],
      proposedGroups,
    });

    expect(secondSummary.casesCreated).toBe(1);
    expect(secondSummary.groupsProposed).toBe(1);
  });

  it("flags a stored case whose row carries no readable ref", async () => {
    const context = await buildTestContext();
    await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });

    // A hand-repaired row: still a case, no longer naming its ref.
    await context.sql.query("update crm_cases set case_ref = '' where tenant_id = $1", ["rgs"]);
    await context.sql.query("delete from crm_case_ref_reservations where tenant_id = $1", ["rgs"]);

    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ caseRef: "99999", sourceRow: 3, passportNumber: "P9999999" })],
    });

    const open = await listReviewItems(context, "rgs", "OPEN");
    const unreadableItems = open.reviewItems.filter(
      (item) => item.reason === "UNREADABLE_STORED_CASE",
    );
    expect(unreadableItems).toHaveLength(1);
    expect(unreadableItems[0]!.detail).toMatch(/carries no readable REF NO/);
    // The unrelated row still imports: one unreadable stored case must not
    // stop the migration.
    expect(summary.casesCreated).toBe(1);
  });
});
