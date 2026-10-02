#!/usr/bin/env node
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillPortalSoRToPostgres } from "./backfillPortalSoRToPostgres";

// Reads Dynamo and writes Postgres regardless of CRM_STORE: this is the copy
// that makes CRM_STORE=postgres safe to turn on for portal applications,
// documents, profiles and activity, so it must never read from the store it
// is filling.
//
// Optional ACTIVITY_START_DATE=YYYY-MM-DD widens the activity day-bucket walk
// beyond the earliest known profile/application.
const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}
const activityStartDate = process.env["ACTIVITY_START_DATE"];

const sql = createPgSqlClient(databaseUrl);
try {
  const result = await backfillPortalSoRToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    ...(activityStartDate ? { activityStartDate } : {}),
    onProgress: (label, n) => {
      if (n % 250 === 0) console.log(`...${n} ${label} copied`);
    },
  });
  console.table({
    applicationsUpserted: result.applicationsUpserted,
    documentsUpserted: result.documentsUpserted,
    profilesUpserted: result.profilesUpserted,
    activityEventsUpserted: result.activityEventsUpserted,
    unreadableApplications: result.unreadableApplicationIds.length,
    unreadableDocuments: result.unreadableDocumentIds.length,
    unreadableUsers: result.unreadableUserIds.length,
    unreadableEvents: result.unreadableEventIds.length,
  });
  const namedProblems: Array<[string, string[]]> = [
    ["Applications not copied (applicationId)", result.unreadableApplicationIds],
    ["Application documents not copied (applicationId / SK)", result.unreadableDocumentIds],
    ["User profiles not copied (userId)", result.unreadableUserIds],
    ["Activity events not copied (eventId)", result.unreadableEventIds],
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
