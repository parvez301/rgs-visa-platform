import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import {
  findTravellerByPassport,
  getTravellerOrThrow,
  normalizeTravellerName,
  upsertTraveller,
} from "../../src/domain/crm/travellers";

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

  it("throws a 404 for a traveller that does not exist", async () => {
    const context = buildTestContext();
    await expect(getTravellerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
