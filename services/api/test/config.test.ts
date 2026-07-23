import { describe, expect, it } from "vitest";
import { COUNTRY_PRODUCTS, getCountryProduct } from "@rgs/shared";
import { createDraft } from "../src/domain/applications";
import { presignDocumentUpload } from "../src/domain/documents";
import {
  listCountryConfig,
  resolveCountryProduct,
  seedCountryConfig,
  upsertCountryProduct,
} from "../src/domain/config";
import { buildTestContext } from "./helpers";

const uaeSeed = getCountryProduct("AE");

describe("listCountryConfig", () => {
  it("falls back to the static seed catalog when DB is empty", async () => {
    const context = buildTestContext();
    const catalog = await listCountryConfig(context);
    expect(catalog).toHaveLength(COUNTRY_PRODUCTS.length);
    expect(catalog.map((product) => product.countryCode)).toContain("AE");
  });

  it("returns DB rows once config exists", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, "admin_1", {
      ...uaeSeed,
      docsRequired: [...uaeSeed.docsRequired],
      governmentFeeInr: 7200,
    });
    const catalog = await listCountryConfig(context);
    const uaeFromDb = catalog.find((product) => product.countryCode === "AE");
    expect(uaeFromDb?.governmentFeeInr).toBe(7200);
  });
});

describe("upsertCountryProduct", () => {
  it("seeds the full catalog on first write so nothing vanishes", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, "admin_1", {
      ...uaeSeed,
      docsRequired: [...uaeSeed.docsRequired],
      serviceFeeInr: 1800,
    });
    const catalog = await listCountryConfig(context);
    expect(catalog).toHaveLength(COUNTRY_PRODUCTS.length);
  });

  it("rejects invalid config (negative fee, unknown doc type)", async () => {
    const context = buildTestContext();
    await expect(
      upsertCountryProduct(context, "admin_1", {
        ...uaeSeed,
        docsRequired: [...uaeSeed.docsRequired],
        governmentFeeInr: -5,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      upsertCountryProduct(context, "admin_1", {
        ...uaeSeed,
        docsRequired: ["AADHAAR_CARD"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("logs a CONFIG_CHANGED activity event", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, "admin_1", {
      ...uaeSeed,
      docsRequired: [...uaeSeed.docsRequired],
      processingDays: 2,
    });
    const dayEvents = await context.table.query("EVENT#2026-07-23");
    expect(dayEvents.map((eventItem) => eventItem["eventType"])).toContain("CONFIG_CHANGED");
  });
});

describe("seedCountryConfig", () => {
  it("is idempotent", async () => {
    const context = buildTestContext();
    expect(await seedCountryConfig(context)).toBe(COUNTRY_PRODUCTS.length);
    expect(await seedCountryConfig(context)).toBe(0);
  });
});

describe("config drives pricing and document rules", () => {
  it("createDraft prices from the admin-edited config, not the code seed", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, "admin_1", {
      ...uaeSeed,
      docsRequired: [...uaeSeed.docsRequired],
      governmentFeeInr: 9999,
      serviceFeeInr: 2001,
    });
    const draft = await createDraft(context, "user_1", "AE");
    expect(draft.amounts.governmentFeeInr).toBe(9999);
    expect(draft.amounts.serviceFeeInr).toBe(2001);
  });

  it("document checklist enforcement follows the admin-edited config", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, "admin_1", {
      ...uaeSeed,
      docsRequired: ["PASSPORT_BIO", "PHOTO", "HOTEL_BOOKING"],
    });
    const draft = await createDraft(context, "user_1", "AE");
    const presignResult = await presignDocumentUpload(
      context,
      "user_1",
      draft.applicationId,
      "HOTEL_BOOKING",
      0,
      "application/pdf",
    );
    expect(presignResult.objectKey).toContain("HOTEL_BOOKING");
  });

  it("resolveCountryProduct throws for unknown countries", async () => {
    const context = buildTestContext();
    await expect(resolveCountryProduct(context, "XX")).rejects.toThrow(
      /No visa product configured/,
    );
  });
});
