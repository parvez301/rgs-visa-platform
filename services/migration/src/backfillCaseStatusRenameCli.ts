#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runBackfillCaseStatusRenameCli } from "./runBackfillCaseStatusRenameCli";

const cliResult = await runBackfillCaseStatusRenameCli({
  buildContext: buildProductionContext,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
