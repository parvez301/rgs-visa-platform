import { afterEach, describe, expect, it, vi } from "vitest";
import { CorruptRecordError } from "../../src/lib/errors";
import type { SqlClient } from "../../src/lib/sql";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";
import {
  getReviewItemOrThrow,
  listReviewItems,
  recordReviewItem,
  resolveReviewItem,
  summariseOpenReviewItems,
} from "../../src/domain/crm/reviewQueue";

afterEach(closeSqlTestContexts);

const baseInput = {
  reason: "UNMAPPED_STATUS" as const,
  sourceSheet: "Mini CRM",
  sourceRow: 42,
  caseRef: "31376",
  fieldName: "Status",
  rawValue: "DEU/DEL/190126/",
};

/**
 * Inserts a review-item row that no longer satisfies ReviewItemSchema -- the
 * shape a half-written import pass leaves behind. `case_ref` is blank here,
 * and the schema requires it non-empty, so the row parses no better than the
 * partner rows that used to 500 the whole partner list.
 */
async function seedUnparseableReviewItem(
  context: SqlTestContext,
  tenantId: string,
  reviewItemId = "rev_half_written",
): Promise<string> {
  await context.sql.query(
    `insert into crm_review_items
       (tenant_id, review_item_id, reason, review_status, source_sheet, source_row,
        case_ref, field_name, raw_value, created_at)
     values ($1, $2, 'UNMAPPED_STATUS', 'OPEN', 'Mini CRM', 42, '', 'Status',
             'DEU/DEL/190126/', $3::timestamptz)`,
    [tenantId, reviewItemId, "2026-07-23T10:00:00.000Z"],
  );
  return reviewItemId;
}

async function countReviewRows(context: SqlTestContext): Promise<number> {
  const result = await context.sql.query<{ value: number }>(
    "select count(*)::int as value from crm_review_items",
  );
  return result.rows[0]!.value;
}

