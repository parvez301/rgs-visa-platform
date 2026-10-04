import { NOTICE_CATEGORIES, NOTICE_SEVERITIES, NOTICE_STATUSES } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteNotice,
  listNotices,
  listPublicNotices,
  upsertNotice,
} from "../src/domain/notices";
import { listUserActivityPostgres } from "../src/domain/activityPostgres";
import { getNoticePostgres } from "../src/domain/noticesPostgres";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, closeTestContexts, type TestContext } from "./helpers";

const BASE_INPUT = {
  title: "UAE fee change notice",
  body: "Fees update next week for tourist visas.",
  category: NOTICE_CATEGORIES[1],
  severity: NOTICE_SEVERITIES[0],
};

describe("notices", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
  });

  afterEach(closeTestContexts);

  it("upserts a draft then publishes", async () => {
    const draft = await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      status: NOTICE_STATUSES[0],
    });
    context.advanceClock(60_000);
    const published = await upsertNotice(context, "admin@example.com", {
      noticeId: draft.noticeId,
      title: draft.title,
      body: draft.body,
      category: draft.category,
      severity: draft.severity,
      status: NOTICE_STATUSES[1],
    });
    expect(published.publishedAt).toBeTruthy();
    expect(published.createdAt).toBe(draft.createdAt);
    expect(published.updatedAt).not.toBe(draft.updatedAt);

    const stored = await getNoticePostgres(sql, draft.noticeId);
    expect(stored).toEqual(published);
    const listed = await listNotices(context);
    expect(listed.notices.map((n) => n.noticeId)).toContain(draft.noticeId);
    expect(listed.unreadableNoticeIds).toEqual([]);
  });

  it("logs NOTICE_PUBLISHED when published", async () => {
    const notice = await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      status: "PUBLISHED",
    });
    const { events } = await listUserActivityPostgres(sql, "admin@example.com", 10);
    expect(events.map((e) => e.eventType)).toContain("NOTICE_PUBLISHED");
    expect(events[0]!.meta["noticeId"]).toBe(notice.noticeId);
  });

  it("round-trips optional fields and clears them on update", async () => {
    const created = await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      countryCode: "AE",
      pinned: true,
      expiresAt: "2026-12-31",
    });
    expect((await getNoticePostgres(sql, created.noticeId))!.expiresAt).toBe("2026-12-31");
    const updated = await upsertNotice(context, "other@example.com", {
      noticeId: created.noticeId,
      ...BASE_INPUT,
    });
    const stored = (await getNoticePostgres(sql, created.noticeId))!;
    expect(stored.countryCode).toBeUndefined();
    expect(stored.expiresAt).toBeUndefined();
    expect(stored.pinned).toBe(false);
    expect(stored.createdByEmail).toBe("admin@example.com");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("names an unreadable notice id and still returns readable ones", async () => {
    const good = await upsertNotice(context, "admin@example.com", BASE_INPUT);
    const bad = await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      title: "Will be corrupted",
    });
    await sql.query(`update portal_notices set title = '' where notice_id = $1`, [
      bad.noticeId,
    ]);

    const listed = await listNotices(context);
    expect(listed.notices.map((n) => n.noticeId)).toEqual([good.noticeId]);
    expect(listed.unreadableNoticeIds).toEqual([bad.noticeId]);

    const publicListing = await listPublicNotices(context);
    expect(publicListing.unreadableNoticeIds).toEqual([bad.noticeId]);
  });

  it("listPublicNotices filters unpublished and expired", async () => {
    await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      title: "Draft notice",
      status: "DRAFT",
    });
    await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      title: "Expired notice",
      status: "PUBLISHED",
      expiresAt: "2026-07-01",
    });
    const live = await upsertNotice(context, "admin@example.com", {
      ...BASE_INPUT,
      title: "Live notice",
      status: "PUBLISHED",
      expiresAt: "2026-12-31",
    });

    const publicListing = await listPublicNotices(context);
    expect(publicListing.notices.map((n) => n.noticeId)).toEqual([live.noticeId]);
  });

  it("deleteNotice removes the PG row and 404s on a missing id", async () => {
    const notice = await upsertNotice(context, "admin@example.com", BASE_INPUT);
    await deleteNotice(context, notice.noticeId);
    expect(await getNoticePostgres(sql, notice.noticeId)).toBeUndefined();
    await expect(deleteNotice(context, notice.noticeId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("throws when sql is missing", async () => {
    const { sql: _removed, ...rest } = context;
    void _removed;
    const withoutSql = rest as unknown as AppContext;
    await expect(listNotices(withoutSql)).rejects.toThrow(
      "AppContext.sql is required",
    );
    await expect(upsertNotice(withoutSql, "a@example.com", BASE_INPUT)).rejects.toThrow(
      "AppContext.sql is required",
    );
    await expect(deleteNotice(withoutSql, "ntc_x")).rejects.toThrow(
      "AppContext.sql is required",
    );
  });
});
