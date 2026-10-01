import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { completeCaseRefReservation, reserveCaseRef } from "../../src/domain/crm/caseRefIndex";
import { createCase, getCase } from "../../src/domain/crm/cases";
import {
  REVIEW_ITEM_SORT_KEY,
  reviewItemPartitionKey,
  reviewQueueGsi1Pk,
} from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { listOpenReviewGroups, resolveReviewGroup } from "../../src/domain/crm/reviewGroups";
import { listReviewItems, recordReviewItem } from "../../src/domain/crm/reviewQueue";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";
import { pgliteAsSqlClient } from "../pgliteSqlClient";

const TENANT = "rgs";
const ACTOR = "ops@rgs.test";

describe("review groups with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext({ seedStatusEmailTemplates: false });
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  function seedPartnerItem(caseRef: string, rawValue: string, proposedValue?: string) {
    return recordReviewItem(context, TENANT, {
      reason: "UNMAPPED_PARTNER",
      sourceSheet: "Mini CRM",
      sourceRow: Number(caseRef.slice(-3)) + 1,
      caseRef,
      fieldName: "REFRENCE",
      rawValue,
      ...(proposedValue === undefined ? {} : { proposedValue }),
    });
  }

  async function seedCase(partnerId: string, caseRef: string) {
    const traveller = await upsertTraveller(context, TENANT, { fullName: `Traveller ${caseRef}` });
    const created = await createCase(
      context,
      TENANT,
      {
        caseRef,
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId,
        destinationCountry: "ZZ",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: caseRef, travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    const reservation = await reserveCaseRef(context, TENANT, caseRef, created.caseId);
    await completeCaseRefReservation(context, TENANT, reservation);
    return created;
  }

  async function dynamoOpenReviewRows(): Promise<number> {
    const inQueue = await baseContext.table.queryGsi(
      "GSI1",
      reviewQueueGsi1Pk(TENANT, "OPEN"),
      {},
    );
    return inQueue.length;
  }

  it("groups open items from Postgres, biggest first, with a sample of refs", async () => {
    await seedPartnerItem("38001", "GALAXY");
    await seedPartnerItem("38002", "GALAXY", "partner_galaxy");
    await seedPartnerItem("38003", "Galaxy Travels");

    const listing = await listOpenReviewGroups(context, TENANT);

    expect(listing.unreadableReviewItemIds).toEqual([]);
    expect(listing.groups).toEqual([
      {
        reason: "UNMAPPED_PARTNER",
        fieldName: "REFRENCE",
        rawValue: "GALAXY",
        itemCount: 2,
        proposedValue: "partner_galaxy",
        sampleCaseRefs: ["38001", "38002"],
      },
      {
        reason: "UNMAPPED_PARTNER",
        fieldName: "REFRENCE",
        rawValue: "Galaxy Travels",
        itemCount: 1,
        sampleCaseRefs: ["38003"],
      },
    ]);
    expect(await dynamoOpenReviewRows()).toBe(0);
    expect(
      await baseContext.table.get(
        reviewItemPartitionKey(TENANT, "anything"),
        REVIEW_ITEM_SORT_KEY,
      ),
    ).toBeUndefined();
  });

  it("dismisses in chunks, reports what is left, and ungroups a resolved item", async () => {
    for (let index = 0; index < 5; index += 1) await seedPartnerItem(`3800${index}`, "GALAXY");
    await seedPartnerItem("38999", "OTHER");
    const input = {
      reason: "UNMAPPED_PARTNER" as const,
      fieldName: "REFRENCE",
      rawValue: "GALAXY",
      reviewStatus: "DISMISSED" as const,
    };

    const firstChunk = await resolveReviewGroup(context, TENANT, { ...input, limit: 2 }, ACTOR);
    expect(firstChunk).toEqual({
      matchedCount: 5,
      resolvedCount: 2,
      appliedCount: 0,
      remainingCount: 3,
      failures: [],
    });
    const secondChunk = await resolveReviewGroup(context, TENANT, { ...input, limit: 50 }, ACTOR);
    expect(secondChunk).toMatchObject({ matchedCount: 3, resolvedCount: 3, remainingCount: 0 });

    const groups = (await listOpenReviewGroups(context, TENANT)).groups;
    expect(groups.map((group) => group.rawValue)).toEqual(["OTHER"]);
    expect((await listReviewItems(context, TENANT, "DISMISSED")).reviewItems).toHaveLength(5);
    expect(await dynamoOpenReviewRows()).toBe(0);
  });

  it("applies a partner to the case in Postgres and closes the item", async () => {
    const sentinel = await createPartner(context, TENANT, { canonicalName: "(no referrer recorded)" }, ACTOR);
    const galaxy = await createPartner(context, TENANT, { canonicalName: "Galaxy Travels" }, ACTOR);
    const filedCase = await seedCase(sentinel.partnerId, "38001");
    await seedPartnerItem("38001", "GALAXY");

    const result = await resolveReviewGroup(
      context,
      TENANT,
      {
        reason: "UNMAPPED_PARTNER",
        fieldName: "REFRENCE",
        rawValue: "GALAXY",
        reviewStatus: "APPLIED",
        resolvedValue: galaxy.partnerId,
        limit: 50,
      },
      ACTOR,
    );

    expect(result).toEqual({
      matchedCount: 1,
      resolvedCount: 1,
      appliedCount: 1,
      remainingCount: 0,
      failures: [],
    });
    expect((await getCase(context, TENANT, filedCase.caseId)).partnerId).toBe(galaxy.partnerId);
    expect((await listReviewItems(context, TENANT, "APPLIED")).reviewItems).toHaveLength(1);
  });

  it("names a row the group sweep cannot read, and does not resolve it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seedPartnerItem("38001", "GALAXY");
      await sql.query(
        `insert into crm_review_items
           (tenant_id, review_item_id, reason, source_sheet, source_row, case_ref,
            field_name, raw_value, created_at)
         values ($1, 'rev_bad_reason', 'NOT_A_REASON', 'Mini CRM', 7, '38002',
                 'REFRENCE', 'GALAXY', now())`,
        [TENANT],
      );

      const listing = await listOpenReviewGroups(context, TENANT);
      expect(listing.unreadableReviewItemIds).toEqual(["rev_bad_reason"]);
      expect(listing.groups).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
