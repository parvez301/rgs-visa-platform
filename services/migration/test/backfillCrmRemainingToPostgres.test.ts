import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProposal } from "@rgs/api/src/agent/approval";
import { readUserPrefs, setUserPrefs } from "@rgs/api/src/agent/prefs";
import { readCaseRefReservation, reserveCaseRef, completeCaseRefReservation } from "@rgs/api/src/domain/crm/caseRefIndex";
import {
  CRM_USER_PREFS_SORT_KEY,
  META_SORT_KEY,
  PROPOSAL_SORT_KEY,
  crmUserPrefsPartitionKey,
  memoryPartitionKey,
  partnerListGsi1Pk,
  partnerPartitionKey,
  proposalPartitionKey,
  proposalStatusGsi1Pk,
  reviewItemPartitionKey,
  reviewQueueGsi1Pk,
  statusEmailTemplatePartitionKey,
} from "@rgs/api/src/domain/crm/keys";
import { memoryScope, recallMemories, rememberMemory } from "@rgs/api/src/domain/crm/memory";
import { createPartner } from "@rgs/api/src/domain/crm/partners";
import { getReviewItemOrThrow, listReviewItems, recordReviewItem } from "@rgs/api/src/domain/crm/reviewQueue";
import { getStatusEmailTemplate, upsertStatusEmailTemplate } from "@rgs/api/src/domain/crm/statusEmailTemplates";
import type { AppContext } from "@rgs/api/src/lib/context";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { buildTestContext, type TestContext } from "@rgs/api/test/helpers";
import { pgliteAsSqlClient } from "@rgs/api/test/pgliteSqlClient";
import { backfillCrmRemainingToPostgres } from "../src/backfillCrmRemainingToPostgres";

const STAFF = "staff@rgs.example";

async function countRows(sql: SqlClient, tableName: string): Promise<number> {
  const result = await sql.query<{ count: string }>(`select count(*)::text as count from ${tableName}`);
  return Number(result.rows[0]?.count);
}

function postgresViewOf(context: AppContext, sql: SqlClient): AppContext {
  return { ...context, crmStore: "postgres", sql };
}

function proposalItem(proposalId: string, status: "PENDING" | "APPROVED" | "DISCARDED", extra = {}) {
  return {
    PK: proposalPartitionKey("rgs", proposalId),
    SK: PROPOSAL_SORT_KEY,
    GSI1PK: proposalStatusGsi1Pk("rgs", status),
    GSI1SK: "2026-07-23T10:00:00.000Z",
    proposalId,
    toolName: "set_billing",
    input: { caseId: "case_1", nested: { a: [1, 2] } },
    summary: [{ field: "billingStatus", from: "UNBILLED", to: "BILL_SENT" }],
    caseId: "case_1",
    proposedBy: STAFF,
    proposedAt: "2026-07-23T10:00:00.000Z",
    status,
    ...extra,
  };
}

