import { describe, expect, it } from "vitest";
import { getCountryProduct } from "@rgs/shared";
import { buildTestContext } from "../helpers";
import {
  listActiveCountryConfig,
  listCountryConfig,
  upsertCountryProduct,
} from "../../src/domain/config";
import { putCountryChecklist } from "../../src/domain/crm/countryChecklist";
import {
  DEFAULT_TENANT_ID,
  META_SORT_KEY,
  countryChecklistPartitionKey,
} from "../../src/domain/crm/keys";

const ACTOR = "ops@rgs.test";

describe("listActiveCountryConfig CRM checklist merge", () => {
  it("prefers CRM country checklist labels on the public catalog product", async () => {
    const context = buildTestContext();
    await putCountryChecklist(
      context,
      DEFAULT_TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Passport bio page", "Photo"] },
      ACTOR,
    );

    const listing = await listActiveCountryConfig(context);
    const aeProducts = listing.countryProducts.filter((product) => product.countryCode === "AE");
    expect(aeProducts.length).toBeGreaterThan(0);
    for (const aeProduct of aeProducts) {
      expect(aeProduct.requiredDocumentLabels).toEqual(["Passport bio page", "Photo"]);
    }
  });

  it("omits labels when no CRM checklist exists, leaving docsRequired for the fallback", async () => {
    const context = buildTestContext();

    const listing = await listActiveCountryConfig(context);
    const aeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(aeProduct).toBeDefined();
    expect(aeProduct?.requiredDocumentLabels ?? []).toEqual([]);
    expect(aeProduct?.docsRequired).toEqual(getCountryProduct("AE").docsRequired);
  });

  it("omits labels when the CRM checklist is empty", async () => {
    const context = buildTestContext();
    await putCountryChecklist(
      context,
      DEFAULT_TENANT_ID,
      { countryCode: "AE", requiredDocuments: [] },
      ACTOR,
    );

    const listing = await listActiveCountryConfig(context);
    const aeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(aeProduct?.requiredDocumentLabels ?? []).toEqual([]);
  });

  it("does not write checklist labels into the Config catalog", async () => {
    const context = buildTestContext();
    await putCountryChecklist(
      context,
      DEFAULT_TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Passport bio page"] },
      ACTOR,
    );

    await listActiveCountryConfig(context);
    const adminCatalog = await listCountryConfig(context);
    for (const product of adminCatalog.countryProducts) {
      expect(product.requiredDocumentLabels).toBeUndefined();
    }
  });
});

describe("listActiveCountryConfig with a damaged checklist row", () => {
  it("still serves the catalog and falls back for that country", async () => {
    const context = buildTestContext();
    await context.table.put({
      PK: countryChecklistPartitionKey(DEFAULT_TENANT_ID, "AE"),
      SK: META_SORT_KEY,
      countryCode: "AE",
      requiredDocuments: "not-an-array",
    });

    const listing = await listActiveCountryConfig(context);
    const aeProduct = listing.countryProducts.find((product) => product.countryCode === "AE");
    expect(aeProduct).toBeDefined();
    expect(aeProduct?.requiredDocumentLabels).toBeUndefined();
  });
});

describe("upsertCountryProduct with read-time labels on the input", () => {
  it("neither persists requiredDocumentLabels nor returns it", async () => {
    const context = buildTestContext();
    const seedUae = getCountryProduct("AE");

    const upserted = await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...seedUae,
      docsRequired: [...seedUae.docsRequired],
      requiredDocumentLabels: ["Leaked from public catalog"],
    });

    expect(upserted.requiredDocumentLabels).toBeUndefined();
    expect("requiredDocumentLabels" in upserted).toBe(false);

    const storedRow = await context.table.get("CONFIG#COUNTRY", `AE#${seedUae.productCode}`);
    expect(storedRow).toBeDefined();
    expect(storedRow).not.toHaveProperty("requiredDocumentLabels");

    const storedRows = await context.table.query("CONFIG#COUNTRY");
    for (const row of storedRows) {
      expect(row).not.toHaveProperty("requiredDocumentLabels");
    }
  });
});
