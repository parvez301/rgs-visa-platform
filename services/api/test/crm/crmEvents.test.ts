import { afterEach, describe, expect, it } from "vitest";
import { buildTestContext, closeTestContexts } from "../helpers";
import { listCaseEvents, recordCrmEvent } from "../../src/domain/crm/crmEvents";

afterEach(closeTestContexts);

describe("crm events", () => {

  it("records an event under the case partition", async () => {
    const context = await buildTestContext();
    const event = await recordCrmEvent(
      context,
      "rgs",
      "case_1",
      "CASE_CREATED",
      "ops@rgs.test",
      { caseRef: "31377" },
    );

    expect(event.eventType).toBe("CASE_CREATED");
    expect(event.actorEmail).toBe("ops@rgs.test");
    expect(event.meta["caseRef"]).toBe("31377");
    expect(event.createdAt).toBe("2026-07-23T10:00:00.000Z");
  });

  it("lists events for a case in the order they happened", async () => {
    const context = await buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    context.advanceClock(60_000);
    await recordCrmEvent(context, "rgs", "case_1", "CASE_STATUS_CHANGED", "ops@rgs.test", {
      fromStatus: "NEW",
      toStatus: "DOCS_UNDER_REVIEW",
    });

    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[1]!.eventType).toBe("CASE_STATUS_CHANGED");
    expect(events[1]!.meta["toStatus"]).toBe("DOCS_UNDER_REVIEW");
  });

  it("keeps one case's events out of another's", async () => {
    const context = await buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "rgs", "case_2")).toEqual([]);
  });

  it("keeps one tenant's events out of another's", async () => {
    const context = await buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "other-tenant", "case_1")).toEqual([]);
  });

  it("records an event and returns it", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    const first = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    context.advanceClock(5_000);
    const second = await recordCrmEvent(context, "rgs", "case_1", "CASE_UPDATED", "a@rgs.test");
    context.advanceClock(5_000);
    const third = await recordCrmEvent(context, "rgs", "case_1", "CUSTODY_CHANGED", "b@rgs.test");

    // Late insert of an earlier-timestamped row must still sort first.
    await context.sql.query(
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

  it("breaks created_at ties by eventId", async () => {
    const context = await buildTestContext();
    await context.sql.query(
      `insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
       values ('rgs', 'evt_b', 'case_1', 'CASE_UPDATED', 'a@rgs.test', '{}'::jsonb, '2026-07-23T10:00:00.000Z'),
              ('rgs', 'evt_a', 'case_1', 'CASE_UPDATED', 'a@rgs.test', '{}'::jsonb, '2026-07-23T10:00:00.000Z')`,
    );
    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events.map((event) => event.eventId)).toEqual(["evt_a", "evt_b"]);
  });

  it("keeps millisecond precision and UTC formatting on createdAt", async () => {
    const context = await buildTestContext();
    context.advanceClock(123);
    const recorded = await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    expect(recorded.createdAt).toBe("2026-07-23T10:00:00.123Z");
    const [listed] = await listCaseEvents(context, "rgs", "case_1");
    expect(listed?.createdAt).toBe("2026-07-23T10:00:00.123Z");
  });

  it("scopes events by tenant and case", async () => {
    const context = await buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    await recordCrmEvent(context, "rgs", "case_2", "CASE_CREATED", "a@rgs.test");
    await recordCrmEvent(context, "other", "case_1", "CASE_CREATED", "a@rgs.test");

    expect(await listCaseEvents(context, "rgs", "case_1")).toHaveLength(1);
    expect(await listCaseEvents(context, "rgs", "case_2")).toHaveLength(1);
    expect(await listCaseEvents(context, "other", "case_1")).toHaveLength(1);
    expect(await listCaseEvents(context, "rgs", "nope")).toEqual([]);
  });

  it("round-trips empty and nested-free meta", async () => {
    const context = await buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "a@rgs.test");
    const [listed] = await listCaseEvents(context, "rgs", "case_1");
    expect(listed?.meta).toEqual({});
  });
});
