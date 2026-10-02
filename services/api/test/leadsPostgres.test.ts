import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { createLead, listNewLeads } from "../src/domain/leads";
import { insertLeadPostgres, listNewLeadsPostgres } from "../src/domain/leadsPostgres";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, type TestContext } from "./helpers";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

const LEAD_INPUT = {
  fullName: "Smoke Lead",
  phone: "+919999999999",
  topic: "UAE visa",
  message: "hello",
};

describe("leads with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext();
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  it("creates a lead in Postgres and leaves Dynamo without LEAD# / STATUS#LEAD_NEW", async () => {
    const lead = await createLead(context, LEAD_INPUT);

    expect(await listNewLeadsPostgres(sql, 50)).toEqual([lead]);
    expect(await baseContext.table.get(`LEAD#${lead.leadId}`, "PROFILE")).toBeUndefined();
    const gsi = await baseContext.table.queryGsi("GSI1", "STATUS#LEAD_NEW");
    expect(gsi.filter((item) => item["leadId"] === lead.leadId)).toHaveLength(0);
  });

  it("still logs the activity and sends the admin email", async () => {
    await createLead(context, LEAD_INPUT);
    expect(baseContext.email.sentEmails).toHaveLength(1);
    expect(baseContext.email.sentEmails[0]!.subject).toContain("UAE visa");
  });

  it("lists newest first with limit", async () => {
    const first = await createLead(context, { ...LEAD_INPUT, fullName: "First" });
    baseContext.advanceClock(1000);
    const second = await createLead(context, { ...LEAD_INPUT, fullName: "Second" });
    baseContext.advanceClock(1000);
    const third = await createLead(context, { ...LEAD_INPUT, fullName: "Third" });

    const listed = await listNewLeads(context, 2);
    expect(listed.map((lead) => lead.leadId)).toEqual([third.leadId, second.leadId]);
    expect((await listNewLeads(context)).map((lead) => lead.leadId)).toEqual([
      third.leadId,
      second.leadId,
      first.leadId,
    ]);
  });

  it("round-trips an empty message and upserts on the same lead id", async () => {
    const lead = await createLead(context, { ...LEAD_INPUT, message: "" });
    expect((await listNewLeadsPostgres(sql))[0]!.message).toBe("");
    await insertLeadPostgres(sql, { ...lead, topic: "Changed" });
    const listed = await listNewLeadsPostgres(sql);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.topic).toBe("Changed");
  });

  it("throws rather than falling back to Dynamo when sql is missing", async () => {
    const withoutSql = { ...baseContext, crmStore: "postgres" } as AppContext;
    await expect(createLead(withoutSql, LEAD_INPUT)).rejects.toThrow(
      "CRM_STORE=postgres requires context.sql",
    );
    await expect(listNewLeads(withoutSql)).rejects.toThrow(
      "CRM_STORE=postgres requires context.sql",
    );
  });
});

describe("leads with the Dynamo store", () => {
  it("keeps the Dynamo path when CRM_STORE is not postgres", async () => {
    const dynamoContext = buildTestContext();
    const lead = await createLead(dynamoContext, LEAD_INPUT);
    expect(await dynamoContext.table.get(`LEAD#${lead.leadId}`, "PROFILE")).toBeTruthy();
    expect(await listNewLeads(dynamoContext)).toEqual([lead]);
  });
});
