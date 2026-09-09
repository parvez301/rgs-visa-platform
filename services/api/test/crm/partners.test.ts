import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { META_SORT_KEY, partnerListGsi1Pk, partnerPartitionKey } from "../../src/domain/crm/keys";
import {
  createPartner,
  findPartnerByName,
  getPartnerOrThrow,
  listPartners,
} from "../../src/domain/crm/partners";

/**
 * Writes a partner item exactly as createPartner does, but without its
 * duplicate check. createPartner refuses — by design, and there is a test for
 * it below — a canonical name that some existing partner already lists as an
 * alias, so this is the only way to build the state where the alias holder was
 * recorded first and the partner whose own name it squats came second.
 */
async function seedPartnerItemDirectly(
  context: TestContext,
  tenantId: string,
  canonicalName: string,
  aliases: string[] = [],
): Promise<string> {
  const partnerId = `prt_seeded_${canonicalName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const canonicalKey = crm.normalizePartnerName(canonicalName).canonicalKey;
  await context.table.put({
    PK: partnerPartitionKey(tenantId, partnerId),
    SK: META_SORT_KEY,
    GSI1PK: partnerListGsi1Pk(tenantId),
    GSI1SK: canonicalKey ?? "",
    tenantId,
    partnerId,
    canonicalName,
    partnerType: "AGENCY",
    aliases,
    createdAt: "2026-07-23T10:00:00.000Z",
  });
  return partnerId;
}

describe("crm partners", () => {
  it("creates a partner with the type the shared normalizer inferred", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "VWI Mumbai" },
      "ops@rgs.test",
    );
    expect(partner.canonicalName).toBe("VWI Mumbai");
    expect(partner.partnerType).toBe("AGENCY");
    expect(partner.aliases).toEqual([]);
    // canonicalKey is deliberately NOT on the domain object — it is a storage
    // attribute only. Its effect is observable through findPartnerByName below.
    expect("canonicalKey" in partner).toBe(false);
  });

  it("finds an existing partner through a different spelling", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "VWI Mumbai" }, "ops@rgs.test");
    // "VWI BOM" folds to the same canonical key — this is what stops the
    // migration creating one partner per spelling.
    const found = await findPartnerByName(context, "rgs", "VWI BOM");
    expect(found).toBeDefined();
    expect(found!.canonicalName).toBe("VWI Mumbai");
  });

  it("refuses a second partner that folds to the same canonical key", async () => {
    const context = buildTestContext();
    const existing = await createPartner(
      context,
      "rgs",
      { canonicalName: "VWI Mumbai" },
      "ops@rgs.test",
    );

    // "VWI BOM" folds to the canonical key "VWI Mumbai" already holds. Two
    // partners on one key split that partner's cases, volume and revenue.
    const duplicateAttempt = createPartner(
      context,
      "rgs",
      { canonicalName: "VWI BOM" },
      "ops@rgs.test",
    );
    await expect(duplicateAttempt).rejects.toMatchObject({ statusCode: 409 });
    // The existing partnerId is in the message, so a caller recovers without a
    // second lookup.
    await expect(duplicateAttempt).rejects.toThrow(existing.partnerId);

    const partners = await listPartners(context, "rgs");
    expect(partners.map((partner) => partner.partnerId)).toEqual([existing.partnerId]);
  });

  it("lets a second tenant use a canonical key the first tenant already holds", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "VWI Mumbai" }, "ops@rgs.test");
    const otherTenantPartner = await createPartner(
      context,
      "other-tenant",
      { canonicalName: "VWI Mumbai" },
      "ops@rgs.test",
    );
    expect(otherTenantPartner.tenantId).toBe("other-tenant");
    expect(await listPartners(context, "other-tenant")).toHaveLength(1);
  });

  // Aliases were persisted and then never consulted: a partner recorded as
  // "Ozzy Travels" with the alias "Ozzy" still duplicated when a row said
  // "Ozzy". The migration importer resolves partner names across 7,157
  // spreadsheet rows, where collapsing aliases is the entire point.
  it("finds a partner through one of its recorded aliases", async () => {
    const context = buildTestContext();
    const ozzy = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] },
      "ops@rgs.test",
    );
    const found = await findPartnerByName(context, "rgs", "Ozzy");
    expect(found).toBeDefined();
    expect(found!.partnerId).toBe(ozzy.partnerId);
  });

  it("normalizes an alias the same way it normalizes the canonical name", async () => {
    const context = buildTestContext();
    const ozzy = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["  ozzy   travels bom "] },
      "ops@rgs.test",
    );
    // Case, padding and repeated spaces all fold away, exactly as they do for
    // the canonical name — otherwise the alias only matches a byte-perfect row.
    const found = await findPartnerByName(context, "rgs", "OZZY TRAVELS BOM");
    expect(found).toBeDefined();
    expect(found!.partnerId).toBe(ozzy.partnerId);
  });

  it("refuses a new partner whose name collides with an existing alias", async () => {
    const context = buildTestContext();
    const existing = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] },
      "ops@rgs.test",
    );
    await expect(
      createPartner(context, "rgs", { canonicalName: "Ozzy" }, "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await listPartners(context, "rgs")).map((partner) => partner.partnerId)).toEqual([
      existing.partnerId,
    ]);
  });

  // An alias must never squat a partner's own name. findPartnerByName folded
  // canonical names and aliases into one `.find` over the partner index, so
  // whichever item the index happened to return first won — and that index is
  // ordered by canonical key, which has nothing to do with intent. A partner
  // "Aaa Travel" carrying the alias "Ozzy Travels" therefore answered a lookup
  // for "Ozzy Travels". The importer resolves partner names across 7,157
  // spreadsheet rows: every "VWI" case would attach to whoever happened to list
  // "VWI" as an alias.
  describe("an exact canonical name always beats another partner's alias", () => {
    it("wins when the alias holder sorts ahead of it in the partner index", async () => {
      const context = buildTestContext();
      const ozzy = await createPartner(
        context,
        "rgs",
        { canonicalName: "Ozzy Travels" },
        "ops@rgs.test",
      );
      const aliasSquatter = await createPartner(
        context,
        "rgs",
        { canonicalName: "Aaa Travel", aliases: ["Ozzy Travels"] },
        "ops@rgs.test",
      );

      const found = await findPartnerByName(context, "rgs", "Ozzy Travels");
      expect(found?.partnerId).toBe(ozzy.partnerId);
      expect(found?.partnerId).not.toBe(aliasSquatter.partnerId);
    });

    it("wins when the alias holder sorts behind it in the partner index", async () => {
      const context = buildTestContext();
      const ozzy = await createPartner(
        context,
        "rgs",
        { canonicalName: "Ozzy Travels" },
        "ops@rgs.test",
      );
      // The mirror image of the case above: "Zzz Travel" sorts last, so a
      // precedence rule that merely reads the index backwards would pass one
      // of these two and fail the other.
      const aliasSquatter = await createPartner(
        context,
        "rgs",
        { canonicalName: "Zzz Travel", aliases: ["Ozzy Travels"] },
        "ops@rgs.test",
      );

      const found = await findPartnerByName(context, "rgs", "Ozzy Travels");
      expect(found?.partnerId).toBe(ozzy.partnerId);
      expect(found?.partnerId).not.toBe(aliasSquatter.partnerId);
    });

    it("wins even when the alias holder was recorded first", async () => {
      const context = buildTestContext();
      const aliasSquatter = await createPartner(
        context,
        "rgs",
        { canonicalName: "Aaa Travel", aliases: ["Ozzy Travels"] },
        "ops@rgs.test",
      );
      // Seeded directly, because createPartner would (correctly) 409 on a name
      // an existing partner already lists as an alias.
      const ozzyPartnerId = await seedPartnerItemDirectly(context, "rgs", "Ozzy Travels");

      const found = await findPartnerByName(context, "rgs", "Ozzy Travels");
      expect(found?.partnerId).toBe(ozzyPartnerId);
      expect(found?.partnerId).not.toBe(aliasSquatter.partnerId);
    });

    it("still falls back to the alias when no partner carries that canonical name", async () => {
      const context = buildTestContext();
      const aliasSquatter = await createPartner(
        context,
        "rgs",
        { canonicalName: "Aaa Travel", aliases: ["Ozzy Travels"] },
        "ops@rgs.test",
      );
      // Nothing is named "Ozzy Travels", so the alias is the only answer there
      // is — canonical precedence must not turn alias matching off.
      const found = await findPartnerByName(context, "rgs", "Ozzy Travels");
      expect(found?.partnerId).toBe(aliasSquatter.partnerId);
    });
  });

  it("keeps one tenant's aliases from matching another tenant's lookup", async () => {
    const context = buildTestContext();
    await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] },
      "ops@rgs.test",
    );
    expect(await findPartnerByName(context, "other-tenant", "Ozzy")).toBeUndefined();
  });

  it("records the creating admin's email and reads it back", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels" },
      "ops@rgs.test",
    );
    // Written but never readable is the same defect class as the aliases above.
    expect(partner.createdByEmail).toBe("ops@rgs.test");
    const reloaded = await getPartnerOrThrow(context, "rgs", partner.partnerId);
    expect(reloaded.createdByEmail).toBe("ops@rgs.test");
    expect(listPartners(context, "rgs")).resolves.toMatchObject([
      { createdByEmail: "ops@rgs.test" },
    ]);
  });

  it("omits createdByEmail for an admin token that carries no email claim", async () => {
    const context = buildTestContext();
    // router.ts defaults a missing `email` claim to "", and "" is not an author.
    const partner = await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "");
    expect(partner.createdByEmail).toBeUndefined();
    expect((await getPartnerOrThrow(context, "rgs", partner.partnerId)).createdByEmail).toBeUndefined();
  });

  it("returns undefined when no partner matches", async () => {
    const context = buildTestContext();
    expect(await findPartnerByName(context, "rgs", "Nobody Travels")).toBeUndefined();
  });

  it("lists partners for the tenant", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    await createPartner(context, "rgs", { canonicalName: "Luxe Escape" }, "ops@rgs.test");
    const partners = await listPartners(context, "rgs");
    expect(partners).toHaveLength(2);
    expect(partners.map((partner) => partner.canonicalName).sort()).toEqual([
      "Luxe Escape",
      "Ozzy Travels",
    ]);
  });

  it("keeps one tenant's partners out of another's list", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    expect(await listPartners(context, "other-tenant")).toEqual([]);
  });

  it("throws a 404 for a partner that does not exist", async () => {
    const context = buildTestContext();
    await expect(getPartnerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("accepts an explicit partner type and aliases", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "Sudiva Spinners Pvt Ltd", partnerType: "CORPORATE", aliases: ["Sudiva"] },
      "ops@rgs.test",
    );
    expect(partner.partnerType).toBe("CORPORATE");
    expect(partner.aliases).toEqual(["Sudiva"]);
  });

  it("stores contact details when they are supplied and reads them back", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      {
        canonicalName: "Ozzy Travels",
        contactPhone: "+919810000001",
        contactEmail: "desk@ozzytravels.test",
        contactWhatsapp: "+919810000002",
      },
      "ops@rgs.test",
    );
    expect(partner.contactPhone).toBe("+919810000001");
    expect(partner.contactEmail).toBe("desk@ozzytravels.test");
    expect(partner.contactWhatsapp).toBe("+919810000002");

    const reloaded = await getPartnerOrThrow(context, "rgs", partner.partnerId);
    expect(reloaded.contactPhone).toBe("+919810000001");
    expect(reloaded.contactEmail).toBe("desk@ozzytravels.test");
    expect(reloaded.contactWhatsapp).toBe("+919810000002");
  });
});