describe("crm review queue", () => {
  it("records an item as OPEN and reads it back", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect(created.reviewStatus).toBe("OPEN");
    expect(created.rawValue).toBe("DEU/DEL/190126/");
    expect(created.sourceRow).toBe(42);
    expect(created.reason).toBe("UNMAPPED_STATUS");
    expect(created.sourceSheet).toBe("Mini CRM");
    expect(created.caseRef).toBe("31376");
    expect(created.fieldName).toBe("Status");
    // The clock is injected, so the stamp is the test clock's, not the wall's.
    expect(created.createdAt).toBe("2026-07-23T10:00:00.000Z");

    const loaded = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(loaded).toEqual(created);
  });

  it("stores exactly one row per item and hands back the domain object unchanged", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect(await countReviewRows(context)).toBe(1);
    // No storage columns leak into the object, before or after the round trip.
    expect(Object.keys(created).sort()).toEqual(
      [
        "caseRef",
        "createdAt",
        "fieldName",
        "rawValue",
        "reason",
        "reviewItemId",
        "reviewStatus",
        "sourceRow",
        "sourceSheet",
        "tenantId",
      ].sort(),
    );
    expect(await getReviewItemOrThrow(context, "rgs", created.reviewItemId)).toEqual(created);
  });

  it("carries the optional fields through when they are supplied", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", {
      ...baseInput,
      proposedValue: "DOCS_UNDER_REVIEW",
      confidence: 0.82,
      detail: "Two statuses matched the cell equally well",
    });
    expect(created.proposedValue).toBe("DOCS_UNDER_REVIEW");
    expect(created.confidence).toBe(0.82);
    expect(created.detail).toBe("Two statuses matched the cell equally well");

    const loaded = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(loaded.proposedValue).toBe("DOCS_UNDER_REVIEW");
    expect(loaded.confidence).toBe(0.82);
    expect(loaded.detail).toBe("Two statuses matched the cell equally well");
  });

  it("omits the optional fields entirely rather than storing them undefined", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    // `proposedValue: undefined` is not the same as no proposal: the review
    // screen renders an empty suggestion box for a key that merely exists, and
    // a NULL column must not come back as a null-valued key.
    const loaded = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    for (const optionalKey of ["proposedValue", "confidence", "detail", "resolvedValue"]) {
      expect(optionalKey in loaded).toBe(false);
    }
    expect("proposedValue" in created).toBe(false);
    expect("confidence" in created).toBe(false);
    expect("detail" in created).toBe(false);
    expect("resolvedValue" in created).toBe(false);
    expect("resolvedBy" in created).toBe(false);
    expect("resolvedAt" in created).toBe(false);
  });

  it("lists only the requested status", async () => {
    const context = await buildSqlTestContext();
    const first = await recordReviewItem(context, "rgs", baseInput);
    await recordReviewItem(context, "rgs", { ...baseInput, sourceRow: 43 });
    await resolveReviewItem(
      context,
      "rgs",
      first.reviewItemId,
      { reviewStatus: "DISMISSED" },
      "ops@rgs.test",
    );

    const open = await listReviewItems(context, "rgs", "OPEN");
    const dismissed = await listReviewItems(context, "rgs", "DISMISSED");
    expect(open.reviewItems.map((reviewItem) => reviewItem.sourceRow)).toEqual([43]);
    expect(dismissed.reviewItems.map((reviewItem) => reviewItem.sourceRow)).toEqual([42]);
    expect(open.unreadableReviewItemIds).toEqual([]);
    expect(dismissed.unreadableReviewItemIds).toEqual([]);
  });

  it("moves an item out of the OPEN queue when it is resolved, in place", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect((await listReviewItems(context, "rgs", "OPEN")).reviewItems).toHaveLength(1);

    await resolveReviewItem(
      context,
      "rgs",
      created.reviewItemId,
      { reviewStatus: "APPLIED", resolvedValue: "DOCS_UNDER_REVIEW" },
      "ops@rgs.test",
    );

    // The status has to move with the item, or the review screen never empties;
    // resolving rewrites the one row rather than adding a second.
    expect(await countReviewRows(context)).toBe(1);
    expect((await listReviewItems(context, "rgs", "OPEN")).reviewItems).toHaveLength(0);
    expect((await listReviewItems(context, "rgs", "APPLIED")).reviewItems).toHaveLength(1);
    const resolved = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(resolved.reviewStatus).toBe("APPLIED");
    expect(resolved.resolvedValue).toBe("DOCS_UNDER_REVIEW");
    expect(resolved.resolvedBy).toBe("ops@rgs.test");
    expect(resolved.resolvedAt).toBe("2026-07-23T10:00:00.000Z");
  });

  it("stamps the resolution with the clock at resolution time, not creation time", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    context.advanceClock(90 * 60 * 1000);

    const resolved = await resolveReviewItem(
      context,
      "rgs",
      created.reviewItemId,
      { reviewStatus: "APPLIED" },
      "ops@rgs.test",
    );
    expect(resolved.resolvedAt).toBe("2026-07-23T11:30:00.000Z");
    // createdAt must survive the resolution: it is what the queue orders by,
    // and rewriting it would reshuffle the whole resolved list.
    expect(resolved.createdAt).toBe("2026-07-23T10:00:00.000Z");
    expect(resolved.reviewItemId).toBe(created.reviewItemId);
  });

  it("refuses to resolve the same item twice with a 409", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    await resolveReviewItem(
      context,
      "rgs",
      created.reviewItemId,
      { reviewStatus: "APPLIED" },
      "ops@rgs.test",
    );

    const secondResolution = resolveReviewItem(
      context,
      "rgs",
      created.reviewItemId,
      { reviewStatus: "DISMISSED" },
      "other@rgs.test",
    );
    // The status code, not merely "it threw": `.rejects.toThrow()` passes for a
    // raw ZodError too, and router.ts turns that into a 500.
    await expect(secondResolution).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });

    // ...and the first resolution stands untouched.
    const stillApplied = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(stillApplied.reviewStatus).toBe("APPLIED");
    expect(stillApplied.resolvedBy).toBe("ops@rgs.test");
  });

  it("throws a 404 for an unknown review item", async () => {
    const context = await buildSqlTestContext();
    await expect(getReviewItemOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  it("throws a 404 when resolving an item that does not exist", async () => {
    const context = await buildSqlTestContext();
    await expect(
      resolveReviewItem(context, "rgs", "nope", { reviewStatus: "APPLIED" }, "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("does not return another tenant's items", async () => {
    const context = await buildSqlTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    expect((await listReviewItems(context, "other", "OPEN")).reviewItems).toHaveLength(0);
  });

  it("does not read another tenant's item by id", async () => {
    const context = await buildSqlTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    await expect(
      getReviewItemOrThrow(context, "other", created.reviewItemId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("caps the listing at the requested limit", async () => {
    const context = await buildSqlTestContext();
    for (const sourceRow of [42, 43, 44, 45]) {
      await recordReviewItem(context, "rgs", { ...baseInput, sourceRow });
    }
    const capped = await listReviewItems(context, "rgs", "OPEN", 2);
    expect(capped.reviewItems).toHaveLength(2);
    expect((await listReviewItems(context, "rgs", "OPEN")).reviewItems).toHaveLength(4);
  });

  // --- Truncation the caller cannot see is the whole bug here. A real import
  // --- parks thousands of items in one OPEN partition and the page caps at
  // --- 200, so an operator who works what they can see has no way to learn
  // --- that the rest exists.
  it("says so when the partition holds more items than the page returned", async () => {
    const context = await buildSqlTestContext();
    for (const sourceRow of [42, 43, 44]) {
      await recordReviewItem(context, "rgs", { ...baseInput, sourceRow });
      // Distinct createdAt values, so the queue's oldest-first order is a
      // property of the data rather than of the tie-break on the id.
      context.advanceClock(1000);
    }

    const truncated = await listReviewItems(context, "rgs", "OPEN", 2);
    expect(truncated.hasMore).toBe(true);
    // The extra row is a probe, not a result: it must not leak into the page.
    expect(truncated.reviewItems.map((reviewItem) => reviewItem.sourceRow)).toEqual([42, 43]);
  });

  // --- N5: this used to be a bare ReviewItemSchema.parse, so a value the
  // --- schema refuses threw an untyped ZodError. router.ts maps only
  // --- ApiError, so it surfaced as a 500 from the API and as an unhandled
  // --- abort from the middle of a 7,156-row import.
  it("refuses an out-of-range confidence with a typed 400 rather than a raw ZodError", async () => {
    const context = await buildSqlTestContext();
    const write = recordReviewItem(context, "rgs", { ...baseInput, confidence: -0.2 });
    await expect(write).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
    // The field has to be named, or the operator is told only that something
    // was invalid about a row they cannot see.
    await expect(write).rejects.toThrow("confidence");
  });

  it("does not claim more when the last item exactly fills the page", async () => {
    const context = await buildSqlTestContext();
    for (const sourceRow of [42, 43]) {
      await recordReviewItem(context, "rgs", { ...baseInput, sourceRow });
    }

    // The off-by-one that matters: a full final page is the end of the queue,
    // and reporting hasMore here sends an operator hunting for rows that do
    // not exist.
    const exactlyFull = await listReviewItems(context, "rgs", "OPEN", 2);
    expect(exactlyFull.reviewItems).toHaveLength(2);
    expect(exactlyFull.hasMore).toBe(false);
  });

  // N4: the tests prove a corrupt row is skipped; nothing proved that anything
  // ELSE still propagates. Replacing the guard with `if (false) throw error`
  // left the whole suite green, and a widened catch would render an
  // infrastructure failure as a queue that is simply empty -- an operator
  // would conclude the migration had nothing left to review.
  it("lets a failure that is not a corrupt row propagate rather than skipping it", async () => {
    const context = await buildSqlTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    // A database failure is not a ZodError, so it must not be mistaken for a
    // corrupt row: a widened catch would render an infrastructure failure as a
    // queue that is simply empty.
    const failingSql: SqlClient = {
      ...context.sql,
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as SqlClient;

    await expect(listReviewItems({ ...context, sql: failingSql }, "rgs", "OPEN")).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });

  // --- A stored review item that will not parse is a 409, never a raw 500. ---
  describe("a stored review item that no longer parses", () => {
    it("surfaces as a typed 409 from the single read, naming the bad field", async () => {
      const context = await buildSqlTestContext();
      const reviewItemId = await seedUnparseableReviewItem(context, "rgs");

      const singleRead = getReviewItemOrThrow(context, "rgs", reviewItemId);
      await expect(singleRead).rejects.toBeInstanceOf(CorruptRecordError);
      // 409 and not 404: the item is on file, it is unreadable. A 404 would
      // tell an operator to re-import a row that is already in the queue.
      await expect(singleRead).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
      // The id and the field are what an operator repairs the row with.
      await expect(singleRead).rejects.toThrow(reviewItemId);
      await expect(singleRead).rejects.toThrow("caseRef");
    });

    it("names a row with an unknown reason, not just a blank field", async () => {
      const context = await buildSqlTestContext();
      await context.sql.query(
        `insert into crm_review_items
           (tenant_id, review_item_id, reason, source_sheet, source_row, case_ref,
            field_name, raw_value, created_at)
         values ('rgs', 'rev_bad_reason', 'NOT_A_REASON', 'Mini CRM', 7, '31376',
                 'Status', 'x', $1::timestamptz)`,
        ["2026-07-23T10:00:00.000Z"],
      );

      const singleRead = getReviewItemOrThrow(context, "rgs", "rev_bad_reason");
      await expect(singleRead).rejects.toMatchObject({ statusCode: 409, code: "CORRUPT_RECORD" });
      await expect(singleRead).rejects.toThrow("reason");
    });
  });

  // --- One corrupt row must not take the whole queue down. ---
  // The identical blast radius already fixed for the case queue and the
  // partner list: one half-written row 500'd the screen for the whole tenant.
  it("still lists the healthy items when one stored row will not parse", async () => {
    const context = await buildSqlTestContext();
    const healthy = await recordReviewItem(context, "rgs", baseInput);
    const corruptReviewItemId = await seedUnparseableReviewItem(context, "rgs");

    const listed = await listReviewItems(context, "rgs", "OPEN");
    // The healthy item is still served — the whole point.
    expect(listed.reviewItems.map((reviewItem) => reviewItem.reviewItemId)).toEqual([
      healthy.reviewItemId,
    ]);
    // ...and the row that was skipped is named, not silently dropped.
    expect(listed.unreadableReviewItemIds).toEqual([corruptReviewItemId]);
  });

  it("warns with the id of the review row it had to skip", async () => {
    const context = await buildSqlTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    const corruptReviewItemId = await seedUnparseableReviewItem(context, "rgs");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warnedText = "";
    try {
      await listReviewItems(context, "rgs", "OPEN");
      // Read the calls before restoring: mockRestore also clears them.
      warnedText = warnSpy.mock.calls.map((warnArguments) => warnArguments.join(" ")).join("\n");
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnedText).toContain(corruptReviewItemId);
    // The failing field is what turns a log line into a repair instruction.
    expect(warnedText).toContain("caseRef");
    expect(warnedText).toContain("rgs");
  });

  it("keeps listing when every row in the tenant is corrupt", async () => {
    const context = await buildSqlTestContext();
    const firstCorruptId = await seedUnparseableReviewItem(context, "rgs", "rev_bad_one");
    const secondCorruptId = await seedUnparseableReviewItem(context, "rgs", "rev_bad_two");

    // Returning early on the first bad row would still satisfy a test that
    // only checked the healthy items survived, so both ids are asserted.
    const listed = await listReviewItems(context, "rgs", "OPEN");
    expect(listed.reviewItems).toEqual([]);
    expect([...listed.unreadableReviewItemIds].sort()).toEqual(
      [firstCorruptId, secondCorruptId].sort(),
    );
  });
});

describe("summariseOpenReviewItems", () => {
  it("groups open items by caseRef, keeping merge candidates apart from field problems", async () => {
    const context = await buildSqlTestContext();
    const unmapped = await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "2026",
      sourceRow: 12,
      caseRef: "RGS-1001",
      fieldName: "Status",
      rawValue: "pend.",
    });
    context.advanceClock(1000);
    const merge = await recordReviewItem(context, "rgs", {
      reason: "DUPLICATE_REF",
      sourceSheet: "2026",
      sourceRow: 13,
      caseRef: "RGS-1001",
      fieldName: "REF NO",
      rawValue: "RGS-1001",
    });
    await recordReviewItem(context, "rgs", {
      reason: "UNPARSEABLE_DATE",
      sourceSheet: "2026",
      sourceRow: 40,
      caseRef: "RGS-1002",
      fieldName: "Received",
      rawValue: "31/02/26",
    });

    const summary = await summariseOpenReviewItems(context, "rgs");

    const firstEntry = summary.entries.find((entry) => entry.caseRef === "RGS-1001");
    expect(firstEntry?.fieldItemIds).toEqual([unmapped.reviewItemId]);
    expect(firstEntry?.mergeItemIds).toEqual([merge.reviewItemId]);
    expect(firstEntry?.openReasons).toEqual(["UNMAPPED_STATUS", "DUPLICATE_REF"]);
    expect(summary.entries.map((entry) => entry.caseRef).sort()).toEqual(["RGS-1001", "RGS-1002"]);
  });

  it("leaves the importer's guesses off the grid: PROPOSED_GROUP, SUSPECT_PHONE and MISSING_REQUIRED_FIELD stay OPEN but draw no marker", async () => {
    const context = await buildSqlTestContext();
    for (const reason of ["PROPOSED_GROUP", "SUSPECT_PHONE", "MISSING_REQUIRED_FIELD"] as const) {
      await recordReviewItem(context, "rgs", {
        reason,
        sourceSheet: "2026",
        sourceRow: 12,
        caseRef: "RGS-2001",
        fieldName: "REF NO",
        rawValue: "RGS-2001",
      });
      // Distinct createdAt values: the summary reads oldest-first.
      context.advanceClock(1000);
    }
    const flagged = await recordReviewItem(context, "rgs", {
      reason: "DUPLICATE_REF",
      sourceSheet: "2026",
      sourceRow: 13,
      caseRef: "RGS-2002",
      fieldName: "REF NO",
      rawValue: "RGS-2002",
    });

    const summary = await summariseOpenReviewItems(context, "rgs");

    const guessedEntry = summary.entries.find((entry) => entry.caseRef === "RGS-2001");
    // Present, so the Ledger can filter on the guesses; empty, so it draws nothing.
    expect(guessedEntry).toEqual({
      caseRef: "RGS-2001",
      openReasons: ["PROPOSED_GROUP", "SUSPECT_PHONE", "MISSING_REQUIRED_FIELD"],
      fieldItemIds: [],
      mergeItemIds: [],
    });
    const flaggedEntry = summary.entries.find((entry) => entry.caseRef === "RGS-2002");
    expect(flaggedEntry?.mergeItemIds).toEqual([flagged.reviewItemId]);
    expect(flaggedEntry?.openReasons).toEqual(["DUPLICATE_REF"]);
    // Still open: hidden from the grid is not the same as resolved.
    const openQueue = await listReviewItems(context, "rgs", "OPEN");
    expect(openQueue.reviewItems).toHaveLength(4);
  });

  it("forgets a resolved item, because a cleaned row must lose its marker", async () => {
    const context = await buildSqlTestContext();
    const item = await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "2026",
      sourceRow: 12,
      caseRef: "RGS-1001",
      fieldName: "Status",
      rawValue: "pend.",
    });
    await resolveReviewItem(context, "rgs", item.reviewItemId, { reviewStatus: "DISMISSED" }, "ops@rgs.test");

    const summary = await summariseOpenReviewItems(context, "rgs");

    expect(summary.entries).toEqual([]);
  });

  it("names an item it could not read rather than dropping it from the count", async () => {
    const context = await buildSqlTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    const corruptReviewItemId = await seedUnparseableReviewItem(context, "rgs", "rev_broken");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const summary = await summariseOpenReviewItems(context, "rgs");

      expect(summary.entries.map((entry) => entry.caseRef)).toEqual(["31376"]);
      expect(summary.unreadableReviewItemIds).toEqual([corruptReviewItemId]);
      expect(warnSpy.mock.calls.map((warnArguments) => warnArguments.join(" ")).join("\n")).toContain(
        "rev_broken",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("names a row whose reason the schema no longer knows, and summarises the rest", async () => {
    const context = await buildSqlTestContext();
    const field = await recordReviewItem(context, "rgs", baseInput);
    context.advanceClock(1000);
    const merge = await recordReviewItem(context, "rgs", {
      ...baseInput,
      sourceRow: 43,
      reason: "DUPLICATE_REF",
    });
    await context.sql.query(
      `insert into crm_review_items
         (tenant_id, review_item_id, reason, source_sheet, source_row, case_ref,
          field_name, raw_value, created_at)
       values ('rgs', 'rev_bad_reason', 'NOT_A_REASON', 'Mini CRM', 7, '31376',
               'Status', 'x', $1::timestamptz)`,
      ["2026-07-23T10:00:00.000Z"],
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const summary = await summariseOpenReviewItems(context, "rgs");

      expect(summary.unreadableReviewItemIds).toEqual(["rev_bad_reason"]);
      expect(summary.entries).toHaveLength(1);
      const [entry] = summary.entries;
      expect([...entry!.openReasons].sort()).toEqual(["DUPLICATE_REF", "UNMAPPED_STATUS"]);
      expect(entry!.fieldItemIds).toEqual([field.reviewItemId]);
      expect(entry!.mergeItemIds).toEqual([merge.reviewItemId]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps tenants apart", async () => {
    const context = await buildSqlTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    expect((await summariseOpenReviewItems(context, "other")).entries).toEqual([]);
  });
});
