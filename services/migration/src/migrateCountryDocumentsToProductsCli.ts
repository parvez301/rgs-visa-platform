#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runMigrateCountryDocumentsToProductsCli } from "./runMigrateCountryDocumentsToProductsCli";

const cliResult = await runMigrateCountryDocumentsToProductsCli({
  buildContext: buildProductionContext,
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
