#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runSeedStatusEmailTemplatesCli } from "./runSeedStatusEmailTemplatesCli";

const cliResult = await runSeedStatusEmailTemplatesCli({
  buildContext: buildProductionContext,
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
