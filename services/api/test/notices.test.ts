import { describe, expect, it } from "vitest";
import {
  deleteNotice,
  listNotices,
  listPublicNotices,
  upsertNotice,
} from "../src/domain/notices";
import { buildTestContext } from "./helpers";

const baseNoticeInput = {
  title: "UAE processing update",
  body: "Processing times may extend by 2 business days.",
  category: "RULE_CHANGE" as const,
  severity: "IMPORTANT" as const,
  countryCode: "AE",
};

describe("upsertNotice", () => {
  it("sets createdAt and updatedAt on create", async () => {
    const context = buildTestContext();
    const notice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      status: "DRAFT",
    });
    expect(notice.createdAt).toBe("2026-07-23T10:00:00.000Z");
    expect(notice.updatedAt).toBe("2026-07-23T10:00:00.000Z");
    expect(notice.createdByEmail).toBe("admin@example.com");
    expect(notice.publishedAt).toBeUndefined();
  });

  it("sets publishedAt once and does not move it on later edits", async () => {
    const context = buildTestContext();
    const draftNotice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      status: "DRAFT",
    });
    context.advanceClock(60_000);
    const publishedNotice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      noticeId: draftNotice.noticeId,
      status: "PUBLISHED",
    });
    expect(publishedNotice.publishedAt).toBe("2026-07-23T10:01:00.000Z");
    context.advanceClock(60_000);
    const editedNotice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      noticeId: draftNotice.noticeId,
      title: "UAE processing update (revised)",
      status: "PUBLISHED",
    });
    expect(editedNotice.publishedAt).toBe("2026-07-23T10:01:00.000Z");
    expect(editedNotice.updatedAt).toBe("2026-07-23T10:02:00.000Z");
  });
});

describe("listPublicNotices", () => {
  it("excludes DRAFT/ARCHIVED and expired notices", async () => {
    const context = buildTestContext();
    await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      title: "Draft notice here",
      status: "DRAFT",
    });
    await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      title: "Archived notice here",
      status: "ARCHIVED",
    });
    await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      title: "Expired notice here",
      status: "PUBLISHED",
      expiresAt: "2026-07-01",
    });
    const liveNotice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      title: "Live notice here",
      status: "PUBLISHED",
    });
    const publicNotices = (await listPublicNotices(context)).notices;
    expect(publicNotices.map((notice) => notice.noticeId)).toEqual([liveNotice.noticeId]);
    expect(publicNotices[0]).not.toHaveProperty("status");
    expect(publicNotices[0]).not.toHaveProperty("createdByEmail");
    expect(publicNotices[0]).not.toHaveProperty("updatedAt");
  });

  it("returns country-specific notices plus globals, pinned first", async () => {
    const context = buildTestContext();
    const globalNotice = await upsertNotice(context, "admin@example.com", {
      title: "Global announcement",
      body: "Applies to all destinations.",
      category: "GENERAL",
      severity: "INFO",
      status: "PUBLISHED",
    });
    context.advanceClock(1_000);
    const uaeNotice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      title: "UAE-only notice",
      status: "PUBLISHED",
      pinned: true,
    });
    context.advanceClock(1_000);
    await upsertNotice(context, "admin@example.com", {
      title: "Thailand notice",
      body: "TH only",
      category: "GENERAL",
      severity: "INFO",
      countryCode: "TH",
      status: "PUBLISHED",
    });

    const forUae = (await listPublicNotices(context, { countryCode: "AE" })).notices;
    expect(forUae.map((notice) => notice.noticeId)).toEqual([
      uaeNotice.noticeId,
      globalNotice.noticeId,
    ]);
  });
});

describe("deleteNotice", () => {
  it("removes a notice from the partition", async () => {
    const context = buildTestContext();
    const notice = await upsertNotice(context, "admin@example.com", {
      ...baseNoticeInput,
      status: "DRAFT",
    });
    expect((await listNotices(context)).notices).toHaveLength(1);
    await deleteNotice(context, notice.noticeId);
    expect((await listNotices(context)).notices).toHaveLength(0);
  });
});
