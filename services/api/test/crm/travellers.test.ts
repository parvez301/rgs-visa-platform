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
    const first = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    const second = await upsertTraveller(context, "rgs", {
      fullName: "Aman Kapoor",
      passportNumber: "M1112223",
    });
    expect(second.travellerId).not.toBe(first.travellerId);
  });

  it("creates a new traveller each time when no passport is recorded", async () => {
    const context = buildTestContext();
    // 74% of workbook rows carry no passport number, so this path is the common one.
    const first = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    const second = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    expect(second.travellerId).not.toBe(first.travellerId);
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
