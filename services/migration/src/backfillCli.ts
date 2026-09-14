#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { backfillApplicantSummary } from "./backfillApplicantSummary";

// buildProductionContext is synchronous (services/api/src/http/handler.ts) --
// no await here, to match its real signature rather than the brief's draft.
const context = buildProductionContext();
const report = await backfillApplicantSummary(context, DEFAULT_TENANT_ID, {
  onProgress: (scanned) => {
    if (scanned % 250 === 0) console.log(`...${scanned} cases scanned`);
  },
});

console.table({
  scanned: report.scanned,
  written: report.written,
  alreadyCurrent: report.alreadyCurrent,
  unreadable: report.unreadableCaseIds.length,
});
if (report.unreadableCaseIds.length > 0) {
  console.error(`Cases that could not be reassembled: ${report.unreadableCaseIds.join(", ")}`);
}
// Unreadable cases are a finding, not a failure: the run did everything it
// could and said what it could not do.
process.exitCode = 0;