/** Seeds one of every domain, with a partner so PARTNER# memory scope exists. */
async function seedEverything(context: TestContext): Promise<{ partnerId: string }> {
  const partner = await createPartner(
    context,
    "rgs",
    { canonicalName: "Acme Travel", partnerType: "AGENCY" } as never,
    STAFF,
  );
  await reserveCaseRef(context, "rgs", "RGS-1", "case_1").then((reservation) =>
    completeCaseRefReservation(context, "rgs", reservation),
  );
  await reserveCaseRef(context, "rgs", "RGS-2", "case_2"); // died before completion
  await recordReviewItem(context, "rgs", {
    reason: "UNPARSEABLE_DATE",
    sourceSheet: "Sheet1",
    sourceRow: 4,
    caseRef: "RGS-1",
    fieldName: "receivedDate",
    rawValue: "??",
    detail: "bad date",
  } as never);
  context.advanceClock(1000); // distinct createdAt, so queue order is the same in both stores
  // RGS-2's import died before its case was written; a review item is what names the ref.
  await recordReviewItem(context, "rgs", {
    reason: "UNPARSEABLE_DATE",
    sourceSheet: "Sheet1",
    sourceRow: 5,
    caseRef: "RGS-2",
    fieldName: "receivedDate",
    rawValue: "??",
  } as never);
  await context.table.put(proposalItem("prop_pending", "PENDING"));
  await context.table.put(
    proposalItem("prop_done", "APPROVED", { decidedBy: "admin@rgs.example", decidedAt: "2026-07-23T11:00:00.000Z" }),
  );
  await rememberMemory(context, "rgs", { scope: "ORG", memoryKey: "tone", text: "Be polite" }, "human", STAFF);
  // Agent-authored (provenance: sourceCaseId) rows are put raw -- rememberMemory wants the case to exist.
  const partnerScope = memoryScope("PARTNER", partner.partnerId);
  await context.table.put({
    PK: memoryPartitionKey("rgs", partnerScope),
    SK: "terms",
    tenantId: "rgs",
    scope: partnerScope,
    memoryKey: "terms",
    text: "30 days",
    sourceCaseId: "case_1",
    createdBy: "agent",
    createdAt: "2026-07-23T10:00:00.000Z",
    createdByEmail: STAFF,
  });
  await rememberMemory(
    context,
    "rgs",
    { scope: memoryScope("USER", STAFF), memoryKey: "style", text: "Short replies" },
    "human",
    STAFF,
  );
  await setUserPrefs(context, "rgs", STAFF, { trustLevel: 1, defaultFilters: { caseStatus: "NEW" } } as never);
  await upsertStatusEmailTemplate(
    context,
    "rgs",
    "NEW",
    { subject: "Hello", body: "Edited by desk", enabled: false } as never,
    STAFF,
  );
  return { partnerId: partner.partnerId };
}

