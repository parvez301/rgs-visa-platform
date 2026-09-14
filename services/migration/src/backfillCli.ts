#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runBackfillCli } from "./runBackfillCli";

/**
 * The bin shim, and nothing else -- see `runBackfillCli.ts` for why. Same
 * `process.exitCode` (not `process.exit()`) as `cli.ts`, for the same reason:
 * `exit()` truncates pending stdout, which on a run whose entire output is a
 * summary table is how an operator ends up with half a table.
 */
const cliResult = await runBackfillCli({
  buildContext: buildProductionContext,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
