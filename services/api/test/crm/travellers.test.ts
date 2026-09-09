import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { CorruptRecordError } from "../../src/lib/errors";
import {
  META_SORT_KEY,
  passportGsi3Pk,
  travellerNameGsi2Pk,
  travellerPartitionKey,
} from "../../src/domain/crm/keys";
import {
  findTravellerByName,
  findTravellerByPassport,
  getTravellerOrThrow,
  normalizeTravellerName,
  upsertTraveller,
} from "../../src/domain/crm/travellers";

/**
 * Writes a traveller item that is indexed under every lookup a read goes
 * through, but whose body no longer satisfies CrmTravellerSchema — here the
 * normalizedName is gone. upsertTraveller cannot produce this; a half-written
 * row, a hand-repair, or an importer writing an older shape can.
 */
async function seedUnparseableTravellerItem(
  context: TestContext,
  options: { travellerId: string; fullName: string; passportNumber: string },
): Promise<void> {
  await context.table.put({
    PK: travellerPartitionKey("rgs", options.travellerId),
    SK: META_SORT_KEY,
    GSI2PK: travellerNameGsi2Pk("rgs", normalizeTravellerName(options.fullName)),
    GSI2SK: options.travellerId,
    GSI3PK: passportGsi3Pk("rgs", options.passportNumber),
    GSI3SK: options.travellerId,
    tenantId: "rgs",
    travellerId: options.travellerId,
    fullName: options.fullName,
    passportNumber: options.passportNumber,
    createdAt: "2026-07-23T10:00:00.000Z",
  });
}

describe("crm travellers", () => {
  it("creates a traveller and indexes the passport", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
    // buildLookupKey trims "   " to "", which no schema accepts. Unwrapped, the
    // ZodError escapes the router's ApiError mapping and becomes a 500.
    await expect(upsertTraveller(context, "rgs", { fullName: "   " })).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
  });

  it("creates separate travellers when the passport differs", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
      const context = buildTestContext();
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
      const context = buildTestContext();
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
      const context = buildTestContext();
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
      await expect(singleRead).rejects.toThrow("normalizedName");
    });

    it("names an unreadable row by its storage key when the body lost its travellerId", async () => {
      const context = buildTestContext();
      const partitionKey = travellerPartitionKey("rgs", "trv_lost_its_id");
      await context.table.put({
        PK: partitionKey,
        SK: META_SORT_KEY,
        tenantId: "rgs",
        fullName: "Umesh Kumar Yadav",
        createdAt: "2026-07-23T10:00:00.000Z",
      });

      // String(item.travellerId) would report the literal id "undefined", which
      // finds no row at all. The storage key is the handle that still works.
      await expect(
        getTravellerOrThrow(context, "rgs", "trv_lost_its_id"),
      ).rejects.toThrow(partitionKey);
    });
  });

  it("throws a 404 for a traveller that does not exist", async () => {
    const context = buildTestContext();
    await expect(getTravellerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
