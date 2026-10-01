import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { resolveCaseTravellers } from "../../src/domain/crm/caseTravellers";
import {
  createPartner,
  findPartnerByName,
  getPartnerOrThrow,
  listPartners,
  updatePartnerContact,
} from "../../src/domain/crm/partners";
import { claimNewRefs, readRefClaim, releaseRefKeys } from "../../src/domain/crm/refClaims";
import {
  findTravellerByName,
  findTravellerByPassport,
  getTravellerOrThrow,
  updateTravellerDetails,
  upsertTraveller,
} from "../../src/domain/crm/travellers";
import type { AppContext } from "../../src/lib/context";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

/** Records every string argument of every Dynamo table call, so "never touched Dynamo" is provable. */
function trackTableAccess(table: TestContext["table"]): { table: TestContext["table"]; touchedKeys: string[] } {
  const touchedKeys: string[] = [];
  const tracked = new Proxy(table, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        for (const arg of args) {
          if (typeof arg === "string") touchedKeys.push(arg);
          else if (typeof arg === "object" && arg !== null && typeof (arg as { PK?: unknown }).PK === "string") {
            touchedKeys.push((arg as { PK: string }).PK);
          }
        }
        return member.apply(target, args);
      };
    },
  });
  return { table: tracked, touchedKeys };
}

function caseShape(caseRef: string, refNos: (string | undefined)[] = []) {
  return {
    caseRef,
    applicants: refNos.map((refNo, applicantIndex) => ({
      applicantRef: `A${applicantIndex + 1}`,
      travellerId: `trv_${applicantIndex}`,
      custody: "NOT_HELD" as const,
      outcome: "PENDING" as const,
      ...(refNo === undefined ? {} : { refNo }),
    })),
  };
}

