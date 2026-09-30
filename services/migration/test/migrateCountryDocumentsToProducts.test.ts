import { describe, expect, it } from "vitest";
import {
  COUNTRY_PRODUCTS,
  DOC_TYPE_LABELS,
  requiredDocumentsFromLegacyDocTypes,
  type CountryProduct,
  type DocType,
} from "@rgs/shared";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { InMemoryDocumentStore } from "@rgs/api/src/lib/documentStore";
import { InMemoryEmailSender } from "@rgs/api/src/lib/email";
import type { AppContext } from "@rgs/api/src/lib/context";
import { listCountryConfig } from "@rgs/api/src/domain/config";
import { findCountryChecklist, putCountryChecklist } from "@rgs/api/src/domain/crm/countryChecklist";
import {
  migrateCountryDocumentsToProducts,
  parseCountryProductForMigration,
} from "../src/migrateCountryDocumentsToProducts";

const TENANT_ID = "rgs";
const ACTOR_EMAIL = "migration@raysglobalservices.com";
const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

function buildContext(): AppContext {
  return {
    table: new InMemoryTableClient(),
    documents: new InMemoryDocumentStore(),
    email: new InMemoryEmailSender(),
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-30T10:00:00.000Z"),
  };
}

function seedProduct(countryCode: string): CountryProduct {
  const product = COUNTRY_PRODUCTS.find((candidate) => candidate.countryCode === countryCode);
  if (product === undefined) throw new Error(`No seed product for ${countryCode}`);
  return product;
}

/** Writes a row the way pre-Task-1 code did: `docsRequired`, no `requiredDocuments`. */
async function putLegacyProduct(
  context: AppContext,
  countryCode: string,
  docsRequired: DocType[],
): Promise<CountryProduct> {
  const { requiredDocuments: _dropped, ...productFields } = seedProduct(countryCode);
  await context.table.put({
    PK: CONFIG_PARTITION_KEY,
    SK: `${countryCode}#${productFields.productCode}`,
    ...productFields,
    docsRequired,
  });
  return seedProduct(countryCode);
}

async function readRawProduct(context: AppContext, countryCode: string) {
  const storedItems = await context.table.query(CONFIG_PARTITION_KEY);
  const storedItem = storedItems.find((item) => item["countryCode"] === countryCode);
  if (storedItem === undefined) throw new Error(`No stored row for ${countryCode}`);
  return storedItem;
}

