import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
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

      // Measured 2026-09-09 after the whole-branch fix round: 238 partners,
      // 3,980 review items (was 3,932 before the round -- +21 COLUMN_SHIFT_JUNK
      // and +4 MISSING_REQUIRED_FIELD from the `No.` column, +22 DUPLICATE_REF
      // from withheld contact details and "2025 YEAR" self-conflicts, +2
      // UNMAPPED_STATUS from the payment column, -1 SUSPECT_PHONE now that a
      // duplicated ref raises one phone item rather than two). Banded, not
      // exact -- the sheet is live and will keep gaining rows, and a band
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
    }, 60_000);
  },
);