describe("backfillCrmRemainingToPostgres", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    context = buildTestContext();
  });

  it("applies the migrations itself, including 004, before copying anything", async () => {
    await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const migrations = await sql.query<{ filename: string }>(`select filename from schema_migrations`);
    expect(migrations.rows.map((row) => row.filename)).toContain("004_crm_remaining_sor.sql");
  });

  it("copies every domain so a Postgres read returns what Dynamo returns", async () => {
    const { partnerId } = await seedEverything(context);

    const result = await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.reservationsUpserted).toBe(2);
    expect(result.reviewItemsUpserted).toBe(2);
    expect(result.proposalsUpserted).toBe(2);
    expect(result.memoriesUpserted).toBe(3);
    expect(result.prefsUpserted).toBe(1);
    expect(result.templatesUpserted).toBe(crm.CASE_STATUSES.length);
    expect(result.unreadableReservationIds).toEqual([]);
    expect(result.unreadableReviewItemIds).toEqual([]);
    expect(result.unreadableProposalIds).toEqual([]);
    expect(result.unreadableMemoryKeys).toEqual([]);
    expect(result.unreadablePrefsEmails).toEqual([]);
    expect(result.unreadableTemplateStatuses).toEqual([]);

    const postgres = postgresViewOf(context, sql);
    for (const caseRef of ["RGS-1", "RGS-2"]) {
      expect(await readCaseRefReservation(postgres, "rgs", caseRef)).toEqual(
        await readCaseRefReservation(context, "rgs", caseRef),
      );
    }
    expect((await readCaseRefReservation(postgres, "rgs", "RGS-2"))?.completedAt).toBeUndefined();

    for (const status of crm.REVIEW_STATUSES) {
      expect(await listReviewItems(postgres, "rgs", status)).toEqual(await listReviewItems(context, "rgs", status));
    }
    for (const proposalId of ["prop_pending", "prop_done"]) {
      expect(await getProposal(postgres, "rgs", proposalId)).toEqual(await getProposal(context, "rgs", proposalId));
    }
    const scopes = ["ORG", memoryScope("PARTNER", partnerId), memoryScope("USER", STAFF)];
    expect(await recallMemories(postgres, "rgs", scopes)).toEqual(await recallMemories(context, "rgs", scopes));
    expect(await readUserPrefs(postgres, "rgs", STAFF)).toEqual(await readUserPrefs(context, "rgs", STAFF));
    expect(await getStatusEmailTemplate(postgres, "rgs", "NEW")).toEqual(
      await getStatusEmailTemplate(context, "rgs", "NEW"),
    );
    expect((await getStatusEmailTemplate(postgres, "rgs", "NEW"))?.enabled).toBe(false);
  });

  it("is idempotent: a second run changes no row counts", async () => {
    await seedEverything(context);
    const tables = [
      "crm_case_ref_reservations",
      "crm_review_items",
      "crm_proposals",
      "crm_memories",
      "crm_user_prefs",
      "crm_status_email_templates",
    ];
    const snapshot = async () => Promise.all(tables.map((tableName) => countRows(sql, tableName)));

    const first = await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });
    const afterFirst = await snapshot();
    const second = await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(afterFirst).toEqual([2, 2, 2, 3, 1, crm.CASE_STATUSES.length]);
    expect(await snapshot()).toEqual(afterFirst);
    expect(second).toEqual(first);
  });

  it("re-run restores a drifted row", async () => {
    await seedEverything(context);
    await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });
    await sql.query(`update crm_memories set text = 'STALE'`);
    await sql.query(`update crm_user_prefs set trust_level = 2`);

    await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const postgres = postgresViewOf(context, sql);
    expect((await readUserPrefs(postgres, "rgs", STAFF)).trustLevel).toBe(1);
    const memories = await recallMemories(postgres, "rgs", ["ORG"]);
    expect(memories.memories[0]?.text).toBe("Be polite");
  });

  it("copies a resolved review item and keeps its resolution", async () => {
    const item = await recordReviewItem(context, "rgs", {
      reason: "UNPARSEABLE_DATE",
      sourceSheet: "S",
      sourceRow: 1,
      caseRef: "RGS-9",
      fieldName: "receivedDate",
      rawValue: "x",
    } as never);
    await context.table.put({
      PK: reviewItemPartitionKey("rgs", item.reviewItemId),
      SK: META_SORT_KEY,
      GSI1PK: reviewQueueGsi1Pk("rgs", "APPLIED"),
      GSI1SK: item.createdAt,
      ...item,
      reviewStatus: "APPLIED",
      resolvedValue: "2026-01-01",
      resolvedBy: STAFF,
      resolvedAt: "2026-02-01T00:00:00.000Z",
    });

    await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const copied = await getReviewItemOrThrow(postgresViewOf(context, sql), "rgs", item.reviewItemId);
    expect(copied).toMatchObject({ reviewStatus: "APPLIED", resolvedBy: STAFF, resolvedValue: "2026-01-01" });
  });

  describe("unreadable records", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("names each corrupt record per domain, skips it, and copies the rest", async () => {
      const { partnerId } = await seedEverything(context);
      await context.table.put({
        PK: reviewItemPartitionKey("rgs", "rev_bad"),
        SK: META_SORT_KEY,
        GSI1PK: reviewQueueGsi1Pk("rgs", "OPEN"),
        GSI1SK: "2026-01-01T00:00:00.000Z",
        tenantId: "rgs",
        reviewItemId: "rev_bad",
      });
      await context.table.put({
        PK: proposalPartitionKey("rgs", "prop_bad"),
        SK: PROPOSAL_SORT_KEY,
        GSI1PK: proposalStatusGsi1Pk("rgs", "PENDING"),
        GSI1SK: "2026-01-01T00:00:00.000Z",
        proposalId: "prop_bad",
      });
      await context.table.put({
        PK: memoryPartitionKey("rgs", "ORG"),
        SK: "broken",
        tenantId: "rgs",
        scope: "ORG",
        memoryKey: "broken",
      });
      await context.table.put({
        PK: crmUserPrefsPartitionKey("rgs", "bad@rgs.example"),
        SK: CRM_USER_PREFS_SORT_KEY,
        tenantId: "rgs",
        email: "bad@rgs.example",
        trustLevel: 99,
      });
      await context.table.put({
        PK: statusEmailTemplatePartitionKey("rgs", "CLOSED"),
        SK: META_SORT_KEY,
        tenantId: "rgs",
        caseStatus: "CLOSED",
      });
      await context.table.put({
        PK: partnerPartitionKey("rgs", "p_unused"),
        SK: META_SORT_KEY,
        GSI1PK: partnerListGsi1Pk("rgs"),
        GSI1SK: "x",
        partnerId: "p_unused",
      });
      expect(partnerId).toBeTruthy();

      const result = await backfillCrmRemainingToPostgres({
        table: context.table,
        sql,
        tenantId: "rgs",
        extraEmails: ["bad@rgs.example"],
      });

      expect(result.unreadableReviewItemIds).toEqual(["rev_bad"]);
      expect(result.unreadableProposalIds).toEqual(["prop_bad"]);
      expect(result.unreadableMemoryKeys).toEqual(["broken"]);
      expect(result.unreadablePrefsEmails).toEqual(["bad@rgs.example"]);
      expect(result.unreadableTemplateStatuses).toEqual(["CLOSED"]);
      expect(result.reviewItemsUpserted).toBe(2);
      expect(result.proposalsUpserted).toBe(2);
      expect(result.memoriesUpserted).toBe(3);
      expect(result.prefsUpserted).toBe(1);
      expect(result.templatesUpserted).toBe(crm.CASE_STATUSES.length - 1);
      expect(await countRows(sql, "crm_review_items")).toBe(2);
      warn.mockRestore();
    });

    it("names a reservation item that will not parse, by caseRef", async () => {
      await context.table.put({
        PK: `TENANT#rgs#CASE_REF#RGS-BAD`,
        SK: META_SORT_KEY,
        tenantId: "rgs",
        caseRef: "RGS-BAD",
      });
      await recordReviewItem(context, "rgs", {
        reason: "UNPARSEABLE_DATE",
        sourceSheet: "S",
        sourceRow: 1,
        caseRef: "RGS-BAD",
        fieldName: "receivedDate",
        rawValue: "x",
      } as never);

      const result = await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

      expect(result.unreadableReservationIds).toEqual(["RGS-BAD"]);
      expect(result.reservationsUpserted).toBe(0);
      warn.mockRestore();
    });

    it("names a record Postgres rejects instead of aborting the run", async () => {
      await context.table.put(proposalItem("prop_ok", "PENDING"));
      await recordReviewItem(context, "rgs", {
        reason: "UNPARSEABLE_DATE",
        sourceSheet: "S",
        sourceRow: 2_147_483_648, // overflows the integer column
        caseRef: "RGS-1",
        fieldName: "receivedDate",
        rawValue: "x",
      } as never);

      const result = await backfillCrmRemainingToPostgres({ table: context.table, sql, tenantId: "rgs" });

      expect(result.unreadableReviewItemIds).toHaveLength(1);
      expect(result.proposalsUpserted).toBe(1);
      warn.mockRestore();
    });
  });

  it("reports progress per domain", async () => {
    await seedEverything(context);
    const labels: string[] = [];

    await backfillCrmRemainingToPostgres({
      table: context.table,
      sql,
      tenantId: "rgs",
      onProgress: (label) => labels.push(label),
    });

    expect(new Set(labels)).toEqual(
      new Set(["reservations", "reviewItems", "proposals", "memories", "prefs", "templates"]),
    );
  });
});
