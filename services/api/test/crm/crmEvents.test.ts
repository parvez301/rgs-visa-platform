import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { listCaseEvents, recordCrmEvent } from "../../src/domain/crm/crmEvents";

describe("crm events", () => {
  it("records an event under the case partition", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    context.advanceClock(60_000);
    await recordCrmEvent(context, "rgs", "case_1", "CASE_STATUS_CHANGED", "ops@rgs.test", {
      fromStatus: "NEW",
      toStatus: "IN_PROGRESS",
    });

    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[1]!.eventType).toBe("CASE_STATUS_CHANGED");
    expect(events[1]!.meta["toStatus"]).toBe("IN_PROGRESS");
  });

  it("keeps one case's events out of another's", async () => {
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "rgs", "case_2")).toEqual([]);
  });

  it("keeps one tenant's events out of another's", async () => {
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "other-tenant", "case_1")).toEqual([]);
  });
});
