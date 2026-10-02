#!/usr/bin/env node
import { runMigrateCountryDocumentsToProductsCli } from "./runMigrateCountryDocumentsToProductsCli";

const cliResult = runMigrateCountryDocumentsToProductsCli({
  logError: (message) => console.error(message),
});

process.exitCode = cliResult.exitCode;
