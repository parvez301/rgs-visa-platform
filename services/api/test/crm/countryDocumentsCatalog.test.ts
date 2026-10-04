import { afterEach, describe, expect, it } from "vitest";
import { getCountryProduct } from "@rgs/shared";
import { buildTestContext, closeTestContexts } from "../helpers";
import { listDestinationCountries } from "../../src/domain/crm/destinationCountries";
import {
  coerceLegacyCountryProduct,
  listActiveCountryConfig,
  listCountryConfig,
  upsertCountryProduct,
} from "../../src/domain/config";

afterEach(closeTestContexts);

const ADMIN_ID = "admin_1";
const ADMIN_EMAIL = "admin@example.com";
const seedUae = getCountryProduct("AE");

describe("listActiveCountryConfig reads requiredDocuments straight from the product", () => {
  it("returns requiredDocuments labels from the product with no CRM merge", async () => {
    const context = await buildTestContext();
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

  it("omits inactive products", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, { ...seedUae, active: false });

    const listing = await listActiveCountryConfig(context);
    expect(listing.countryProducts.some((product) => product.countryCode === "AE")).toBe(false);
  });
});

describe("legacy docsRequired attributes", () => {
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

describe("destination picker", () => {
  it("still omits inactive countries from the destination picker", async () => {
    const context = await buildTestContext();
    await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, { ...seedUae, active: false });

    const destinations = await listDestinationCountries(context);
    expect(destinations.some((destination) => destination.countryCode === "AE")).toBe(false);
  });
});

describe("upsertCountryProduct with legacy or read-time attributes on the input", () => {
  it("neither persists docsRequired / requiredDocumentLabels nor returns them", async () => {
    const context = await buildTestContext();

    const upserted = await upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
      ...seedUae,
      docsRequired: ["PASSPORT_BIO"],
      requiredDocumentLabels: ["Leaked from public catalog"],
    });

    expect(upserted).not.toHaveProperty("docsRequired");
    expect(upserted).not.toHaveProperty("requiredDocumentLabels");
    expect(upserted.requiredDocuments).toEqual(seedUae.requiredDocuments);

    const listing = await listCountryConfig(context);
    const stored = listing.countryProducts.find((product) => product.countryCode === seedUae.countryCode);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("docsRequired");
    expect(stored).not.toHaveProperty("requiredDocumentLabels");
  });

  it("rejects an input that only carries the legacy docsRequired", async () => {
    const context = await buildTestContext();
    const { requiredDocuments: _dropped, ...withoutDocuments } = seedUae;

    await expect(
      upsertCountryProduct(context, ADMIN_ID, ADMIN_EMAIL, {
        ...withoutDocuments,
        docsRequired: ["PASSPORT_BIO"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