describe("migrateCountryDocumentsToProducts", () => {
  it("prefers checklist order and maps known labels to portalDocType", async () => {
    const context = buildContext();
    await putLegacyProduct(context, "AE", ["PASSPORT_BIO", "PHOTO"]);
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Custom letter", DOC_TYPE_LABELS.PASSPORT_BIO] },
      "desk@rgs.test",
    );

    const report = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    const ae = (await listCountryConfig(context)).countryProducts.find((p) => p.countryCode === "AE");
    expect(ae?.requiredDocuments).toEqual([
      { label: "Custom letter" },
      { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
    ]);
    expect(report).toEqual({
      productsUpdated: 1,
      productsSkippedAlreadyMigrated: 0,
      checklistLabelsMerged: 2,
    });
    expect(await readRawProduct(context, "AE")).not.toHaveProperty("docsRequired");
  });

  it("docsRequired-only countries become labeled rows with portalDocType", async () => {
    const context = buildContext();
    await putLegacyProduct(context, "AE", ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT"]);

    const report = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    const ae = (await listCountryConfig(context)).countryProducts.find((p) => p.countryCode === "AE");
    expect(ae?.requiredDocuments).toEqual(
      requiredDocumentsFromLegacyDocTypes(["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT"]),
    );
    expect(report).toEqual({
      productsUpdated: 1,
      productsSkippedAlreadyMigrated: 0,
      checklistLabelsMerged: 0,
    });
    expect(await readRawProduct(context, "AE")).not.toHaveProperty("docsRequired");
  });

  it("dedupes checklist labels case-insensitively, keeping the first spelling", async () => {
    const context = buildContext();
    await putLegacyProduct(context, "AE", ["PASSPORT_BIO"]);
    await putCountryChecklist(
      context,
      TENANT_ID,
      {
        countryCode: "AE",
        requiredDocuments: ["Custom letter", "passport BIO page", "custom LETTER", DOC_TYPE_LABELS.PASSPORT_BIO],
      },
      "desk@rgs.test",
    );

    const report = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    const ae = (await listCountryConfig(context)).countryProducts.find((p) => p.countryCode === "AE");
    expect(ae?.requiredDocuments).toEqual([
      { label: "Custom letter" },
      { label: "passport BIO page", portalDocType: "PASSPORT_BIO" },
    ]);
    expect(report.checklistLabelsMerged).toBe(2);
  });

  it("applies one country's checklist to every product of that country", async () => {
    const context = buildContext();
    const baseProduct = await putLegacyProduct(context, "AE", ["PASSPORT_BIO"]);
    const { requiredDocuments: _dropped, ...productFields } = baseProduct;
    await context.table.put({
      PK: CONFIG_PARTITION_KEY,
      SK: `AE#AE-SECOND`,
      ...productFields,
      productCode: "AE-SECOND",
      docsRequired: ["PHOTO"],
    });
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Custom letter"] },
      "desk@rgs.test",
    );

    const report = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    const aeProducts = (await listCountryConfig(context)).countryProducts.filter(
      (p) => p.countryCode === "AE",
    );
    expect(aeProducts).toHaveLength(2);
    for (const aeProduct of aeProducts) {
      expect(aeProduct.requiredDocuments).toEqual([{ label: "Custom letter" }]);
    }
    expect(report.productsUpdated).toBe(2);
    expect(report.checklistLabelsMerged).toBe(2);
  });

  it("is idempotent: a second run skips converted rows and changes nothing", async () => {
    const context = buildContext();
    await putLegacyProduct(context, "AE", ["PASSPORT_BIO", "PHOTO"]);
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Custom letter"] },
      "desk@rgs.test",
    );
    await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);
    const afterFirstRun = await readRawProduct(context, "AE");

    // A desk edit to the old checklist after migration must not be re-folded.
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Something else"] },
      "desk@rgs.test",
    );
    const secondReport = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    expect(secondReport).toEqual({
      productsUpdated: 0,
      productsSkippedAlreadyMigrated: 1,
      checklistLabelsMerged: 0,
    });
    expect(await readRawProduct(context, "AE")).toEqual(afterFirstRun);
  });

  it("does not delete checklist rows", async () => {
    const context = buildContext();
    await putLegacyProduct(context, "AE", ["PASSPORT_BIO"]);
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Custom letter"] },
      "desk@rgs.test",
    );

    await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);

    const checklist = await findCountryChecklist(context, TENANT_ID, "AE");
    expect(checklist?.requiredDocuments).toEqual(["Custom letter"]);
  });

  it("does nothing when the catalog was never seeded into the table", async () => {
    const context = buildContext();
    const report = await migrateCountryDocumentsToProducts(context, TENANT_ID, ACTOR_EMAIL);
    expect(report).toEqual({
      productsUpdated: 0,
      productsSkippedAlreadyMigrated: 0,
      checklistLabelsMerged: 0,
    });
  });
});

describe("parseCountryProductForMigration", () => {
  it("accepts the legacy shape and strips storage keys and docsRequired", () => {
    const parsed = parseCountryProductForMigration({
      PK: CONFIG_PARTITION_KEY,
      SK: "AE#AE-E-VISA",
      countryCode: "AE",
      productCode: "AE-E-VISA",
      docsRequired: ["PASSPORT_BIO"],
    });
    expect(parsed.legacyDocTypes).toEqual(["PASSPORT_BIO"]);
    expect(parsed.requiredDocuments).toBeUndefined();
    expect(parsed.attributes).toEqual({ countryCode: "AE", productCode: "AE-E-VISA" });
  });

  it("accepts the new shape", () => {
    const parsed = parseCountryProductForMigration({
      PK: CONFIG_PARTITION_KEY,
      SK: "AE#AE-E-VISA",
      countryCode: "AE",
      productCode: "AE-E-VISA",
      requiredDocuments: [{ label: "Custom letter" }],
    });
    expect(parsed.legacyDocTypes).toBeUndefined();
    expect(parsed.requiredDocuments).toEqual([{ label: "Custom letter" }]);
  });

  it("names the row when docsRequired holds an unknown doc type", () => {
    expect(() =>
      parseCountryProductForMigration({
        PK: CONFIG_PARTITION_KEY,
        SK: "AE#AE-E-VISA",
        countryCode: "AE",
        productCode: "AE-E-VISA",
        docsRequired: ["NOT_A_DOC"],
      }),
    ).toThrow(/AE#AE-E-VISA.*docsRequired/);
  });
});
