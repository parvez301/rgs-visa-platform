#!/usr/bin/env node
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillCrmRemainingToPostgres } from "./backfillCrmRemainingToPostgres";

// Reads Dynamo and writes Postgres regardless of CRM_STORE: this is the copy
// that makes CRM_STORE=postgres safe to turn on, so it must never read from
// the store it is filling.
//
// CRM_BACKFILL_EXTRA_EMAILS (comma-separated, optional): users whose prefs and
// USER-scope memories to copy even when no case, proposal or memory names them.
const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}
const extraEmails = (process.env["CRM_BACKFILL_EXTRA_EMAILS"] ?? "")
  .split(",")
  .map((email) => email.trim())
  .filter((email) => email.length > 0);

const sql = createPgSqlClient(databaseUrl);
try {
  const result = await backfillCrmRemainingToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    tenantId: DEFAULT_TENANT_ID,
    extraEmails,
    onProgress: (label, n) => {
      if (n % 250 === 0) console.log(`...${n} ${label} copied`);
    },
  });
  console.table({
    reservationsUpserted: result.reservationsUpserted,
    reviewItemsUpserted: result.reviewItemsUpserted,
    proposalsUpserted: result.proposalsUpserted,
    memoriesUpserted: result.memoriesUpserted,
    prefsUpserted: result.prefsUpserted,
    templatesUpserted: result.templatesUpserted,
    unreadableReservations: result.unreadableReservationIds.length,
    unreadableReviewItems: result.unreadableReviewItemIds.length,
    unreadableProposals: result.unreadableProposalIds.length,
    unreadableMemories: result.unreadableMemoryKeys.length,
    unreadablePrefs: result.unreadablePrefsEmails.length,
    unreadableTemplates: result.unreadableTemplateStatuses.length,
  });
  const namedProblems: Array<[string, string[]]> = [
    ["Case ref reservations not copied (caseRef)", result.unreadableReservationIds],
    ["Review items not copied", result.unreadableReviewItemIds],
    ["Proposals not copied", result.unreadableProposalIds],
    ["Memories not copied (memoryKey)", result.unreadableMemoryKeys],
    ["User prefs not copied (email)", result.unreadablePrefsEmails],
    ["Status email templates not copied (case status)", result.unreadableTemplateStatuses],
  ];
  for (const [description, ids] of namedProblems) {
    if (ids.length > 0) console.error(`${description}: ${ids.join(", ")}`);
  }
  // Anything this job could not copy fails the run, so a cutover gate on the
  // exit code cannot pass with records left behind.
  process.exitCode = namedProblems.some(([, ids]) => ids.length > 0) ? 1 : 0;
} finally {
  await sql.end();
}
