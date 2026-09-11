import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { buildTestContext } from "@rgs/api/test/helpers";
import { caseStatusGsi1Pk } from "@rgs/api/src/domain/crm/keys";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import { readWorkbook } from "../src/readWorkbook";
import { mapRow } from "../src/mapRow";
import { joinPhones } from "../src/joinPhones";
import { proposeGroups } from "../src/groupCases";
import { passthroughResidueResolver } from "../src/residueResolver";
import { runImport } from "../src/importRun";

/**
 * Where the workbook is, in order of authority: the RGS_WORKBOOK_PATH
 * environment variable, then the path it sat at during the migration build.
 *
 * The hard-coded path alone was the whole problem: renaming or archiving the
 * file after cutover -- or running on any other machine -- turned every
 * assertion below into nothing, and the suite reported green. A second
 * developer would have had no way to run these at all, and the "migration N
 * passing" figure quoted in the ledger was reproducible on exactly one
 * machine.
 */
const DEFAULT_WORKBOOK_PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";
const WORKBOOK_PATH = process.env["RGS_WORKBOOK_PATH"] ?? DEFAULT_WORKBOOK_PATH;
const workbookIsPresent = existsSync(WORKBOOK_PATH);

/**
 * The file lives outside the repo and CI will not have it -- this whole
 * suite is a LOCAL rehearsal, not a CI gate. The describe title itself names
 * the expected path so a `vitest run` skip line is self-explanatory instead
 * of a silent, unexplained "↓ the real workbook".
 *
 * A skip is a hole in the evidence, so it is also stated where a machine can
 * see it: `RGS_REQUIRE_WORKBOOK=1` turns the absence into a failure, which is
 * what a cutover-day check or a CI job with the file mounted should set. The
 * always-running guard below says the same thing to a human reading output.
 */
const workbookIsRequired = process.env["RGS_REQUIRE_WORKBOOK"] === "1";

