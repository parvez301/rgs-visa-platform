#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runSeedCountryChecklistsFromConfigCli } from "./runSeedCountryChecklistsFromConfigCli";

const cliResult = await runSeedCountryChecklistsFromConfigCli({
  buildContext: buildProductionContext,
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
