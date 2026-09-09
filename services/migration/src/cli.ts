#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { readWorkbook } from "./readWorkbook";
import { mapRow } from "./mapRow";
import { joinPhones } from "./joinPhones";
import { proposeGroups } from "./groupCases";
import { passthroughResidueResolver } from "./residueResolver";
import { runImport } from "./importRun";

const { values } = parseArgs({
  options: {
    workbook: { type: "string" },
    tenant: { type: "string", default: "rgs" },
    actor: { type: "string", default: "migration@rgs.local" },
    commit: { type: "boolean", default: false },
  },
});

if (values.workbook === undefined) {
  // "run" is required: "pnpm --filter @rgs/migration import" (no "run") hits
  // pnpm's own built-in `import` command instead of this package.json script.
  console.error("usage: pnpm --filter @rgs/migration run import --workbook <path.xlsx> [--commit]");
  process.exit(1);
}

// Writing is opt-in. A mistyped command must never touch a real table.
const dryRun = !values.commit;
console.log(dryRun ? "DRY RUN — nothing will be written. Pass --commit to write." : "COMMITTING to the table.");

const workbookExtract = await readWorkbook(values.workbook);
const mappedRows = workbookExtract.miniCrmRows.map(mapRow);

try {
  const importSummary = await runImport(buildProductionContext(), values.tenant, {
    mappedRows,
    contactDetails: joinPhones(mappedRows, workbookExtract.yearRows),
    proposedGroups: proposeGroups(mappedRows),
    residueResolver: passthroughResidueResolver,
    actorEmail: values.actor,
    dryRun,
  });

  // createdCaseIds is a 7,156-element array on a real run, and console.table
  // renders an array into one unreadable cell. The operator needs the count;
  // the ids are for callers, not for a terminal.
  const { createdCaseIds, ...countedSummary } = importSummary;
  console.table({ ...countedSummary, createdCaseIds: createdCaseIds.length });
} catch (error) {
  // An abort used to skip console.table entirely, so the operator got a stack
  // trace and no statement about what had already been written. Cases are
  // written one at a time and this is not transactional, so some of them are
  // on file -- and the only safe next step needs saying out loud.
  console.error(
    dryRun
      ? "DRY RUN FAILED — nothing was written."
      : "IMPORT ABORTED PART-WAY — some cases are already written. Re-running the same command is safe: each REF NO. is reserved before its case, so an already-imported ref is skipped and a half-written one is repaired under its original case id.",
  );
  throw error;
}
