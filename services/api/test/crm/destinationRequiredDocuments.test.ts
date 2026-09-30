import { COUNTRY_PRODUCTS, type CountryProduct } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { upsertCountryProduct } from "../../src/domain/config";
import { labelsForDestinationCountry } from "../../src/domain/crm/destinationRequiredDocuments";
import { buildTestContext } from "../helpers";

const AE_BASE = COUNTRY_PRODUCTS.find((product) => product.countryCode === "AE")!;

async function putProduct(
  context: ReturnType<typeof buildTestContext>,
  overrides: Partial<CountryProduct>,
): Promise<void> {
  await upsertCountryProduct(context, "admin_1", "admin@rgs.test", { ...AE_BASE, ...overrides });
}

describe("labelsForDestinationCountry", () => {
  it("returns the product's labels, including office-only rows", async () => {
    const context = buildTestContext();
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
    expect(await labelsForDestinationCountry(buildTestContext(), "ZZ")).toEqual([]);
  });

  it("merges products: FULFILLED before INFO_ONLY, duplicates skipped, inactive ignored", async () => {
    const context = buildTestContext();
    await putProduct(context, {
      productCode: "AE_INFO",
      tier: "INFO_ONLY",
      requiredDocuments: [{ label: "passport " }, { label: "Info note" }],
    });
    await putProduct(context, {
      requiredDocuments: [{ label: "Passport" }, { label: "Photo" }],
    });
    await putProduct(context, {
      productCode: "AE_OLD",
      active: false,
      requiredDocuments: [{ label: "Retired doc" }],
    });
    expect(await labelsForDestinationCountry(context, "AE")).toEqual([
      "Passport",
      "Photo",
      "Info note",
    ]);
  });

  it("falls back to inactive products when none is active", async () => {
    const context = buildTestContext();
    await putProduct(context, { active: false, requiredDocuments: [{ label: "Only doc" }] });
    expect(await labelsForDestinationCountry(context, "AE")).toEqual(["Only doc"]);
  });
});
