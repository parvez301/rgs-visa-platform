import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { completeCaseRefReservation, reserveCaseRef } from "../../src/domain/crm/caseRefIndex";
import { createCase, getCase } from "../../src/domain/crm/cases";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { partnerCasesGsi2Pk } from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { listOpenReviewGroups, resolveReviewGroup } from "../../src/domain/crm/reviewGroups";
import { getReviewItemOrThrow, listReviewItems, recordReviewItem } from "../../src/domain/crm/reviewQueue";
import { upsertTraveller } from "../../src/domain/crm/travellers";

const TENANT = "rgs";
const ACTOR = "ops@rgs.test";

/**
 * Files a case the way the importer does: the case, plus the REF reservation
 * the review screen uses to find it. `createCase` alone writes no
 * reservation, and every review item points at a case the importer wrote.
 */
async function seedCase(context: TestContext, partnerId: string, caseRef: string) {
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

async function seedPartnerItem(context: TestContext, caseRef: string, rawValue: string, proposedValue?: string) {
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

describe("listOpenReviewGroups", () => {
  it("groups open items by exact (reason, column, raw text), biggest group first, with a sample of refs", async () => {
    const context = buildTestContext();
    await seedPartnerItem(context, "38001", "GALAXY");
    await seedPartnerItem(context, "38002", "GALAXY", "partner_galaxy");
    await seedPartnerItem(context, "38003", "Galaxy Travels");
    await recordReviewItem(context, TENANT, {
      reason: "UNMAPPED_COUNTRY",
      sourceSheet: "Mini CRM",
      sourceRow: 4,
      caseRef: "38004",
      fieldName: "Country",
      rawValue: "Dubai",
    });

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
      { reason: "UNMAPPED_COUNTRY", fieldName: "Country", rawValue: "Dubai", itemCount: 1, sampleCaseRefs: ["38004"] },
      {
        reason: "UNMAPPED_PARTNER",
        fieldName: "REFRENCE",
        rawValue: "Galaxy Travels",
        itemCount: 1,
        sampleCaseRefs: ["38003"],
      },
    ]);
  });

  it("does not group a resolved item", async () => {
    const context = buildTestContext();
    await seedPartnerItem(context, "38001", "GALAXY");
    await resolveReviewGroup(
      context,
      TENANT,
      { reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: "GALAXY", reviewStatus: "DISMISSED", limit: 50 },
      ACTOR,
    );
    expect((await listOpenReviewGroups(context, TENANT)).groups).toEqual([]);
  });
});

