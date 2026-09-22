#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runBackfillSearchTextCli } from "./runBackfillSearchTextCli";

const cliResult = await runBackfillSearchTextCli({
  buildContext: buildProductionContext,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