describe("the real workbook rehearsal's own preconditions", () => {
  it("is either running against a workbook or explicitly, visibly skipped", () => {
    if (!workbookIsPresent) {
      console.warn(
        `[fullWorkbook] SKIPPING the full-scale rehearsal: no workbook at ${WORKBOOK_PATH}. ` +
          "Set RGS_WORKBOOK_PATH to point at it, or RGS_REQUIRE_WORKBOOK=1 to make its absence a failure.",
      );
    }
    // Green by default, because CI genuinely has no copy of a file holding
    // 7,156 real customers' passport numbers. Red on demand, so "the gate ran"
    // is something a cutover check can actually assert rather than assume.
    expect(workbookIsPresent || !workbookIsRequired).toBe(true);
  });
});
describe.skipIf(!workbookIsPresent)(
  workbookIsPresent
    ? "the real workbook"
    : `the real workbook (SKIPPED: place the file at ${WORKBOOK_PATH} to run this suite locally; CI has no copy)`,
  () => {
    // Measured against the real file on 2026-09-09. The plan's original
    // figures (7,157 importable rows, 6,546 "2025 YEAR" rows) both predate
    // `normaliseRefNo` refusing the row-1001 broken-formula REF NO on BOTH
    // sheets -- that one row is why each corrected count is one lower.
    it("maps every row without throwing, and queues a plausible fraction", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      // Exact, measured against the real file. A loose band would hide the two
      // regressions most likely here: dropping the `caseRef === ""` guard admits
      // the 4 month-divider rows, and iterating `1..rowCount` instead of
      // `eachRow` admits ~391 blank rows.
      expect(extract.miniCrmRows.length).toBe(7156);
      expect(extract.yearRows.length).toBe(6545);

      const mappedRows = extract.miniCrmRows.map(mapRow);
      const rowsWithReview = mappedRows.filter((mappedRow) => mappedRow.reviewItems.length > 0);
      const reviewRate = rowsWithReview.length / mappedRows.length;

      // Blank = not recorded, so the queue must stay near the measured ~13.8%,
      // not the ~64.9% that treating blanks as review items would produce.
      expect(reviewRate).toBeLessThan(0.3);
      expect(reviewRate).toBeGreaterThan(0.02);
    }, 30_000);

    it("drops the month-divider rows instead of turning them into cases", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      const dividerRowNumbers = [5984, 6308, 6615, 6900];
      for (const dividerRowNumber of dividerRowNumbers) {
        expect(extract.miniCrmRows.some((row) => row.sourceRow === dividerRowNumber)).toBe(false);
      }
    }, 30_000);

    it("never emits a review item for a blank source cell", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      for (const rawRow of extract.miniCrmRows) {
        for (const pendingReviewItem of mapRow(rawRow).reviewItems) {
          expect(pendingReviewItem.rawValue.trim()).not.toBe("");
        }
      }
    }, 30_000);

    // --- J1: the reader stopped at column 14, so four populated columns were
    // --- never read at all. These are the exact cell counts, because the
    // --- whole finding was that a wrong column position reads zero and looks
    // --- like an empty column -- a band would hide precisely that.
    it("reads all four columns past Additional Items, at their measured counts", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      const populated = (pick: (row: (typeof extract.miniCrmRows)[number]) => string): number =>
        extract.miniCrmRows.filter((row) => pick(row).trim() !== "").length;

      expect(populated((row) => row.remarks)).toBe(270);
      expect(populated((row) => row.courierDateRaw)).toBe(256);
      expect(populated((row) => row.paymentStatus)).toBe(34);
      // c19, not c18: c18 is the sheet's own empty "Column 2" spacer, and
      // reading it returns 0 while looking exactly like a column with nothing
      // in it. 2,657 is what says the reader is on the right column.
      expect(populated((row) => row.trackingNumber)).toBe(2657);
    }, 30_000);

    // --- task-12-fix-2-brief.md A1/D2: adding MYANNMAR/LEXUMBOURG to the
    // shared country map (packages/shared/src/crm/normalize/country.ts) was
    // made for the intake eval, but it also changed what THIS importer does
    // with real rows -- and this suite stayed 165/165 green with the map
    // entries removed, so nothing here noticed. Neither correct spelling
    // ("Myanmar", "Luxembourg") appears anywhere in the sheet; these 20 rows
    // only resolve because the map now carries the misspelling itself. Pins
    // the delta so the next lookup-table edit cannot move it silently. -----
    it("resolves the Myannmar/Lexumbourg misspellings, and the second-order grouping effect that rode in with them (task-12-fix-2-brief.md A1/D2)", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      const mappedRows = extract.miniCrmRows.map(mapRow);

      const resolvedToMyanmar = mappedRows.filter((row) => row.caseDraft.destinationCountry === "MM");
      const resolvedToLuxembourg = mappedRows.filter((row) => row.caseDraft.destinationCountry === "LU");
      expect(resolvedToMyanmar.length).toBe(13);
      expect(resolvedToLuxembourg.length).toBe(7);

      const unmappedCountryItems = mappedRows.flatMap((row) =>
        row.reviewItems.filter((reviewItem) => reviewItem.reason === "UNMAPPED_COUNTRY"),
      );
      expect(unmappedCountryItems.length).toBe(225); // was 245 before the map change

      // groupCases.ts skips any row with no destinationCountry, so giving
      // these 20 rows a destination made 13 of them eligible for grouping.
      // Four new PROPOSED_GROUP candidates followed, all under partner
      // "ONE 97" -- a real change to what a human is asked to approve, not a
      // scoring artefact, and exactly the kind of consequence a
      // packages/shared edit can produce in a sibling service without
      // touching that service's own code at all.
      const proposedGroups = proposeGroups(mappedRows);
      expect(proposedGroups.length).toBe(1480); // was 1476 before the map change
      expect(proposedGroups.filter((group) => group.partnerName === "ONE 97").length).toBe(41); // was 37
    }, 30_000);

    // --- The plan's central promise: the sheet is LIVE, so a re-run is the
    // expected case, not the exception. A full 7,156-row run must be exactly
    // as idempotent as the small fixture-backed cases in importRun.test.ts --
    // this is what actually proves it at the real scale. ------------------
    it("is idempotent end to end: a second full-sheet run creates nothing", async () => {
      const extract = await readWorkbook(WORKBOOK_PATH);
      const mappedRows = extract.miniCrmRows.map(mapRow);
      const context = buildTestContext();
      const importInput = {
        mappedRows,
        contactDetails: joinPhones(mappedRows, extract.yearRows),
        proposedGroups: proposeGroups(mappedRows),
        residueResolver: passthroughResidueResolver,
        actorEmail: "migration-rehearsal@rgs.local",
        dryRun: false,
      };

      const firstRunSummary = await runImport(context, "rgs-rehearsal", importInput);

      // Structural, not measured: against an empty table every row creates a
      // case (duplicates get a derived ref rather than being skipped), and a
      // group is only skipped when every member is already imported, which
      // cannot be true yet on a first run.
      expect(firstRunSummary.casesCreated).toBe(mappedRows.length);
      expect(firstRunSummary.casesSkippedAlreadyImported).toBe(0);
      expect(firstRunSummary.groupsProposed).toBe(importInput.proposedGroups.length);

      // Measured 2026-09-10 after fix round 2: 238 partners, 3,994 review
      // items (3,980 after fix round 1, +14 UNCONFIRMED_PAYMENT from NEW-1 --
      // the rows whose payment cell says the money arrived, which are now
      // imported as BILL_SENT and queued rather than written PAID). Banded,
      // not exact -- the sheet is live and will keep gaining rows, and a band
      // here is more honest than freezing today's exact partner mix while
      // still catching the regressions that would blow well past it (e.g.
      // treating every blank cell as a review item, which would push this
      // over 4,600).
      expect(firstRunSummary.partnersCreated).toBeGreaterThan(150);
      expect(firstRunSummary.partnersCreated).toBeLessThan(320);
      expect(firstRunSummary.reviewItemsRecorded).toBeGreaterThan(3000);
      expect(firstRunSummary.reviewItemsRecorded).toBeLessThan(4500);
      // Zero, exactly: a stored case the importer cannot read is a defect in
      // the store, not a property of the sheet, so a first run against an
      // empty table must never produce one.
      expect(firstRunSummary.casesSkippedUnreadable).toBe(0);

      const secondRunSummary = await runImport(context, "rgs-rehearsal", importInput);

      // The actual assertion this test exists for: re-running the SAME
      // extract against the SAME table creates zero of everything.
      expect(secondRunSummary.casesCreated).toBe(0);
      expect(secondRunSummary.partnersCreated).toBe(0);
      expect(secondRunSummary.travellersCreated).toBe(0);
      expect(secondRunSummary.reviewItemsRecorded).toBe(0);
      expect(secondRunSummary.groupsProposed).toBe(0);
      expect(secondRunSummary.casesSkippedAlreadyImported).toBe(mappedRows.length);
      expect(secondRunSummary.casesSkippedUnreadable).toBe(0);

      /**
       * NEW-1, at full scale and stated as the invariant rather than as a
       * count that will drift with the sheet: not one of the 7,156 migrated
       * cases may be written into a billing state it can never leave.
       *
       * `BILLING_TRANSITIONS` gives PAID and WRITTEN_OFF no exits, and
       * `changeBillingStatus` is on the forbidden list for migrated cases, so
       * a case written PAID off a spreadsheet cell is uncorrectable by
       * anything in the product -- and `isCaseClosable` then auto-CLOSEs it,
       * which is terminal too. Measured: BILL_SENT 32, PAID 0, and 14
       * UNCONFIRMED_PAYMENT items naming the cells that said otherwise.
       */
      const billingStatusTally = new Map<string, number>();
      for (const caseStatus of crm.CASE_STATUSES) {
        const metaItems = await context.table.queryGsi(
          "GSI1",
          caseStatusGsi1Pk("rgs-rehearsal", caseStatus),
          { limit: 100_000 },
        );
        for (const metaItem of metaItems) {
          const billingStatus = String(metaItem["billingStatus"] ?? "UNKNOWN");
          billingStatusTally.set(billingStatus, (billingStatusTally.get(billingStatus) ?? 0) + 1);
        }
      }
      for (const [billingStatus, caseCount] of billingStatusTally) {
        const isTerminal = crm.BILLING_STATUSES.every(
          (candidate) => !crm.canTransitionBilling(billingStatus as crm.BillingStatus, candidate),
        );
        expect({ billingStatus, caseCount, isTerminal }).toEqual({
          billingStatus,
          caseCount,
          isTerminal: false,
        });
      }
      expect(billingStatusTally.get("PAID")).toBeUndefined();
      expect(billingStatusTally.get("BILL_SENT")).toBe(32);

      const rehearsalQueue = await listReviewItems(context, "rgs-rehearsal", "OPEN", 100_000);
      const unconfirmedPayments = rehearsalQueue.reviewItems.filter(
        (reviewItem) => reviewItem.reason === "UNCONFIRMED_PAYMENT",
      );
      expect(unconfirmedPayments).toHaveLength(14);
      // Each one carries the cell it came from and the state to move to, or a
      // reviewer cannot act on it.
      for (const unconfirmedPayment of unconfirmedPayments) {
        expect(unconfirmedPayment.rawValue.trim()).not.toBe("");
        expect(unconfirmedPayment.proposedValue).toBe("PAID");
      }
    }, 60_000);
  },
);
