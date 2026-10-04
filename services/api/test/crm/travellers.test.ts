import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";
import type { SqlClient } from "../../src/lib/sql";
import { resolveCaseTravellers } from "../../src/domain/crm/caseTravellers";
import { CorruptRecordError } from "../../src/lib/errors";
import {
  findTravellerByName,
  findTravellerByPassport,
  getTravellerOrThrow,
  normalizeTravellerName,
  updateTravellerDetails,
  upsertTraveller,
} from "../../src/domain/crm/travellers";

afterEach(closeTestContexts);

/**
 * Writes a traveller row that every lookup reaches but whose body no longer
 * satisfies CrmTravellerSchema -- here the stored full_name is blank.
 * upsertTraveller cannot produce this; a half-written row, a hand-repair, or
 * an importer writing an older shape can.
 */
async function seedUnparseableTravellerItem(
  context: TestContext,
  options: { travellerId: string; fullName: string; passportNumber: string },
): Promise<void> {
  await context.sql.query(
    `insert into crm_travellers (
       tenant_id, traveller_id, full_name, normalized_name, passport_number, created_at
     ) values ('rgs', $1, '   ', $2, $3, '2026-07-23T10:00:00.000Z')`,
    [options.travellerId, normalizeTravellerName(options.fullName), options.passportNumber],
  );
}

