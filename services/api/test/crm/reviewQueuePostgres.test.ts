import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import {
  REVIEW_ITEM_SORT_KEY,
  reviewItemPartitionKey,
  reviewQueueGsi1Pk,
} from "../../src/domain/crm/keys";
import {
  getReviewItemOrThrow,
  listReviewItems,
  recordReviewItem,
  resolveReviewItem,
  summariseOpenReviewItems,
} from "../../src/domain/crm/reviewQueue";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT_ID = "rgs";
const NOW_ISO = "2026-07-23T10:00:00.000Z";

const baseInput = {
  reason: "UNMAPPED_STATUS" as const,
  sourceSheet: "Mini CRM",
  sourceRow: 42,
  caseRef: "31376",
  fieldName: "Status",
  rawValue: "DEU/DEL/190126/",
};

describe("CRM review queue with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext({ seedStatusEmailTemplates: false });
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  async function dynamoReviewRowCount(reviewItemId: string): Promise<number> {
    const byKey = await baseContext.table.get(
      reviewItemPartitionKey(TENANT_ID, reviewItemId),
      REVIEW_ITEM_SORT_KEY,
    );
    const inQueue = await baseContext.table.queryGsi(
      "GSI1",
      reviewQueueGsi1Pk(TENANT_ID, "OPEN"),
      {},
    );
    return (byKey === undefined ? 0 : 1) + inQueue.length;
  }

  it("records an OPEN item in Postgres, round-trips it, and leaves Dynamo empty", async () => {
    const created = await recordReviewItem(context, TENANT_ID, {
      ...baseInput,
      proposedValue: "DOCS_UNDER_REVIEW",
      confidence: 0.82,
      detail: "Two statuses matched equally",
    });
    expect(created.reviewStatus).toBe("OPEN");
    expect(created.createdAt).toBe(NOW_ISO);

    expect(await scalar<number>("select count(*)::int as value from crm_review_items")).toBe(1);
    expect(await dynamoReviewRowCount(created.reviewItemId)).toBe(0);

    expect(await getReviewItemOrThrow(context, TENANT_ID, created.reviewItemId)).toEqual(created);
  });

  it("omits absent optional fields instead of returning nulls", async () => {
    const created = await recordReviewItem(context, TENANT_ID, baseInput);
    const loaded = await getReviewItemOrThrow(context, TENANT_ID, created.reviewItemId);
    expect(loaded).toEqual(created);
    for (const optionalKey of [
      "proposedValue",
      "confidence",
      "detail",
      "resolvedValue",
      "resolvedBy",
      "resolvedAt",
    ]) {
      expect(optionalKey in loaded).toBe(false);
    }
  });

  it("answers 404 for an item that is not in Postgres, and keeps tenants apart", async () => {
    const created = await recordReviewItem(context, TENANT_ID, baseInput);
    await expect(getReviewItemOrThrow(context, TENANT_ID, "rev_missing")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      getReviewItemOrThrow(context, "other-tenant", created.reviewItemId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists by status, oldest first", async () => {
    const first = await recordReviewItem(context, TENANT_ID, baseInput);
    await recordReviewItem(context, TENANT_ID, { ...baseInput, sourceRow: 43 });
    await resolveReviewItem(
      context,
      TENANT_ID,
      first.reviewItemId,
      { reviewStatus: "DISMISSED" },
      "ops@rgs.test",
    );

    const open = await listReviewItems(context, TENANT_ID, "OPEN");
    const dismissed = await listReviewItems(context, TENANT_ID, "DISMISSED");
    expect(open.reviewItems.map((reviewItem) => reviewItem.sourceRow)).toEqual([43]);
    expect(dismissed.reviewItems.map((reviewItem) => reviewItem.sourceRow)).toEqual([42]);
    expect(open.unreadableReviewItemIds).toEqual([]);
    expect(open.hasMore).toBe(false);
  });

  it("resolves in place: one row, status moved, second resolution is a 409", async () => {
    const created = await recordReviewItem(context, TENANT_ID, baseInput);
    const resolved = await resolveReviewItem(
      context,
      TENANT_ID,
      created.reviewItemId,
      { reviewStatus: "APPLIED", resolvedValue: "DOCS_UNDER_REVIEW" },
      "ops@rgs.test",
    );
    expect(resolved).toMatchObject({
      reviewStatus: "APPLIED",
      resolvedValue: "DOCS_UNDER_REVIEW",
      resolvedBy: "ops@rgs.test",
      resolvedAt: NOW_ISO,
      createdAt: created.createdAt,
    });

    expect(await scalar<number>("select count(*)::int as value from crm_review_items")).toBe(1);
    expect(await getReviewItemOrThrow(context, TENANT_ID, created.reviewItemId)).toEqual(resolved);
    expect((await listReviewItems(context, TENANT_ID, "OPEN")).reviewItems).toEqual([]);
    expect((await listReviewItems(context, TENANT_ID, "APPLIED")).reviewItems).toEqual([resolved]);

    await expect(
      resolveReviewItem(
        context,
        TENANT_ID,
        created.reviewItemId,
        { reviewStatus: "DISMISSED" },
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("caps a page at the limit and says there is more", async () => {
    for (let sourceRow = 1; sourceRow <= 3; sourceRow += 1) {
      await recordReviewItem(context, TENANT_ID, { ...baseInput, sourceRow });
    }

    const page = await listReviewItems(context, TENANT_ID, "OPEN", 2);
    expect(page.reviewItems).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const exact = await listReviewItems(context, TENANT_ID, "OPEN", 3);
    expect(exact.reviewItems).toHaveLength(3);
    expect(exact.hasMore).toBe(false);
  });

  it("names a row that no longer parses and still lists the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await recordReviewItem(context, TENANT_ID, baseInput);
      await sql.query(
        `insert into crm_review_items
           (tenant_id, review_item_id, reason, source_sheet, source_row, case_ref,
            field_name, raw_value, created_at)
         values ($1, 'rev_half_written', 'NOT_A_REASON', 'Mini CRM', 7, '31376',
                 'Status', 'x', $2::timestamptz)`,
        [TENANT_ID, NOW_ISO],
      );

      const listing = await listReviewItems(context, TENANT_ID, "OPEN");
      expect(listing.reviewItems).toHaveLength(1);
      expect(listing.unreadableReviewItemIds).toEqual(["rev_half_written"]);

      await expect(
        getReviewItemOrThrow(context, TENANT_ID, "rev_half_written"),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      warn.mockRestore();
    }
  });

  it("summarises open items from Postgres and names unreadable ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const field = await recordReviewItem(context, TENANT_ID, baseInput);
      const merge = await recordReviewItem(context, TENANT_ID, {
        ...baseInput,
        sourceRow: 43,
        reason: "DUPLICATE_REF",
      });
      const guess = await recordReviewItem(context, TENANT_ID, {
        ...baseInput,
        sourceRow: 44,
        reason: "SUSPECT_PHONE",
      });
      const closed = await recordReviewItem(context, TENANT_ID, {
        ...baseInput,
        sourceRow: 45,
        caseRef: "99999",
      });
      await resolveReviewItem(
        context,
        TENANT_ID,
        closed.reviewItemId,
        { reviewStatus: "DISMISSED" },
        "ops@rgs.test",
      );
      await sql.query(
        `insert into crm_review_items
           (tenant_id, review_item_id, reason, source_sheet, source_row, case_ref,
            field_name, raw_value, created_at)
         values ($1, 'rev_bad_reason', 'NOT_A_REASON', 'Mini CRM', 7, '31376',
                 'Status', 'x', $2::timestamptz)`,
        [TENANT_ID, NOW_ISO],
      );

      const summary = await summariseOpenReviewItems(context, TENANT_ID);
      expect(summary.unreadableReviewItemIds).toEqual(["rev_bad_reason"]);
      // Every item shares the injected clock's createdAt, so the order within
      // a case is not asserted -- only what the case carries.
      expect(summary.entries).toHaveLength(1);
      const [entry] = summary.entries;
      expect(entry!.caseRef).toBe("31376");
      expect([...entry!.openReasons].sort()).toEqual(
        ["DUPLICATE_REF", "SUSPECT_PHONE", "UNMAPPED_STATUS"],
      );
      expect(entry!.fieldItemIds).toEqual([field.reviewItemId]);
      expect(entry!.mergeItemIds).toEqual([merge.reviewItemId]);
      expect(guess.reviewItemId).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("still uses the Dynamo table when the context is not postgres", async () => {
    const dynamoContext = buildTestContext();
    const created = await recordReviewItem(dynamoContext, TENANT_ID, baseInput);
    expect(
      await dynamoContext.table.get(
        reviewItemPartitionKey(TENANT_ID, created.reviewItemId),
        REVIEW_ITEM_SORT_KEY,
      ),
    ).toBeDefined();
    expect(await scalar<number>("select count(*)::int as value from crm_review_items")).toBe(0);
  });
});
