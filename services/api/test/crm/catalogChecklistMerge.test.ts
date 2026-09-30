import { describe, expect, it } from "vitest";
import { getCountryProduct } from "@rgs/shared";
import { buildTestContext, type TestContext } from "../helpers";
import { listDestinationCountries } from "../../src/domain/crm/destinationCountries";
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

/**
 * Counts checklist gets and how many were in flight at once. Every wrapped get
 * yields before it answers, so a caller that awaits one before starting the
 * next can never reach an in-flight count above one.
 */
function trackChecklistGets(context: TestContext) {
  const tableGet = context.table.get.bind(context.table);
  const tracker = { total: 0, maxInFlight: 0 };
  let inFlight = 0;
  context.table.get = async (partitionKey: string, sortKey: string) => {
    if (!partitionKey.includes("#COUNTRY#")) return tableGet(partitionKey, sortKey);
    tracker.total += 1;
    inFlight += 1;
    tracker.maxInFlight = Math.max(tracker.maxInFlight, inFlight);
    try {
      await Promise.resolve();
      return await tableGet(partitionKey, sortKey);
    } finally {
      inFlight -= 1;
    }
  };
  return tracker;
}

describe("checklist lookup cost on the routes that pay it", () => {
  it("issues the public catalog's checklist gets concurrently", async () => {
    const context = buildTestContext();
    const tracker = trackChecklistGets(context);

    const listing = await listActiveCountryConfig(context);
    const distinctCountryCodes = new Set(
      listing.countryProducts.map((countryProduct) => countryProduct.countryCode),
    );

    // One get per distinct country, not per product, and all of them at once:
    // GET /api/v1/config/countries is unauthenticated and on the marketing
    // country page's first load, so ~30 serialised round trips land there.
    expect(tracker.total).toBe(distinctCountryCodes.size);
    expect(tracker.maxInFlight).toBe(tracker.total);
  });

  it("reads no checklists at all to build the destination picker", async () => {
    const context = buildTestContext();
    const tracker = trackChecklistGets(context);

    const destinations = await listDestinationCountries(context);

    // The picker wants codes and names. Routing it through the merge made the
    // Doc checklists list walk every country twice: once here, once to fetch
    // the checklists it actually wanted.
    expect(destinations.length).toBeGreaterThan(0);
    expect(tracker.total).toBe(0);
  });

  it("still omits inactive countries from the destination picker", async () => {
    const context = buildTestContext();
    const seedUae = getCountryProduct("AE");
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...seedUae,
      docsRequired: [...seedUae.docsRequired],
      active: false,
    });

    const destinations = await listDestinationCountries(context);
    expect(destinations.some((destination) => destination.countryCode === "AE")).toBe(false);
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
