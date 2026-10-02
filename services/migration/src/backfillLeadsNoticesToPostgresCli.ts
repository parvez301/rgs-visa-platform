#!/usr/bin/env node
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillLeadsNoticesToPostgres } from "./backfillLeadsNoticesToPostgres";

// Reads Dynamo and writes Postgres regardless of CRM_STORE: this is the copy
// that makes CRM_STORE=postgres safe to turn on for portal leads and notices,
// so it must never read from the store it is filling.
const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}

const sql = createPgSqlClient(databaseUrl);
try {
  const result = await backfillLeadsNoticesToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    onProgress: (label, n) => {
      if (n % 250 === 0) console.log(`...${n} ${label} copied`);
    },
  });
  console.table({
    leadsUpserted: result.leadsUpserted,
    noticesUpserted: result.noticesUpserted,
    unreadableLeads: result.unreadableLeadIds.length,
    unreadableNotices: result.unreadableNoticeIds.length,
  });
  const namedProblems: Array<[string, string[]]> = [
    ["Leads not copied (leadId)", result.unreadableLeadIds],
    ["Notices not copied (noticeId)", result.unreadableNoticeIds],
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