describe("resolveReviewGroup", () => {
  it("dismisses in chunks and reports what is left, so a 15-second Lambda can work a 300-item group", async () => {
    const context = buildTestContext();
    for (let index = 0; index < 5; index += 1) await seedPartnerItem(context, `3800${index}`, "GALAXY");
    await seedPartnerItem(context, "38999", "OTHER");

    const firstChunk = await resolveReviewGroup(
      context,
      TENANT,
      { reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: "GALAXY", reviewStatus: "DISMISSED", limit: 2 },
      ACTOR,
    );
    expect(firstChunk).toEqual({ matchedCount: 5, resolvedCount: 2, appliedCount: 0, remainingCount: 3, failures: [] });

    const secondChunk = await resolveReviewGroup(
      context,
      TENANT,
      { reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: "GALAXY", reviewStatus: "DISMISSED", limit: 50 },
      ACTOR,
    );
    expect(secondChunk.remainingCount).toBe(0);
    expect(secondChunk.resolvedCount).toBe(3);

    const stillOpen = await listReviewItems(context, TENANT, "OPEN");
    expect(stillOpen.reviewItems.map((item) => item.rawValue)).toEqual(["OTHER"]);
  });

  it("APPLIED on a partner group moves every case to that partner, re-keys the partner index, and closes the items", async () => {
    const context = buildTestContext();
    const sentinel = await createPartner(context, TENANT, { canonicalName: "(no referrer recorded)" }, ACTOR);
    const galaxy = await createPartner(context, TENANT, { canonicalName: "Galaxy Travels" }, ACTOR);
    const firstCase = await seedCase(context, sentinel.partnerId, "38001");
    const secondCase = await seedCase(context, sentinel.partnerId, "38002");
    const firstItem = await seedPartnerItem(context, "38001", "GALAXY");
    await seedPartnerItem(context, "38002", "GALAXY");

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

    expect(result).toEqual({ matchedCount: 2, resolvedCount: 2, appliedCount: 2, remainingCount: 0, failures: [] });
    for (const seeded of [firstCase, secondCase]) {
      const updated = await getCase(context, TENANT, seeded.caseId);
      expect(updated.partnerId).toBe(galaxy.partnerId);
    }
    // The by-partner listing reads GSI2; a partner change that leaves the old
    // key behind would list the case under the sentinel forever.
    const underGalaxy = await context.table.queryGsi("GSI2", partnerCasesGsi2Pk(TENANT, galaxy.partnerId), {});
    expect(underGalaxy.map((item) => item["caseId"]).sort()).toEqual([firstCase.caseId, secondCase.caseId].sort());
    const underSentinel = await context.table.queryGsi("GSI2", partnerCasesGsi2Pk(TENANT, sentinel.partnerId), {});
    expect(underSentinel).toEqual([]);

    const closedItem = await getReviewItemOrThrow(context, TENANT, firstItem.reviewItemId);
    expect(closedItem.reviewStatus).toBe("APPLIED");
    expect(closedItem.resolvedValue).toBe(galaxy.partnerId);
    expect(closedItem.resolvedBy).toBe(ACTOR);

    const events = await listCaseEvents(context, TENANT, firstCase.caseId);
    const correction = events.find((event) => event.meta["source"] === "import review");
    expect(correction?.eventType).toBe("CASE_UPDATED");
    expect(correction?.meta["changedFields"]).toBe("partnerId");
    expect(correction?.meta["sheetSaid"]).toBe("GALAXY");
  });

  it("writes an unparseable date into the case field its workbook column maps to", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT, { canonicalName: "Galaxy Travels" }, ACTOR);
    const seeded = await seedCase(context, partner.partnerId, "38001");
    await recordReviewItem(context, TENANT, {
      reason: "UNPARSEABLE_DATE",
      sourceSheet: "Mini CRM",
      sourceRow: 1,
      caseRef: "38001",
      fieldName: "Sub Date",
      rawValue: "12-13-26",
    });

    const result = await resolveReviewGroup(
      context,
      TENANT,
      {
        reason: "UNPARSEABLE_DATE",
        fieldName: "Sub Date",
        rawValue: "12-13-26",
        reviewStatus: "APPLIED",
        resolvedValue: "2026-12-13",
        limit: 50,
      },
      ACTOR,
    );

    expect(result.appliedCount).toBe(1);
    expect((await getCase(context, TENANT, seeded.caseId)).submissionDate).toBe("2026-12-13");
  });

  it("refuses a bad value for the whole group before touching any case", async () => {
    const context = buildTestContext();
    await recordReviewItem(context, TENANT, {
      reason: "UNMAPPED_COUNTRY",
      sourceSheet: "Mini CRM",
      sourceRow: 1,
      caseRef: "38001",
      fieldName: "Country",
      rawValue: "Dubai",
    });
    const attempt = resolveReviewGroup(
      context,
      TENANT,
      { reason: "UNMAPPED_COUNTRY", fieldName: "Country", rawValue: "Dubai", reviewStatus: "APPLIED", resolvedValue: "UAE", limit: 50 },
      ACTOR,
    );
    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    expect((await listReviewItems(context, TENANT, "OPEN")).reviewItems).toHaveLength(1);
  });

  it("refuses APPLIED on a reason that has nothing to write back", async () => {
    const context = buildTestContext();
    const attempt = resolveReviewGroup(
      context,
      TENANT,
      { reason: "PROPOSED_GROUP", fieldName: "REF NO.", rawValue: "1, 2", reviewStatus: "APPLIED", resolvedValue: "1", limit: 50 },
      ACTOR,
    );
    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses an unknown partner id before touching any case", async () => {
    const context = buildTestContext();
    const attempt = resolveReviewGroup(
      context,
      TENANT,
      { reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: "GALAXY", reviewStatus: "APPLIED", resolvedValue: "partner_nope", limit: 50 },
      ACTOR,
    );
    await expect(attempt).rejects.toMatchObject({ statusCode: 404 });
  });

  it("names a case it could not rewrite and leaves that item OPEN, while the rest of the group still closes", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT, { canonicalName: "Galaxy Travels" }, ACTOR);
    const filed = await seedCase(context, partner.partnerId, "38001");
    const filedItem = await seedPartnerItem(context, "38001", "GALAXY");
    // No case was ever filed under this ref: the import died before writing it.
    const orphanItem = await seedPartnerItem(context, "38002", "GALAXY");

    const result = await resolveReviewGroup(
      context,
      TENANT,
      {
        reason: "UNMAPPED_PARTNER",
        fieldName: "REFRENCE",
        rawValue: "GALAXY",
        reviewStatus: "APPLIED",
        resolvedValue: partner.partnerId,
        limit: 50,
      },
      ACTOR,
    );

    expect(result.matchedCount).toBe(2);
    expect(result.resolvedCount).toBe(1);
    expect(result.remainingCount).toBe(1);
    expect(result.failures).toEqual([
      { reviewItemId: orphanItem.reviewItemId, caseRef: "38002", message: "No case is filed under REF 38002" },
    ]);
    expect((await getReviewItemOrThrow(context, TENANT, filedItem.reviewItemId)).reviewStatus).toBe("APPLIED");
    expect((await getReviewItemOrThrow(context, TENANT, orphanItem.reviewItemId)).reviewStatus).toBe("OPEN");
    expect((await getCase(context, TENANT, filed.caseId)).partnerId).toBe(partner.partnerId);
  });
});
