#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runBackfillRefClaimsCli } from "./runBackfillRefClaimsCli";

const cliResult = await runBackfillRefClaimsCli({
  buildContext: buildProductionContext,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
