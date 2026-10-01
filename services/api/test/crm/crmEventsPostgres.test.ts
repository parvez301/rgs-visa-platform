import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { listCaseEvents, recordCrmEvent } from "../../src/domain/crm/crmEvents";
import { casePartitionKey } from "../../src/domain/crm/keys";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext } from "../helpers";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

describe("CRM events on Postgres", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
  });

  function postgresContext() {
    return { ...buildTestContext(), crmStore: "postgres" as const, sql };
  }

  it("records an event and returns it with the same shape Dynamo returns", async () => {
    const context = postgresContext();
    const recorded = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test", {
      note: "hello",
      count: 2,
      flag: true,
    });

    expect(recorded.createdAt).toBe("2026-07-23T10:00:00.000Z");
    expect(recorded.eventId).toMatch(/^crmevt_/);
    expect(await listCaseEvents(context, "rgs", "case_1")).toEqual([recorded]);
  });

  it("lists events oldest first, ordered by created_at not insertion order", async () => {
    const context = postgresContext();
    const first = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    context.advanceClock(5_000);
    const second = await recordCrmEvent(context, "rgs", "case_1", "CASE_UPDATED", "a@rgs.test");
    context.advanceClock(5_000);
    const third = await recordCrmEvent(context, "rgs", "case_1", "CUSTODY_CHANGED", "b@rgs.test");

    // Late insert of an earlier-timestamped row must still sort first.
    await sql.query(
      `insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
       values ('rgs', 'crmevt_backdated', 'case_1', 'CASE_UPDATED', 'a@rgs.test', '{}'::jsonb,
               '2026-07-23T09:00:00.000Z')`,
    );

    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events.map((event) => event.eventId)).toEqual([
      "crmevt_backdated",
      first.eventId,
      second.eventId,
      third.eventId,
    ]);
  });

  it("breaks created_at ties by eventId, like the Dynamo sort key", async () => {
    const context = postgresContext();
    await sql.query(
      `insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
       values ('rgs', 'evt_b', 'case_1', 'CASE_UPDATED', 'a@rgs.test', '{}'::jsonb, '2026-07-23T10:00:00.000Z'),
              ('rgs', 'evt_a', 'case_1', 'CASE_UPDATED', 'a@rgs.test', '{}'::jsonb, '2026-07-23T10:00:00.000Z')`,
    );
    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events.map((event) => event.eventId)).toEqual(["evt_a", "evt_b"]);
  });

  it("keeps millisecond precision and UTC formatting on createdAt", async () => {
    const context = postgresContext();
    context.advanceClock(123);
    const recorded = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    expect(recorded.createdAt).toBe("2026-07-23T10:00:00.123Z");
    const [listed] = await listCaseEvents(context, "rgs", "case_1");
    expect(listed?.createdAt).toBe("2026-07-23T10:00:00.123Z");
  });

  it("scopes events by tenant and case", async () => {
    const context = postgresContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    await recordCrmEvent(context, "rgs", "case_2", "CASE_CREATED", "a@rgs.test");
    await recordCrmEvent(context, "other", "case_1", "CASE_CREATED", "a@rgs.test");

    expect(await listCaseEvents(context, "rgs", "case_1")).toHaveLength(1);
    expect(await listCaseEvents(context, "rgs", "case_2")).toHaveLength(1);
    expect(await listCaseEvents(context, "other", "case_1")).toHaveLength(1);
    expect(await listCaseEvents(context, "rgs", "nope")).toEqual([]);
  });

  it("round-trips empty and nested-free meta", async () => {
    const context = postgresContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    const [listed] = await listCaseEvents(context, "rgs", "case_1");
    expect(listed?.meta).toEqual({});
  });

  it("leaves Dynamo untouched", async () => {
    const context = postgresContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    expect(await context.table.query(casePartitionKey("rgs", "case_1"))).toEqual([]);
  });

  it("refuses to run without a SQL client rather than falling back to Dynamo", async () => {
    const context = { ...buildTestContext(), crmStore: "postgres" as const };
    await expect(
      recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test"),
    ).rejects.toThrow(/context\.sql/);
    await expect(listCaseEvents(context, "rgs", "case_1")).rejects.toThrow(/context\.sql/);
  });

  it("keeps using Dynamo when crmStore is dynamo, even if sql is present", async () => {
    const context = { ...buildTestContext(), crmStore: "dynamo" as const, sql };
    const recorded = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    expect(await listCaseEvents(context, "rgs", "case_1")).toEqual([recorded]);
    const rows = await sql.query(`select 1 from crm_events`);
    expect(rows.rows).toHaveLength(0);
  });
});