describe("partners, travellers and REF claims with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let context: TestContext & AppContext;
  let touchedKeys: string[];

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  function expectNoDynamoAccess(): void {
    expect(touchedKeys.filter((key) => key.startsWith("TENANT#"))).toEqual([]);
  }

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    const baseContext = buildTestContext({ seedStatusEmailTemplates: false });
    const tracking = trackTableAccess(baseContext.table);
    touchedKeys = tracking.touchedKeys;
    context = { ...baseContext, table: tracking.table, crmStore: "postgres", sql };
  });

  describe("partners", () => {
    it("creates a partner row and reads it back identically, without touching Dynamo", async () => {
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
      expectNoDynamoAccess();
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
      expectNoDynamoAccess();
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

  describe("travellers", () => {
    it("creates a traveller row with date of birth and reads it back identically", async () => {
      const created = await upsertTraveller(context, TENANT_ID, {
        fullName: "Umesh Kumar Yadav",
        passportNumber: "Z6931368",
        dateOfBirth: "1990-02-03",
        phone: "+919810000000",
      });

      expect(created.normalizedName).toBe("UMESH KUMAR YADAV");
      expect(await getTravellerOrThrow(context, TENANT_ID, created.travellerId)).toEqual(created);
      expect(await findTravellerByPassport(context, TENANT_ID, "Z6931368")).toEqual(created);
      expect(await findTravellerByName(context, TENANT_ID, "umesh  kumar yadav")).toEqual(created);
      expectNoDynamoAccess();
    });

    it("returns the SAME traveller for a repeat passport rather than a second row", async () => {
      const first = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });
      const second = await upsertTraveller(context, TENANT_ID, { fullName: "A. Verma", passportNumber: "N1234567" });

      expect(second.travellerId).toBe(first.travellerId);
      expect(await scalar<number>("select count(*)::int as value from crm_travellers")).toBe(1);
    });

    it("lets the database arbitrate two concurrent upserts of one passport", async () => {
      const [left, right] = await Promise.all([
        upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N7654321" }),
        upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N7654321" }),
      ]);

      expect(right.travellerId).toBe(left.travellerId);
      expect(await scalar<number>("select count(*)::int as value from crm_travellers")).toBe(1);
    });

    it("enforces passport uniqueness per tenant in the schema itself", async () => {
      await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });

      await expect(
        sql.query(
          `insert into crm_travellers (tenant_id, traveller_id, full_name, normalized_name, passport_number, created_at)
           values ($1, 'trv_dupe', 'Someone Else', 'SOMEONE ELSE', 'N1234567', now())`,
          [TENANT_ID],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("allows one passport in two tenants, and many travellers with no passport", async () => {
      const inRgs = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });
      const inOther = await upsertTraveller(context, "tenant_b", { fullName: "Asha Verma", passportNumber: "N1234567" });
      expect(inOther.travellerId).not.toBe(inRgs.travellerId);

      const noPassportA = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi Rao" });
      const noPassportB = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi Rao" });
      expect(noPassportB.travellerId).not.toBe(noPassportA.travellerId);
      expect(await scalar<number>("select count(*)::int as value from crm_travellers")).toBe(4);
    });

    it("answers a blank name with 400 and 404 for an unknown traveller", async () => {
      await expect(upsertTraveller(context, TENANT_ID, { fullName: "   " })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(getTravellerOrThrow(context, TENANT_ID, "trv_missing")).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await scalar<number>("select count(*)::int as value from crm_travellers")).toBe(0);
    });

    it("edits name and passport, clears the passport, and refuses another traveller's passport with 409", async () => {
      const asha = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });
      const ravi = await upsertTraveller(context, TENANT_ID, { fullName: "Ravi Rao", passportNumber: "P7654321" });

      const renamed = await updateTravellerDetails(context, TENANT_ID, asha.travellerId, {
        fullName: "Asha Kumari Verma",
        passportNumber: "N1234567",
      });
      expect(renamed.normalizedName).toBe("ASHA KUMARI VERMA");
      expect((await findTravellerByName(context, TENANT_ID, "Asha Kumari Verma"))?.travellerId).toBe(asha.travellerId);
      expect(await findTravellerByName(context, TENANT_ID, "Asha Verma")).toBeUndefined();

      await expect(
        updateTravellerDetails(context, TENANT_ID, asha.travellerId, { passportNumber: "P7654321" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await getTravellerOrThrow(context, TENANT_ID, asha.travellerId)).passportNumber).toBe("N1234567");

      const moved = await updateTravellerDetails(context, TENANT_ID, asha.travellerId, { passportNumber: "N9999999" });
      expect(moved.passportNumber).toBe("N9999999");
      expect(await findTravellerByPassport(context, TENANT_ID, "N1234567")).toBeUndefined();

      const cleared = await updateTravellerDetails(context, TENANT_ID, asha.travellerId, { passportNumber: null });
      expect(cleared.passportNumber).toBeUndefined();
      // The freed passport can now be registered by someone else.
      const reuse = await updateTravellerDetails(context, TENANT_ID, ravi.travellerId, { passportNumber: "N9999999" });
      expect(reuse.passportNumber).toBe("N9999999");
      expectNoDynamoAccess();
    });

    it("resolves case travellers by id, skipping unknown ones", async () => {
      const asha = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });
      const resolved = await resolveCaseTravellers(context, TENANT_ID, [
        { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
        { applicantRef: "A2", travellerId: "trv_ghost", custody: "NOT_HELD", outcome: "PENDING" },
      ]);

      expect(resolved).toEqual({ [asha.travellerId]: { fullName: "Asha Verma", passportNumber: "N1234567" } });
      expectNoDynamoAccess();
    });
  });

  describe("REF claims", () => {
    it("claims the case REF and every applicant REF NO in crm_ref_claims", async () => {
      const claimed = await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("38017", ["p-2"]));

      expect(claimed).toEqual(["38017", "P-2"]);
      expect(await readRefClaim(context, TENANT_ID, "P-2")).toMatchObject({
        tenantId: TENANT_ID,
        refKey: "P-2",
        refValue: "p-2",
        caseId: "case_1",
        claimedAt: "2026-07-23T10:00:00.000Z",
      });
      expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(2);
      expectNoDynamoAccess();
    });

    it("answers 409 when another case holds the REF, whatever the case or spacing", async () => {
      await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("RGS  100"));

      await expect(
        claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("rgs 100")),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect((await readRefClaim(context, TENANT_ID, "RGS 100"))?.caseId).toBe("case_1");
    });

    it("rolls back the keys it had already claimed when a later key is taken", async () => {
      await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("TAKEN"));

      await expect(
        claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("FRESH", ["TAKEN"])),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(await readRefClaim(context, TENANT_ID, "FRESH")).toBeUndefined();
      expect((await readRefClaim(context, TENANT_ID, "TAKEN"))?.caseId).toBe("case_1");
    });

    it("does not 409 a case on its own REF, and only claims what the new version adds", async () => {
      const first = caseShape("38017");
      await claimNewRefs(context, TENANT_ID, "case_1", undefined, first);

      const again = await claimNewRefs(context, TENANT_ID, "case_1", first, caseShape("38017", ["38017", "P-3"]));
      expect(again).toEqual(["P-3"]);
      // A retry whose first attempt landed but lost its response: our own claim is not a conflict.
      expect(await claimNewRefs(context, TENANT_ID, "case_1", undefined, first)).toEqual(["38017"]);
    });

    it("lets exactly one of two concurrent claimants win the REF", async () => {
      const outcomes = await Promise.allSettled([
        claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("RACE-1")),
        claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("RACE-1")),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ statusCode: 409 });
      expect(await scalar<number>("select count(*)::int as value from crm_ref_claims")).toBe(1);
    });

    it("releases only the claims the case owns, after which the REF is free", async () => {
      await claimNewRefs(context, TENANT_ID, "case_1", undefined, caseShape("MINE"));

      await releaseRefKeys(context, TENANT_ID, "case_2", ["MINE"]);
      expect((await readRefClaim(context, TENANT_ID, "MINE"))?.caseId).toBe("case_1");

      await releaseRefKeys(context, TENANT_ID, "case_1", ["MINE", "NEVER-CLAIMED"]);
      expect(await readRefClaim(context, TENANT_ID, "MINE")).toBeUndefined();

      expect(await claimNewRefs(context, TENANT_ID, "case_2", undefined, caseShape("MINE"))).toEqual(["MINE"]);
    });

    it("scopes claims to the tenant", async () => {
      await claimNewRefs(context, "tenant_a", "case_1", undefined, caseShape("SHARED"));
      expect(await claimNewRefs(context, "tenant_b", "case_2", undefined, caseShape("SHARED"))).toEqual(["SHARED"]);
    });
  });
});
