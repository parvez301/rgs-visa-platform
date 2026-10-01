#!/usr/bin/env node
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { DynamoTableClient } from "@rgs/api/src/lib/db";
import { createPgSqlClient, databaseUrlFromEnvironment } from "@rgs/api/src/lib/sql";
import { backfillCrmCaseSorToPostgres } from "./backfillCrmCaseSorToPostgres";

// Reads Dynamo and writes Postgres regardless of CRM_STORE: this is the copy
// that makes CRM_STORE=postgres safe to turn on, so it must never read from
// the store it is filling.
const tableName = process.env["TABLE_NAME"];
const databaseUrl = databaseUrlFromEnvironment(process.env);
if (!tableName || databaseUrl === undefined) {
  console.error("Missing required environment: TABLE_NAME, DATABASE_URL");
  process.exit(1);
}

const sql = createPgSqlClient(databaseUrl);
try {
  const result = await backfillCrmCaseSorToPostgres({
    table: new DynamoTableClient(tableName),
    sql,
    tenantId: DEFAULT_TENANT_ID,
    onProgress: (casesUpserted) => {
      if (casesUpserted % 250 === 0) console.log(`...${casesUpserted} cases copied`);
    },
  });
  console.table({
    partnersUpserted: result.partnersUpserted,
    travellersUpserted: result.travellersUpserted,
    casesUpserted: result.casesUpserted,
    eventsInserted: result.eventsInserted,
    refClaimsUpserted: result.refClaimsUpserted,
    unreadablePartners: result.unreadablePartnerIds.length,
    unreadableCases: result.unreadableCaseIds.length,
    unreadableTravellers: result.unreadableTravellerIds.length,
    unreadableEvents: result.unreadableEventIds.length,
    casesMissingRefClaims: result.casesMissingRefClaims.length,
  });
  const namedProblems: Array<[string, string[]]> = [
    ["Partners not copied (unreadable META)", result.unreadablePartnerIds],
    ["Cases not copied (unreadable, or rejected by Postgres: see warnings above)", result.unreadableCaseIds],
    ["Travellers not copied (missing, unreadable, or rejected by Postgres)", result.unreadableTravellerIds],
    ["Events not copied (unreadable)", result.unreadableEventIds],
    [
      "Cases with a REF that has no claim in Dynamo (run backfill:ref-claims, then re-run this)",
      result.casesMissingRefClaims,
    ],
  ];
  for (const [description, ids] of namedProblems) {
    if (ids.length > 0) console.error(`${description}: ${ids.join(", ")}`);
  }
  // Missing claims are a warning, not a failure: the claims are Dynamo data this
  // job copies and does not invent. Anything it could not copy fails the run, so
  // a cutover gate on the exit code cannot pass with records left behind.
  process.exitCode =
    result.unreadablePartnerIds.length > 0 ||
    result.unreadableCaseIds.length > 0 ||
    result.unreadableTravellerIds.length > 0 ||
    result.unreadableEventIds.length > 0
      ? 1
      : 0;
} finally {
  await sql.end();
}
