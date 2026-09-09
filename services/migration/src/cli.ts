#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { readWorkbook } from "./readWorkbook";
import { runImportCli } from "./importCli";

/**
 * The bin shim, and nothing else. Everything that decides anything lives in
 * `importCli.ts`, which has no import-time side effects and takes its argv and
 * its dependencies as arguments (finding N8).
 *
 * The one thing that cannot move is this file's own reason to exist: reading
 * `process.argv`, choosing the real context factory and the real workbook
 * reader, and setting an exit code.
 *
 * `process.exitCode` rather than `process.exit()`: exit() truncates pending
 * stdout, which on a run whose entire output is a summary table is how an
 * operator ends up with half a table.
 */
const cliResult = await runImportCli(process.argv.slice(2), {
  buildContext: buildProductionContext,
  readWorkbookAt: readWorkbook,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
