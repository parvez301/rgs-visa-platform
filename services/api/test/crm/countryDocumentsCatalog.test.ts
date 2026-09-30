import { describe, expect, it } from "vitest";
import { getCountryProduct } from "@rgs/shared";
import { buildTestContext, type TestContext } from "../helpers";
import { listDestinationCountries } from "../../src/domain/crm/destinationCountries";
import {
  coerceLegacyCountryProduct,
  listActiveCountryConfig,
  listCountryConfig,
  upsertCountryProduct,
} from "../../src/domain/config";
import {
  DEFAULT_TENANT_ID,
  META_SORT_KEY,
  countryChecklistPartitionKey,
} from "../../src/domain/crm/keys";

const ADMIN_ID = "admin_1";
const ADMIN_EMAIL = "admin@example.com";
const seedUae = getCountryProduct("AE");

describe("listActiveCountryConfig reads requiredDocuments straight from the product", () => {
  it("returns requiredDocuments labels from the product with no CRM merge", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...seedUae,
      requiredDocuments: [{ label: "Emirates ID copy" }, { label: "Photo", portalDocType: "PHOTO" }],
    });

    const listing = await listActiveCountryConfig(context);
    const uaeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(uaeProduct?.requiredDocuments.map((document) => document.label)).toEqual([
      "Emirates ID copy",
      "Photo",
    ]);
    expect(uaeProduct).not.toHaveProperty("requiredDocumentLabels");
  });

  it("ignores a CRM country checklist row for the same country", async () => {
    const context = buildTestContext();
    await context.table.put({
      PK: countryChecklistPartitionKey(DEFAULT_TENANT_ID, "AE"),
      SK: META_SORT_KEY,
      countryCode: "AE",
      requiredDocuments: ["Should never surface"],
    });

    const listing = await listActiveCountryConfig(context);
    const uaeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(uaeProduct?.requiredDocuments).toEqual(seedUae.requiredDocuments);
    expect(uaeProduct).not.toHaveProperty("requiredDocumentLabels");
  });

  it("omits inactive products", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, { ...seedUae, active: false });

    const listing = await listActiveCountryConfig(context);
    expect(listing.countryProducts.some((product) => product.countryCode === "AE")).toBe(false);
  });
});

describe("legacy docsRequired rows", () => {
  it("coerces a legacy docsRequired-only row on read until migrate runs", async () => {
    const context = buildTestContext();
    const { requiredDocuments: _dropped, ...withoutDocuments } = seedUae;
    await context.table.put({
      PK: "CONFIG#COUNTRY",
      SK: `AE#${seedUae.productCode}`,
      ...withoutDocuments,
      docsRequired: ["PASSPORT_BIO", "PHOTO"],
    });

    const listing = await listCountryConfig(context);
    const uaeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(uaeProduct?.requiredDocuments).toEqual([
      { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
      { label: "Passport-size photo", portalDocType: "PHOTO" },
    ]);
    expect(uaeProduct).not.toHaveProperty("docsRequired");
    expect(listing.unreadableCountryProductIds).toEqual([]);
  });

  it("prefers a non-empty requiredDocuments over a leftover docsRequired", () => {
    const coerced = coerceLegacyCountryProduct({
      ...seedUae,
      docsRequired: ["BANK_STATEMENT"],
      requiredDocumentLabels: ["stale"],
    });
    expect(coerced).not.toHaveProperty("docsRequired");
    expect(coerced).not.toHaveProperty("requiredDocumentLabels");
    expect(coerced).toHaveProperty("requiredDocuments", seedUae.requiredDocuments);
  });

  it("defaults to an empty checklist when a row has neither attribute", () => {
    const { requiredDocuments: _dropped, ...withoutDocuments } = seedUae;
    expect(coerceLegacyCountryProduct(withoutDocuments)).toHaveProperty("requiredDocuments", []);
  });
});

/** Counts CRM country-checklist gets. The catalog must no longer issue any. */
function trackChecklistGets(context: TestContext) {
  const tableGet = context.table.get.bind(context.table);
  const tracker = { total: 0 };
  context.table.get = async (partitionKey: string, sortKey: string) => {
    if (partitionKey.includes("#COUNTRY#")) tracker.total += 1;
    return tableGet(partitionKey, sortKey);
  };
  return tracker;
}

describe("catalog read cost", () => {
  it("reads no CRM checklists to build the public catalog", async () => {
    const context = buildTestContext();
    const tracker = trackChecklistGets(context);

    const listing = await listActiveCountryConfig(context);

    expect(listing.countryProducts.length).toBeGreaterThan(0);
    expect(tracker.total).toBe(0);
  });

  it("reads no CRM checklists to build the destination picker", async () => {
    const context = buildTestContext();
    const tracker = trackChecklistGets(context);

    const destinations = await listDestinationCountries(context);

    expect(destinations.length).toBeGreaterThan(0);
    expect(tracker.total).toBe(0);
  });

  it("still omits inactive countries from the destination picker", async () => {
    const context = buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, { ...seedUae, active: false });

    const destinations = await listDestinationCountries(context);
    expect(destinations.some((destination) => destination.countryCode === "AE")).toBe(false);
  });
});

describe("upsertCountryProduct with legacy or read-time attributes on the input", () => {
  it("neither persists docsRequired / requiredDocumentLabels nor returns them", async () => {
    const context = buildTestContext();

    const upserted = await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...seedUae,
      docsRequired: ["PASSPORT_BIO"],
      requiredDocumentLabels: ["Leaked from public catalog"],
    });

    expect(upserted).not.toHaveProperty("docsRequired");
    expect(upserted).not.toHaveProperty("requiredDocumentLabels");
    expect(upserted.requiredDocuments).toEqual(seedUae.requiredDocuments);

    const storedRows = await context.table.query("CONFIG#COUNTRY");
    expect(storedRows.length).toBeGreaterThan(0);
    for (const row of storedRows) {
      expect(row).not.toHaveProperty("docsRequired");
      expect(row).not.toHaveProperty("requiredDocumentLabels");
    }
  });

  it("rejects an input that only carries the legacy docsRequired", async () => {
    const context = buildTestContext();
    const { requiredDocuments: _dropped, ...withoutDocuments } = seedUae;

    await expect(
      upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
        ...withoutDocuments,
        docsRequired: ["PASSPORT_BIO"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
