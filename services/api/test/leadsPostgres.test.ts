import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLead, listNewLeads } from "../src/domain/leads";
import { insertLeadPostgres, listNewLeadsPostgres } from "../src/domain/leadsPostgres";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, closeTestContexts, type TestContext } from "./helpers";

const LEAD_INPUT = {
  fullName: "Smoke Lead",
  phone: "+919999999999",
  topic: "UAE visa",
  message: "hello",
};

describe("leads", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
  });

  afterEach(closeTestContexts);

  it("creates a lead in Postgres", async () => {
    const lead = await createLead(context, LEAD_INPUT);

    expect(await listNewLeadsPostgres(sql, 50)).toEqual([lead]);
  });

  it("still logs the activity and sends the admin email", async () => {
    await createLead(context, LEAD_INPUT);
    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.subject).toContain("UAE visa");
  });

  it("lists newest first with limit", async () => {
    const first = await createLead(context, { ...LEAD_INPUT, fullName: "First" });
    context.advanceClock(1000);
    const second = await createLead(context, { ...LEAD_INPUT, fullName: "Second" });
    context.advanceClock(1000);
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

  it("throws when sql is missing", async () => {
    const { sql: _removed, ...rest } = context;
    void _removed;
    const withoutSql = rest as unknown as AppContext;
    await expect(createLead(withoutSql, LEAD_INPUT)).rejects.toThrow(
      "AppContext.sql is required",
    );
    await expect(listNewLeads(withoutSql)).rejects.toThrow(
      "AppContext.sql is required",
    );
  });
});
