import { buildTestContext } from "@rgs/api/test/helpers";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import { readWorkbook } from "./src/readWorkbook";
import { mapRow } from "./src/mapRow";
import { joinPhones } from "./src/joinPhones";
import { proposeGroups } from "./src/groupCases";
import { passthroughResidueResolver } from "./src/residueResolver";
import { runImport } from "./src/importRun";
import { readCase } from "@rgs/api/src/domain/crm/caseStore";

const PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";

const extract = await readWorkbook(PATH);
const mappedRows = extract.miniCrmRows.map(mapRow);
const context = buildTestContext();
const contactDetails = joinPhones(mappedRows, extract.yearRows);
const proposedGroups = proposeGroups(mappedRows);
const input = {
  mappedRows,
  contactDetails,
  proposedGroups,
  residueResolver: passthroughResidueResolver,
  actorEmail: "measure@rgs.local",
  dryRun: false,
};

console.log("miniCrmRows", extract.miniCrmRows.length, "yearRows", extract.yearRows.length);
const run1 = await runImport(context, "rgs", input);
console.log("RUN1", JSON.stringify({ ...run1, createdCaseIds: run1.createdCaseIds.length }));
const run2 = await runImport(context, "rgs", input);
console.log("RUN2", JSON.stringify({ ...run2, createdCaseIds: run2.createdCaseIds.length }));
const run3 = await runImport(context, "rgs", input);
console.log("RUN3", JSON.stringify({ ...run3, createdCaseIds: run3.createdCaseIds.length }));

const open = await listReviewItems(context, "rgs", "OPEN", 1_000_000);
const byReason = new Map<string, number>();
for (const item of open.reviewItems) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
console.log("review items total", open.reviewItems.length);
console.log("by reason", [...byReason.entries()].sort((a, b) => b[1] - a[1]));

const byField = new Map<string, number>();
for (const item of open.reviewItems) byField.set(item.fieldName, (byField.get(item.fieldName) ?? 0) + 1);
console.log("by field", [...byField.entries()].sort((a, b) => b[1] - a[1]));

// Store-level counts, read back rather than trusted from the summary.
const billing = new Map<string, number>();
const legacyKeyCounts = new Map<string, number>();
let courierDateCount = 0;
let trackingCount = 0;
let caseCount = 0;
for (const caseId of run1.createdCaseIds) {
  const storedCase = await readCase(context, "rgs", caseId);
  if (!storedCase) continue;
  caseCount += 1;
  billing.set(storedCase.billingStatus, (billing.get(storedCase.billingStatus) ?? 0) + 1);
  if (storedCase.courierDate !== undefined) courierDateCount += 1;
  if (storedCase.applicants[0]?.trackingNumber !== undefined) trackingCount += 1;
  for (const key of Object.keys(storedCase.legacyRaw ?? {}))
    legacyKeyCounts.set(key, (legacyKeyCounts.get(key) ?? 0) + 1);
}
console.log("cases read back", caseCount);
console.log("billingStatus", [...billing.entries()].sort((a, b) => b[1] - a[1]));
console.log("courierDate present", courierDateCount);
console.log("applicant trackingNumber present", trackingCount);
console.log("legacyRaw keys", [...legacyKeyCounts.entries()].sort((a, b) => b[1] - a[1]));

// How many tracking numbers exist only on Mini CRM (the 31 the join lost).
let onlyOnMiniCrm = 0;
for (const row of mappedRows) {
  if (row.trackingNumber !== undefined && contactDetails.get(row.caseRef)?.trackingNumber === undefined)
    onlyOnMiniCrm += 1;
}
console.log("tracking numbers present on Mini CRM but not from the year join", onlyOnMiniCrm);

const dryRunContext = buildTestContext();
const dryRun = await runImport(dryRunContext, "rgs", { ...input, dryRun: true });
console.log("DRY RUN", JSON.stringify({ ...dryRun, createdCaseIds: dryRun.createdCaseIds.length }));
