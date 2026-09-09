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
const importSummary = await runImport(buildProductionContext(), values.tenant, {
  mappedRows,
  contactDetails: joinPhones(mappedRows, workbookExtract.yearRows),
  proposedGroups: proposeGroups(mappedRows),
  residueResolver: passthroughResidueResolver,
  actorEmail: values.actor,
  dryRun,
});

console.table(importSummary);