describe("crm travellers", () => {
  it("creates a traveller and indexes the passport", async () => {
    const context = await buildTestContext();
    const traveller = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    expect(traveller.fullName).toBe("Umesh Kumar Yadav");
    expect(traveller.normalizedName).toBe("UMESH KUMAR YADAV");

    const found = await findTravellerByPassport(context, "rgs", "Z6931368");
    expect(found).toBeDefined();
    expect(found!.travellerId).toBe(traveller.travellerId);
  });

  it("returns the SAME traveller for a repeat passport rather than duplicating", async () => {
    const context = await buildTestContext();
    const first = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    context.advanceClock(86_400_000);
    const second = await upsertTraveller(context, "rgs", {
      fullName: "Umesh K Yadav",
      passportNumber: "Z6931368",
    });
    // This is the capability the Excel sheet cannot provide.
    expect(second.travellerId).toBe(first.travellerId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("rejects a whitespace-only name with a typed 400 rather than a raw ZodError", async () => {
    const context = await buildTestContext();
    // buildLookupKey trims "   " to "", which no schema accepts. Unwrapped, the
    // ZodError escapes the router's ApiError mapping and becomes a 500.
    await expect(upsertTraveller(context, "rgs", { fullName: "   " })).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
  });

  it("creates separate travellers when the passport differs", async () => {
    const context = await buildTestContext();
    const yadav = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    const kapoor = await upsertTraveller(context, "rgs", {
      fullName: "Aman Kapoor",
      passportNumber: "M1112223",
    });
    expect(kapoor.travellerId).not.toBe(yadav.travellerId);

    // Two records really are on file, each indexed under its own passport...
    expect((await findTravellerByPassport(context, "rgs", "Z6931368"))!.fullName).toBe(
      "Umesh Kumar Yadav",
    );
    expect((await findTravellerByPassport(context, "rgs", "M1112223"))!.fullName).toBe(
      "Aman Kapoor",
    );

    // ...and a repeat of the second passport resolves to the second traveller,
    // not merely to the first traveller on file. Comparing two generated ids
    // for inequality, on its own, would hold however wrong the dedup was.
    context.advanceClock(86_400_000);
    const kapoorAgain = await upsertTraveller(context, "rgs", {
      fullName: "A Kapoor",
      passportNumber: "M1112223",
    });
    expect(kapoorAgain.travellerId).toBe(kapoor.travellerId);
  });

  it("creates a new traveller each time when no passport is recorded", async () => {
    const context = await buildTestContext();
    // 74% of workbook rows carry no passport number, so this path is the common one.
    const first = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    context.advanceClock(1_000);
    const second = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    expect(second.travellerId).not.toBe(first.travellerId);

    // Both are genuinely stored — two records, not one id handed back twice —
    // and neither carries a passport for a later upsert to match on.
    const reloadedFirst = await getTravellerOrThrow(context, "rgs", first.travellerId);
    const reloadedSecond = await getTravellerOrThrow(context, "rgs", second.travellerId);
    expect(reloadedFirst.fullName).toBe("No Passport Person");
    expect(reloadedSecond.fullName).toBe("No Passport Person");
    expect(reloadedFirst.createdAt).toBe("2026-07-23T10:00:00.000Z");
    expect(reloadedSecond.createdAt).toBe("2026-07-23T10:00:01.000Z");
    expect(reloadedFirst.passportNumber).toBeUndefined();
    expect(reloadedSecond.passportNumber).toBeUndefined();
  });

  it("does not match a passport across tenants", async () => {
    const context = await buildTestContext();
    await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    expect(await findTravellerByPassport(context, "other-tenant", "Z6931368")).toBeUndefined();
  });

  it("normalizes names for the fuzzy fallback", () => {
    expect(normalizeTravellerName("  Umesh   Kumar  Yadav ")).toBe("UMESH KUMAR YADAV");
    expect(normalizeTravellerName("aman kapoor")).toBe("AMAN KAPOOR");
  });

  it("normalizes curly and straight apostrophes to the same value", () => {
    // Written as escapes, not literal characters: an editor that silently flattens
    // U+2019 to U+0027 would make both sides identical and the assertion vacuous.
    const curlyApostropheName = "D\u2019SOUZA";
    const straightApostropheName = "D\u0027SOUZA";

    // Guard: if this ever fails, the inputs collapsed and the test below proves nothing.
    expect(curlyApostropheName).not.toBe(straightApostropheName);

    expect(normalizeTravellerName(curlyApostropheName)).toBe(
      normalizeTravellerName(straightApostropheName),
    );
  });

  // --- A stored traveller that will not parse is a 409, never a raw 500. ---
  // Raw, the ZodError is not an ApiError, and router.ts maps only ApiError
  // subclasses — so every one of these reads answered 500. Each test asserts
  // the status code, not merely that something was thrown: `.rejects.toThrow()`
  // holds just as well for the ZodError this fix exists to remove.
  describe("a stored traveller record that no longer parses", () => {
    const CORRUPT_TRAVELLER_ID = "trv_half_written";

    it("surfaces as a typed 409 from the passport lookup", async () => {
      const context = await buildTestContext();
      await seedUnparseableTravellerItem(context, {
        travellerId: CORRUPT_TRAVELLER_ID,
        fullName: "Umesh Kumar Yadav",
        passportNumber: "Z6931368",
      });

      const passportLookup = findTravellerByPassport(context, "rgs", "Z6931368");
      await expect(passportLookup).rejects.toBeInstanceOf(CorruptRecordError);
      await expect(passportLookup).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
      // The id is what an operator repairs the row with, so it must be in the message.
      await expect(passportLookup).rejects.toThrow(CORRUPT_TRAVELLER_ID);
    });

    it("surfaces as a typed 409 from the fuzzy name lookup", async () => {
      const context = await buildTestContext();
      await seedUnparseableTravellerItem(context, {
        travellerId: CORRUPT_TRAVELLER_ID,
        fullName: "Umesh Kumar Yadav",
        passportNumber: "Z6931368",
      });

      const nameLookup = findTravellerByName(context, "rgs", "umesh kumar yadav");
      await expect(nameLookup).rejects.toBeInstanceOf(CorruptRecordError);
      await expect(nameLookup).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
      await expect(nameLookup).rejects.toThrow(CORRUPT_TRAVELLER_ID);
    });

    it("surfaces as a typed 409 from the single-traveller read, naming the bad field", async () => {
      const context = await buildTestContext();
      await seedUnparseableTravellerItem(context, {
        travellerId: CORRUPT_TRAVELLER_ID,
        fullName: "Umesh Kumar Yadav",
        passportNumber: "Z6931368",
      });

      const singleRead = getTravellerOrThrow(context, "rgs", CORRUPT_TRAVELLER_ID);
      await expect(singleRead).rejects.toBeInstanceOf(CorruptRecordError);
      await expect(singleRead).rejects.toMatchObject({
        statusCode: 409,
        code: "CORRUPT_RECORD",
      });
      // 409 and not 404: the record is on file, it is unreadable. A 404 would
      // tell an operator to re-create a traveller that already exists.
      await expect(singleRead).rejects.toThrow("fullName");
    });
  });

  it("throws a 404 for a traveller that does not exist", async () => {
    const context = await buildTestContext();
    await expect(getTravellerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

const TENANT_ID = "rgs";

describe("travellers on Postgres (SQL row assertions)", () => {
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
  });

  it("resolves case travellers by id, skipping unknown ones", async () => {
    const asha = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Verma", passportNumber: "N1234567" });
    const resolved = await resolveCaseTravellers(context, TENANT_ID, [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "trv_ghost", custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(resolved).toEqual({ [asha.travellerId]: { fullName: "Asha Verma", passportNumber: "N1234567" } });
  });
});
