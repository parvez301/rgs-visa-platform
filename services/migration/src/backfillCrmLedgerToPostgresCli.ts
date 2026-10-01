#!/usr/bin/env node
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillCrmLedgerToPostgres } from "./backfillCrmLedgerToPostgres";

const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}

const sql = createPgSqlClient(databaseUrl);
try {
  await applyMigrations(sql);
  const result = await backfillCrmLedgerToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    tenantId: DEFAULT_TENANT_ID,
    onProgress: (casesUpserted) => {
      if (casesUpserted % 250 === 0) console.log(`...${casesUpserted} cases upserted`);
    },
  });
  console.table({
    partnersUpserted: result.partnersUpserted,
    casesUpserted: result.casesUpserted,
    unreadableCases: result.unreadableCaseIds.length,
    unreadablePartners: result.unreadablePartnerIds.length,
  });
  if (result.unreadableCaseIds.length > 0) {
    console.error(`Cases not inserted (unreadable META): ${result.unreadableCaseIds.join(", ")}`);
  }
  if (result.unreadablePartnerIds.length > 0) {
    console.error(`Partners not inserted (unreadable META): ${result.unreadablePartnerIds.join(", ")}`);
  }
  process.exitCode =
    result.unreadableCaseIds.length > 0 || result.unreadablePartnerIds.length > 0 ? 1 : 0;
} finally {
  await sql.end();
}
