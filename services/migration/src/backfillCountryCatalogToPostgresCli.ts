#!/usr/bin/env node
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillCountryCatalogToPostgres } from "./backfillCountryCatalogToPostgres";

// Reads Dynamo and writes Postgres regardless of CRM_STORE: this is the copy
// that makes CRM_STORE=postgres safe to turn on for the country catalog, so it
// must never read from the store it is filling.
const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}

const sql = createPgSqlClient(databaseUrl);
try {
  const result = await backfillCountryCatalogToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    tenantId: DEFAULT_TENANT_ID,
    onProgress: (label, n) => {
      if (n % 250 === 0) console.log(`...${n} ${label} copied`);
    },
  });
  console.table({
    productsUpserted: result.productsUpserted,
    checklistCountriesMerged: result.checklistCountriesMerged,
    unreadableProducts: result.unreadableProductIds.length,
    unreadableChecklists: result.unreadableChecklistCountryCodes.length,
  });
  const namedProblems: Array<[string, string[]]> = [
    ["Country products not copied (countryCode#productCode)", result.unreadableProductIds],
    ["Country checklists not merged (countryCode)", result.unreadableChecklistCountryCodes],
  ];
  for (const [description, ids] of namedProblems) {
    if (ids.length > 0) console.error(`${description}: ${ids.join(", ")}`);
  }
  // Anything this job could not copy or fold fails the run, so a cutover gate
  // on the exit code cannot pass with records left behind.
  process.exitCode = namedProblems.some(([, ids]) => ids.length > 0) ? 1 : 0;
} finally {
  await sql.end();
}
