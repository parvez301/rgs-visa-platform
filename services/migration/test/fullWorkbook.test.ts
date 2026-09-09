import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
import { readWorkbook } from "../src/readWorkbook";
import { mapRow } from "../src/mapRow";
import { joinPhones } from "../src/joinPhones";
import { proposeGroups } from "../src/groupCases";
import { passthroughResidueResolver } from "../src/residueResolver";
import { runImport } from "../src/importRun";

const WORKBOOK_PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";
const workbookIsPresent = existsSync(WORKBOOK_PATH);

/**
 * The file lives outside the repo and CI will not have it -- this whole
 * suite is a LOCAL rehearsal, not a CI gate. The describe title itself names
 * the expected path so a `vitest run` skip line is self-explanatory instead
 * of a silent, unexplained "↓ the real workbook".
 */
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

      // Measured (2026-09-09): 238 partners, 3,932 review items. Banded, not
      // exact -- the sheet is live and will keep gaining rows, and a band
      // here is more honest than freezing today's exact partner mix while
      // still catching the regressions that would blow well past it (e.g.
      // treating every blank cell as a review item, which would push this
      // over 4,600).
      expect(firstRunSummary.partnersCreated).toBeGreaterThan(150);
      expect(firstRunSummary.partnersCreated).toBeLessThan(320);
      expect(firstRunSummary.reviewItemsRecorded).toBeGreaterThan(3000);
      expect(firstRunSummary.reviewItemsRecorded).toBeLessThan(4500);

      const secondRunSummary = await runImport(context, "rgs-rehearsal", importInput);

      // The actual assertion this test exists for: re-running the SAME
      // extract against the SAME table creates zero of everything.
      expect(secondRunSummary.casesCreated).toBe(0);
      expect(secondRunSummary.partnersCreated).toBe(0);
      expect(secondRunSummary.travellersCreated).toBe(0);
      expect(secondRunSummary.reviewItemsRecorded).toBe(0);
      expect(secondRunSummary.groupsProposed).toBe(0);
      expect(secondRunSummary.casesSkippedAlreadyImported).toBe(mappedRows.length);
    }, 60_000);
  },
);
