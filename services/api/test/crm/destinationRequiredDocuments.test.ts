import { COUNTRY_PRODUCTS, type CountryProduct } from "@rgs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { upsertCountryProduct } from "../../src/domain/config";
import { labelsForDestinationCountry } from "../../src/domain/crm/destinationRequiredDocuments";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";

afterEach(closeSqlTestContexts);

const AE_BASE = COUNTRY_PRODUCTS.find((product) => product.countryCode === "AE")!;

async function putProduct(
  context: SqlTestContext,
  overrides: Partial<CountryProduct>,
): Promise<void> {
  await upsertCountryProduct(context, "admin_1", "admin@rgs.test", { ...AE_BASE, ...overrides });
}

describe("labelsForDestinationCountry", () => {
  it("returns the product's labels, including office-only rows", async () => {
    const context = await buildSqlTestContext();
    await putProduct(context, {
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Office form only" },
      ],
    });
    expect(await labelsForDestinationCountry(context, "AE")).toEqual([
      "Passport bio page",
      "Office form only",
    ]);
  });

  it("returns an empty list when the country has no product", async () => {
    expect(await labelsForDestinationCountry(await buildSqlTestContext(), "ZZ")).toEqual([]);
  });

  it("merges products: FULFILLED before INFO_ONLY, duplicates skipped, inactive ignored", async () => {
    const context = await buildSqlTestContext();
    await putProduct(context, {
      productCode: "AE_INFO",
      tier: "INFO_ONLY",
      requiredDocuments: [{ label: "passport " }, { label: "Info note" }],
    });
    await putProduct(context, {
      requiredDocuments: [
        { label: "Passport", portalDocType: "PASSPORT_BIO" },
        { label: "Photo" },
      ],
    });
    await putProduct(context, {
      productCode: "AE_OLD",
      active: false,
      requiredDocuments: [{ label: "Retired doc", portalDocType: "PASSPORT_BIO" }],
    });
    expect(await labelsForDestinationCountry(context, "AE")).toEqual([
      "Passport",
      "Photo",
      "Info note",
    ]);
  });

  it("falls back to inactive products when none is active", async () => {
    const context = await buildSqlTestContext();
    await putProduct(context, {
      active: false,
      requiredDocuments: [{ label: "Only doc", portalDocType: "PASSPORT_BIO" }],
    });
    expect(await labelsForDestinationCountry(context, "AE")).toEqual(["Only doc"]);
  });
});
