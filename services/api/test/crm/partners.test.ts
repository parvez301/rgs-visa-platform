import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import {
  createPartner,
  findPartnerByName,
  getPartnerOrThrow,
  listPartners,
} from "../../src/domain/crm/partners";

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
