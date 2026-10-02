import { PGlite } from "@electric-sql/pglite";
import type { Notice } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createLead, listNewLeads } from "@rgs/api/src/domain/leads";
import { listNewLeadsPostgres } from "@rgs/api/src/domain/leadsPostgres";
import { NOTICE_PARTITION_KEY, noticeSortKey } from "@rgs/api/src/domain/notices";
import { listNoticesPostgres } from "@rgs/api/src/domain/noticesPostgres";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { buildTestContext, type TestContext } from "@rgs/api/test/helpers";
import { pgliteAsSqlClient } from "@rgs/api/test/pgliteSqlClient";
import { backfillLeadsNoticesToPostgres } from "../src/backfillLeadsNoticesToPostgres";

function notice(noticeId: string, createdAt: string, overrides: Partial<Notice> = {}): Notice {
  return {
    noticeId,
    title: `Notice ${noticeId}`,
    body: "Body text",
    category: "GENERAL",
    severity: "INFO",
    pinned: false,
    status: "PUBLISHED",
    publishedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    createdByEmail: "admin@example.com",
    ...overrides,
  } as Notice;
}

async function putNotice(context: TestContext, record: Notice): Promise<void> {
  await context.table.put({
    PK: NOTICE_PARTITION_KEY,
    SK: noticeSortKey(record.createdAt, record.noticeId),
    ...record,
  });
}

describe("backfillLeadsNoticesToPostgres", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(() => {
    sql = pgliteAsSqlClient(new PGlite());
    context = buildTestContext();
  });

  async function seedGood(): Promise<Notice[]> {
    await createLead(context, { fullName: "Asha Rao", phone: "+971500000001", topic: "Visa", message: "Hello" });
    context.advanceClock(1000);
    await createLead(context, { fullName: "Bo Lee", phone: "+971500000002", topic: "Tour", message: "" });
    const notices = [
      notice("notice_1", "2026-01-01T00:00:00.000Z", { countryCode: "AE", expiresAt: "2026-12-31" }),
      notice("notice_2", "2026-02-01T00:00:00.000Z", { status: "DRAFT", publishedAt: undefined, pinned: true }),
    ];
    for (const record of notices) await putNotice(context, record);
    return notices;
  }

  it("copies leads and notices from Dynamo into Postgres", async () => {
    const notices = await seedGood();

    const result = await backfillLeadsNoticesToPostgres({ table: context.table, sql });

    expect(result).toEqual({
      leadsUpserted: 2,
      noticesUpserted: 2,
      unreadableLeadIds: [],
      unreadableNoticeIds: [],
    });
    const migrations = await sql.query<{ filename: string }>(`select filename from schema_migrations`);
    expect(migrations.rows.map((row) => row.filename)).toContain("007_portal_leads_notices.sql");

    const fromDynamo = await listNewLeads(context, 50);
    expect(fromDynamo).toHaveLength(2);
    expect(await listNewLeadsPostgres(sql, 50)).toEqual(fromDynamo);

    const { notices: stored, unreadableNoticeIds } = await listNoticesPostgres(sql);
    expect(unreadableNoticeIds).toEqual([]);
    expect(stored.map((record) => record.noticeId).sort()).toEqual(notices.map((record) => record.noticeId));
    const first = stored.find((record) => record.noticeId === "notice_1")!;
    expect(first).toMatchObject({ countryCode: "AE", expiresAt: "2026-12-31", status: "PUBLISHED" });
  });

  it("is idempotent on a second run", async () => {
    await seedGood();

    const first = await backfillLeadsNoticesToPostgres({ table: context.table, sql });
    const snapshot = async () => ({
      leads: await listNewLeadsPostgres(sql, 50),
      notices: (await listNoticesPostgres(sql)).notices,
    });
    const afterFirst = await snapshot();
    const second = await backfillLeadsNoticesToPostgres({ table: context.table, sql });

    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("names unreadable leads and notices and still copies the rest", async () => {
    await seedGood();
    await context.table.put({
      PK: "LEAD#lead_broken",
      SK: "PROFILE",
      GSI1PK: "STATUS#LEAD_NEW",
      GSI1SK: "2026-01-01T00:00:00.000Z",
      leadId: "lead_broken",
      phone: "+971500000003",
      topic: "Visa",
      message: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await context.table.put({
      PK: NOTICE_PARTITION_KEY,
      SK: noticeSortKey("2026-03-01T00:00:00.000Z", "notice_broken"),
      noticeId: "notice_broken",
      title: 42,
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    const result = await backfillLeadsNoticesToPostgres({ table: context.table, sql });

    expect(result.unreadableLeadIds).toEqual(["lead_broken"]);
    expect(result.unreadableNoticeIds).toEqual(["notice_broken"]);
    expect(result.leadsUpserted).toBe(2);
    expect(result.noticesUpserted).toBe(2);
    expect(await listNewLeadsPostgres(sql, 50)).toHaveLength(2);
    expect((await listNoticesPostgres(sql)).notices).toHaveLength(2);
  });

  it("does not need CRM_STORE=postgres", async () => {
    const previousStore = process.env["CRM_STORE"];
    delete process.env["CRM_STORE"];
    try {
      await seedGood();
      const result = await backfillLeadsNoticesToPostgres({ table: context.table, sql });
      expect(result.leadsUpserted).toBe(2);
    } finally {
      if (previousStore !== undefined) process.env["CRM_STORE"] = previousStore;
    }
  });
});
