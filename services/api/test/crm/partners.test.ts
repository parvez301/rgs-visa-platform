import { crm } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";
import type { SqlClient } from "../../src/lib/sql";
import { CorruptRecordError } from "../../src/lib/errors";
import {
  createPartner,
  findPartnerByName,
  getPartnerOrThrow,
  listPartners,
  updatePartnerContact,
} from "../../src/domain/crm/partners";

afterEach(closeTestContexts);

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
  await context.sql.query(
    `insert into crm_partners (
       tenant_id, partner_id, canonical_name, canonical_key, partner_type, aliases,
       created_at, updated_at
     ) values ($1, $2, $3, $4, 'AGENCY', $5::jsonb, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
    [tenantId, partnerId, canonicalName, canonicalKey ?? null, JSON.stringify(aliases)],
  );
  return partnerId;
}

/**
 * Writes a partner row that the list and the name lookup both reach but whose
 * body no longer satisfies PartnerSchema: partner_type is NULL.
 * createPartner cannot produce this; a half-written row, a hand-repair, or an
 * importer writing an older shape can.
 */
async function seedUnparseablePartnerItem(
  context: TestContext,
  tenantId: string,
  canonicalName: string,
  partnerId = "prt_half_written",
): Promise<string> {
  await context.sql.query(
    `insert into crm_partners (
       tenant_id, partner_id, canonical_name, canonical_key, aliases, created_at, updated_at
     ) values ($1, $2, $3, $4, '[]'::jsonb, '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z')`,
    [tenantId, partnerId, canonicalName, crm.normalizePartnerName(canonicalName).canonicalKey ?? null],
  );
  return partnerId;
}

describe("crm partners", () => {
  it("creates a partner with the type the shared normalizer inferred", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "VWI Mumbai" }, "ops@rgs.test");
    // "VWI BOM" folds to the same canonical key — this is what stops the
    // migration creating one partner per spelling.
    const found = await findPartnerByName(context, "rgs", "VWI BOM");
    expect(found).toBeDefined();
    expect(found!.canonicalName).toBe("VWI Mumbai");
  });

  it("refuses a second partner that folds to the same canonical key", async () => {
    const context = await buildTestContext();
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

    const { partners } = await listPartners(context, "rgs");
    expect(partners.map((partner) => partner.partnerId)).toEqual([existing.partnerId]);
  });

  it("lets a second tenant use a canonical key the first tenant already holds", async () => {
    const context = await buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "VWI Mumbai" }, "ops@rgs.test");
    const otherTenantPartner = await createPartner(
      context,
      "other-tenant",
      { canonicalName: "VWI Mumbai" },
      "ops@rgs.test",
    );
    expect(otherTenantPartner.tenantId).toBe("other-tenant");
    expect((await listPartners(context, "other-tenant")).partners).toHaveLength(1);
  });

  // Aliases were persisted and then never consulted: a partner recorded as
  // "Ozzy Travels" with the alias "Ozzy" still duplicated when a row said
  // "Ozzy". The migration importer resolves partner names across 7,157
  // spreadsheet rows, where collapsing aliases is the entire point.
  it("finds a partner through one of its recorded aliases", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    const existing = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] },
      "ops@rgs.test",
    );
    await expect(
      createPartner(context, "rgs", { canonicalName: "Ozzy" }, "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await listPartners(context, "rgs")).partners.map((partner) => partner.partnerId)).toEqual(
      [existing.partnerId],
    );
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
      const context = await buildTestContext();
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
      const context = await buildTestContext();
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
      const context = await buildTestContext();
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
      const context = await buildTestContext();
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
    const context = await buildTestContext();
    await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] },
      "ops@rgs.test",
    );
    expect(await findPartnerByName(context, "other-tenant", "Ozzy")).toBeUndefined();
  });

  it("records the creating admin's email and reads it back", async () => {
    const context = await buildTestContext();
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
    await expect(listPartners(context, "rgs")).resolves.toMatchObject({
      partners: [{ createdByEmail: "ops@rgs.test" }],
    });
  });

  it("omits createdByEmail for an admin token that carries no email claim", async () => {
    const context = await buildTestContext();
    // router.ts defaults a missing `email` claim to "", and "" is not an author.
    const partner = await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "");
    expect(partner.createdByEmail).toBeUndefined();
    expect((await getPartnerOrThrow(context, "rgs", partner.partnerId)).createdByEmail).toBeUndefined();
  });

  it("returns undefined when no partner matches", async () => {
    const context = await buildTestContext();
    expect(await findPartnerByName(context, "rgs", "Nobody Travels")).toBeUndefined();
  });

  it("lists partners for the tenant", async () => {
    const context = await buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    await createPartner(context, "rgs", { canonicalName: "Luxe Escape" }, "ops@rgs.test");
    const listed = await listPartners(context, "rgs");
    expect(listed.partners).toHaveLength(2);
    expect(listed.partners.map((partner) => partner.canonicalName).sort()).toEqual([
      "Luxe Escape",
      "Ozzy Travels",
    ]);
    expect(listed.unreadablePartnerIds).toEqual([]);
  });

  it("keeps one tenant's partners out of another's list", async () => {
    const context = await buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    expect(await listPartners(context, "other-tenant")).toEqual({
      partners: [],
      unreadablePartnerIds: [],
    });
  });

  // --- A stored partner that will not parse is a 409, never a raw 500. ---
  // Raw, the ZodError is not an ApiError, and router.ts maps only ApiError
  // subclasses. Each test asserts the status code rather than that something
  // threw: `.rejects.toThrow()` holds just as well for the ZodError being
  // removed here, which is how this class of bug stayed hidden twice already.
  describe("a stored partner record that no longer parses", () => {
    it("surfaces as a typed 409 from the name lookup, naming the bad field", async () => {
      const context = await buildTestContext();
      const partnerId = await seedUnparseablePartnerItem(context, "rgs", "Ozzy Travels");

      const nameLookup = findPartnerByName(context, "rgs", "Ozzy Travels");
      await expect(nameLookup).rejects.toBeInstanceOf(CorruptRecordError);
      await expect(nameLookup).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
      // The id and the field are what an operator repairs the row with.
      await expect(nameLookup).rejects.toThrow(partnerId);
      await expect(nameLookup).rejects.toThrow("partnerType");
    });

    it("surfaces as a typed 409 from the single-partner read", async () => {
      const context = await buildTestContext();
      const partnerId = await seedUnparseablePartnerItem(context, "rgs", "Ozzy Travels");

      const singleRead = getPartnerOrThrow(context, "rgs", partnerId);
      await expect(singleRead).rejects.toBeInstanceOf(CorruptRecordError);
      // 409 and not 404: the partner is on file, it is unreadable. A 404 would
      // tell an operator to re-create a partner that already exists, which
      // splits that partner's cases, volume and revenue across two records.
      await expect(singleRead).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
    });
  });

  // --- One corrupt partner row must not take the whole list down. ---
  // The same blast radius the case queue was already fixed for: one bad
  // partition 500'd GET /crm/cases?status=NEW for the entire tenant.
  it("still lists the healthy partners when one stored row will not parse", async () => {
    const context = await buildTestContext();
    const healthy = await createPartner(
      context,
      "rgs",
      { canonicalName: "Luxe Escape" },
      "ops@rgs.test",
    );
    const corruptPartnerId = await seedUnparseablePartnerItem(context, "rgs", "Ozzy Travels");

    const listed = await listPartners(context, "rgs");
    // The healthy partner is still served — the whole point.
    expect(listed.partners.map((partner) => partner.partnerId)).toEqual([healthy.partnerId]);
    expect(listed.partners[0]!.canonicalName).toBe("Luxe Escape");
    // ...and the row that was skipped is named, not silently dropped. Without
    // this the partner simply is not in the list and nothing says why.
    expect(listed.unreadablePartnerIds).toEqual([corruptPartnerId]);
  });

  it("warns with the id of the partner row it had to skip", async () => {
    const context = await buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Luxe Escape" }, "ops@rgs.test");
    const corruptPartnerId = await seedUnparseablePartnerItem(context, "rgs", "Ozzy Travels");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warnedText = "";
    try {
      await listPartners(context, "rgs");
      // Read the calls before restoring: mockRestore also clears them.
      warnedText = warnSpy.mock.calls.map((warnArguments) => warnArguments.join(" ")).join("\n");
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnedText).toContain(corruptPartnerId);
    // The failing field is what turns a log line into a repair instruction.
    expect(warnedText).toContain("partnerType");
  });

  it("keeps listing when every row in the tenant is corrupt", async () => {
    const context = await buildTestContext();
    const firstCorruptId = await seedUnparseablePartnerItem(
      context,
      "rgs",
      "Ozzy Travels",
      "prt_bad_one",
    );
    const secondCorruptId = await seedUnparseablePartnerItem(
      context,
      "rgs",
      "Luxe Escape",
      "prt_bad_two",
    );

    // Returning early on the first bad row would still satisfy a test that
    // only seeds one, and would still hide the second from the operator.
    const listed = await listPartners(context, "rgs");
    expect(listed.partners).toEqual([]);
    expect(listed.unreadablePartnerIds.sort()).toEqual(
      [firstCorruptId, secondCorruptId].sort(),
    );
  });

  it("throws a 404 for a partner that does not exist", async () => {
    const context = await buildTestContext();
    await expect(getPartnerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("accepts an explicit partner type and aliases", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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

  describe("updatePartnerContact", () => {
    it("sets the contact email on a partner created without one, leaving everything else intact", async () => {
      const context = await buildTestContext();
      const created = await createPartner(context, "rgs", { canonicalName: "Skyline Travels", aliases: ["Skyline"] }, "ops@rgs.test");

      const updated = await updatePartnerContact(context, "rgs", created.partnerId, { contactEmail: "desk@skyline.test" });

      expect(updated.contactEmail).toBe("desk@skyline.test");
      expect(updated.canonicalName).toBe("Skyline Travels");
      expect(updated.aliases).toEqual(["Skyline"]);
      expect(await getPartnerOrThrow(context, "rgs", created.partnerId)).toEqual(updated);
      // The listing index key survives the rewrite: the partner is still findable by name.
      expect((await findPartnerByName(context, "rgs", "Skyline Travels"))?.partnerId).toBe(created.partnerId);
    });

    it("clears a contact field when given null and leaves an omitted field alone", async () => {
      const context = await buildTestContext();
      const created = await createPartner(
        context,
        "rgs",
        { canonicalName: "Ozzy Travels", contactEmail: "old@ozzy.test", contactPhone: "+91 98100 00000" },
        "ops@rgs.test",
      );

      const updated = await updatePartnerContact(context, "rgs", created.partnerId, { contactEmail: null });

      expect(updated).not.toHaveProperty("contactEmail");
      expect(updated.contactPhone).toBe("+91 98100 00000");
    });

    it("404s for a partner that does not exist", async () => {
      const context = await buildTestContext();
      await expect(
        updatePartnerContact(context, "rgs", "prt_missing", { contactEmail: "x@y.test" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

describe("partners on Postgres (SQL row assertions)", () => {
  let context: TestContext;
  let sql: SqlClient;

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  beforeEach(async () => {
    context = await buildTestContext({ seedStatusEmailTemplates: false });
    sql = context.sql;
  });

  it("creates a partner row and reads it back identically", async () => {
    const created = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"], notes: "VIP", contactPhone: "+9715550100" },
      ACTOR,
    );

    expect(await scalar<number>("select count(*)::int as value from crm_partners")).toBe(1);
    expect(await scalar<string>("select canonical_key as value from crm_partners")).toBe(
      "OZZY TRAVELS",
    );
    expect(await getPartnerOrThrow(context, TENANT_ID, created.partnerId)).toEqual(created);
    expect(created).toMatchObject({ aliases: ["Ozzy"], notes: "VIP", createdByEmail: ACTOR });
  });

  it("refuses a second partner on the same canonical name, or on an existing alias, with 409", async () => {
    await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels", aliases: ["Ozzy"] }, ACTOR);

    await expect(
      createPartner(context, TENANT_ID, { canonicalName: "OZZY  TRAVELS" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      createPartner(context, TENANT_ID, { canonicalName: "Ozzy" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await scalar<number>("select count(*)::int as value from crm_partners")).toBe(1);
  });

  it("scopes partners to their tenant", async () => {
    await createPartner(context, "tenant_a", { canonicalName: "Ozzy Travels" }, ACTOR);
    const other = await createPartner(context, "tenant_b", { canonicalName: "Ozzy Travels" }, ACTOR);

    expect((await listPartners(context, "tenant_b")).partners.map((partner) => partner.partnerId)).toEqual([
      other.partnerId,
    ]);
    expect(await findPartnerByName(context, "tenant_c", "Ozzy Travels")).toBeUndefined();
  });

  it("lists partners in canonical-name order", async () => {
    await createPartner(context, TENANT_ID, { canonicalName: "Zeta Tours" }, ACTOR);
    await createPartner(context, TENANT_ID, { canonicalName: "Alpha Tours" }, ACTOR);

    const listing = await listPartners(context, TENANT_ID);
    expect(listing.partners.map((partner) => partner.canonicalName)).toEqual(["Alpha Tours", "Zeta Tours"]);
    expect(listing.unreadablePartnerIds).toEqual([]);
  });

  it("finds a partner by canonical name or alias, and the real name beats an alias squatter", async () => {
    const squatter = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Aaa Travel", aliases: ["Ozzy Travels"] },
      ACTOR,
    );
    // createPartner refuses the name an alias already holds, so the real
    // partner is inserted the way an importer-era row would exist.
    await sql.query(
      `insert into crm_partners (tenant_id, partner_id, canonical_name, canonical_key, partner_type, created_at, updated_at)
       values ($1, 'prt_real', 'Ozzy Travels', 'OZZY TRAVELS', 'AGENCY', now(), now())`,
      [TENANT_ID],
    );

    expect((await findPartnerByName(context, TENANT_ID, "ozzy travels"))?.partnerId).toBe("prt_real");
    expect((await findPartnerByName(context, TENANT_ID, "Aaa Travel"))?.partnerId).toBe(squatter.partnerId);
    expect(await findPartnerByName(context, TENANT_ID, "Nobody Ltd")).toBeUndefined();
  });

  it("derives the canonical key at match time for rows that have none (Phase A backfill)", async () => {
    await sql.query(
      `insert into crm_partners (tenant_id, partner_id, canonical_name, partner_type, updated_at)
       values ($1, 'prt_legacy', 'Legacy Travel', 'AGENCY', '2026-03-01T08:00:00Z')`,
      [TENANT_ID],
    );

    const found = await findPartnerByName(context, TENANT_ID, "LEGACY  travel");
    expect(found?.partnerId).toBe("prt_legacy");
    // created_at is absent on such rows: it falls back to updated_at.
    expect(found?.createdAt).toBe("2026-03-01T08:00:00.000Z");
  });

  it("names a partner row that will not parse instead of failing the whole list", async () => {
    await createPartner(context, TENANT_ID, { canonicalName: "Good Travel" }, ACTOR);
    await sql.query(
      `insert into crm_partners (tenant_id, partner_id, canonical_name, canonical_key, updated_at)
       values ($1, 'prt_half_written', 'Half Written', 'HALF WRITTEN', now())`,
      [TENANT_ID],
    );

    const listing = await listPartners(context, TENANT_ID);
    expect(listing.partners.map((partner) => partner.canonicalName)).toEqual(["Good Travel"]);
    expect(listing.unreadablePartnerIds).toEqual(["prt_half_written"]);
    await expect(getPartnerOrThrow(context, TENANT_ID, "prt_half_written")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("updates contact fields, clears with null, and leaves name and aliases alone", async () => {
    const created = await createPartner(
      context,
      TENANT_ID,
      { canonicalName: "Ozzy Travels", aliases: ["Ozzy"], contactPhone: "+9715550100" },
      ACTOR,
    );
    context.advanceClock(60_000);

    const updated = await updatePartnerContact(context, TENANT_ID, created.partnerId, {
      contactEmail: "ops@ozzy.example",
      contactPhone: null,
      contactWhatsapp: "+9715550101",
    });

    expect(updated).toEqual({
      ...created,
      contactEmail: "ops@ozzy.example",
      contactWhatsapp: "+9715550101",
      contactPhone: undefined,
    });
    expect(await getPartnerOrThrow(context, TENANT_ID, created.partnerId)).toEqual(updated);
    expect(await scalar<string | null>("select contact_phone as value from crm_partners")).toBeNull();
    expect((await findPartnerByName(context, TENANT_ID, "Ozzy"))?.partnerId).toBe(created.partnerId);
    expect(await scalar<boolean>("select updated_at > created_at as value from crm_partners")).toBe(true);
  });

  it("answers 404 for an unknown partner on read and on contact update", async () => {
    await expect(getPartnerOrThrow(context, TENANT_ID, "prt_missing")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      updatePartnerContact(context, TENANT_ID, "prt_missing", { contactEmail: "a@b.example" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
