import { afterEach, describe, expect, it } from "vitest";
import { COUNTRY_PRODUCTS, getCountryProduct } from "@rgs/shared";
import { listRecentActivity } from "../src/domain/activity";
import { createDraft } from "../src/domain/applications";
import { presignDocumentUpload } from "../src/domain/documents";
import {
  listCountryConfig,
  resolveCountryProduct,
  seedCountryConfig,
  upsertCountryProduct,
} from "../src/domain/config";
import { buildTestContext, closeTestContexts } from "./helpers";

afterEach(closeTestContexts);

const uaeSeed = getCountryProduct("AE");

describe("listCountryConfig", () => {
  it("lists the migrated seed catalog on a fresh database", async () => {
    const context = await buildTestContext();
    const catalog = (await listCountryConfig(context)).countryProducts;
    expect(catalog).toHaveLength(COUNTRY_PRODUCTS.length);
    expect(catalog.map((product) => product.countryCode)).toContain("AE");
  });

  it("returns DB rows once config exists", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      governmentFeeInr: 7200,
    });
    const catalog = (await listCountryConfig(context)).countryProducts;
    const uaeFromDb = catalog.find((product) => product.countryCode === "AE");
    expect(uaeFromDb?.governmentFeeInr).toBe(7200);
  });
});

describe("upsertCountryProduct", () => {
  it("seeds the full catalog on first write so nothing vanishes", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      serviceFeeInr: 1800,
    });
    const catalog = (await listCountryConfig(context)).countryProducts;
    expect(catalog).toHaveLength(COUNTRY_PRODUCTS.length);
  });

  it("rejects invalid config (negative fee, unknown doc type)", async () => {
    const context = await buildTestContext();
    await expect(
      upsertCountryProduct(context, "admin_1", "admin@example.com", {
        ...uaeSeed,
        requiredDocuments: [...uaeSeed.requiredDocuments],
        governmentFeeInr: -5,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      upsertCountryProduct(context, "admin_1", "admin@example.com", {
        ...uaeSeed,
        requiredDocuments: [{ label: "Aadhaar", portalDocType: "AADHAAR_CARD" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("logs a CONFIG_CHANGED activity event", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      processingDays: 2,
    });
    const { events } = await listRecentActivity(context, 2, 50);
    expect(events.map((event) => event.eventType)).toContain("CONFIG_CHANGED");
  });
});

describe("seedCountryConfig", () => {
  it("is idempotent", async () => {
    const context = await buildTestContext();
    await context.sql.query("delete from crm_country_products");
    expect(await seedCountryConfig(context)).toBe(COUNTRY_PRODUCTS.length);
    expect(await seedCountryConfig(context)).toBe(0);
  });
});

describe("config drives pricing and document rules", () => {
  it("createDraft prices from the admin-edited config, not the code seed", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      governmentFeeInr: 9999,
      serviceFeeInr: 2001,
    });
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    expect(draft.amounts.governmentFeeInr).toBe(9999);
    expect(draft.amounts.serviceFeeInr).toBe(2001);
  });

  it("document checklist enforcement follows the admin-edited config", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Photo", portalDocType: "PHOTO" },
        { label: "Hotel booking", portalDocType: "HOTEL_BOOKING" },
      ],
    });
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
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
    const context = await buildTestContext();
    await expect(resolveCountryProduct(context, "XX")).rejects.toThrow(
      /No visa product configured/,
    );
  });
});
