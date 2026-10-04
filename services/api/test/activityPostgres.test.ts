import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRecentActivity, listUserActivity } from "../src/domain/activity";
import {
  insertActivityEventPostgres,
  listRecentActivityPostgres,
  listUserActivityPostgres,
} from "../src/domain/activityPostgres";
import { logActivity, type AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, closeTestContexts, type TestContext } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("activity", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
  });

  afterEach(closeTestContexts);

  it("logs into activity_events", async () => {
    const logged = await logActivity(
      context,
      "STATUS_CHANGED",
      "user_1",
      "app_1",
      { from: "DRAFT", to: "SUBMITTED", count: 2, flag: true },
      { actorEmail: "admin@rgs.local", actorRole: "admin" },
    );
    expect(logged).toMatchObject({
      eventType: "STATUS_CHANGED",
      userId: "user_1",
      applicationId: "app_1",
      actorEmail: "admin@rgs.local",
      actorRole: "admin",
    });
    const stored = await listUserActivityPostgres(sql, "user_1", 10);
    expect(stored).toEqual({ events: [logged], unreadableEventIds: [] });
  });

  it("omits absent optional fields and round-trips empty meta", async () => {
    const logged = await logActivity(context, "SIGNED_UP", "user_1", undefined);
    const { events } = await listUserActivityPostgres(sql, "user_1", 10);
    expect(events).toEqual([logged]);
    expect(events[0]).not.toHaveProperty("applicationId");
    expect(events[0]).not.toHaveProperty("actorEmail");
    expect(events[0]).not.toHaveProperty("actorRole");
    expect(events[0]!.meta).toEqual({});
  });

  it("lists recent activity newest first inside the window only, honouring limit", async () => {
    await logActivity(context, "SIGNED_UP", "user_old", undefined);
    context.advanceClock(3 * DAY_MS);
    const inside1 = await logActivity(context, "SIGNED_UP", "user_a", undefined);
    context.advanceClock(60_000);
    const inside2 = await logActivity(context, "APPLICATION_STARTED", "user_b", "app_2");
    context.advanceClock(60_000);
    const inside3 = await logActivity(context, "SUBMITTED", "user_a", "app_1");

    const all = await listRecentActivity(context, 2, 100);
    expect(all.events.map((event) => event.eventId)).toEqual([
      inside3.eventId,
      inside2.eventId,
      inside1.eventId,
    ]);
    expect(all.unreadableEventIds).toEqual([]);

    const limited = await listRecentActivity(context, 2, 2);
    expect(limited.events.map((event) => event.eventId)).toEqual([
      inside3.eventId,
      inside2.eventId,
    ]);
  });

  it("window is an exact time cut-off, not a day bucket", async () => {
    // Event 47h ago is in a 2-day window; one 49h ago is out, even on the same UTC day bucket edge.
    await logActivity(context, "SIGNED_UP", "user_out", undefined);
    context.advanceClock(1 * DAY_MS);
    const kept = await logActivity(context, "SIGNED_UP", "user_in", undefined);
    context.advanceClock(DAY_MS + 60 * 60 * 1000);
    const result = await listRecentActivity(context, 1, 100);
    expect(result.events).toEqual([]);
    const wider = await listRecentActivity(context, 2, 100);
    expect(wider.events.map((event) => event.eventId)).toEqual([kept.eventId]);
  });

  it("lists one user's trail newest first, ignoring other users", async () => {
    const first = await logActivity(context, "SIGNED_UP", "user_a", undefined);
    context.advanceClock(1000);
    await logActivity(context, "SIGNED_UP", "user_b", undefined);
    context.advanceClock(1000);
    const last = await logActivity(context, "SUBMITTED", "user_a", "app_1");
    const trail = await listUserActivity(context, "user_a", 100);
    expect(trail.events.map((event) => event.eventId)).toEqual([last.eventId, first.eventId]);
    expect((await listUserActivity(context, "user_a", 1)).events).toHaveLength(1);
    expect((await listUserActivity(context, "nobody", 10)).events).toEqual([]);
  });

  it("skips and names a row that no longer parses, in both listings", async () => {
    const good = await logActivity(context, "SIGNED_UP", "user_a", undefined);
    await sql.query(
      `insert into activity_events (event_id, event_type, user_id, meta, created_at)
       values ('evt_bad', 'NOT_A_TYPE', 'user_a', '{}'::jsonb, $1::timestamptz)`,
      [context.now().toISOString()],
    );
    const recent = await listRecentActivity(context, 2, 100);
    expect(recent.events).toEqual([good]);
    expect(recent.unreadableEventIds).toEqual(["evt_bad"]);
    const user = await listUserActivity(context, "user_a", 100);
    expect(user.events).toEqual([good]);
    expect(user.unreadableEventIds).toEqual(["evt_bad"]);
  });

  it("insertActivityEventPostgres is idempotent on event id", async () => {
    const event = {
      eventId: "evt_fixed",
      eventType: "SIGNED_UP" as const,
      userId: "user_1",
      meta: {},
      createdAt: "2026-07-23T10:00:00.000Z",
    };
    await insertActivityEventPostgres(sql, event);
    await insertActivityEventPostgres(sql, event);
    const { events } = await listRecentActivityPostgres(sql, "2026-07-01T00:00:00.000Z", 10);
    expect(events).toEqual([event]);
  });

  it("fails loudly when postgres is selected without a SQL client", async () => {
    const { sql: _removed, ...rest } = context;
    void _removed;
    const withoutSql = rest as unknown as AppContext;
    await expect(logActivity(withoutSql, "SIGNED_UP", "user_1", undefined)).rejects.toThrow(
      "AppContext.sql is required",
    );
  });
});
