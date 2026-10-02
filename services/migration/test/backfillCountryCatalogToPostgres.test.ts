import { PGlite } from "@electric-sql/pglite";
import { COUNTRY_PRODUCTS, DOC_TYPE_LABELS, type CountryProduct, type DocType } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { listCountryConfig } from "@rgs/api/src/domain/config";
import { listCountryProductsPostgres } from "@rgs/api/src/domain/configCountryProductsPostgres";
import { META_SORT_KEY, countryChecklistPartitionKey } from "@rgs/api/src/domain/crm/keys";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { buildTestContext, type TestContext } from "@rgs/api/test/helpers";
import { pgliteAsSqlClient } from "@rgs/api/test/pgliteSqlClient";
import { backfillCountryCatalogToPostgres } from "../src/backfillCountryCatalogToPostgres";

const TENANT_ID = "rgs";
const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

function seedProduct(countryCode: string): CountryProduct {
  const product = COUNTRY_PRODUCTS.find((candidate) => candidate.countryCode === countryCode);
  if (product === undefined) throw new Error(`No seed product for ${countryCode}`);
  return product;
}

function sortKeyOf(product: CountryProduct): string {
  return `${product.countryCode}#${product.productCode}`;
}

async function putProduct(context: TestContext, product: CountryProduct): Promise<void> {
  await context.table.put({ PK: CONFIG_PARTITION_KEY, SK: sortKeyOf(product), ...product });
}

/** A row the way pre-requiredDocuments code wrote it: `docsRequired`, no `requiredDocuments`. */
async function putLegacyProduct(
  context: TestContext,
  countryCode: string,
  docsRequired: DocType[],
): Promise<void> {
  const { requiredDocuments: _dropped, ...fields } = seedProduct(countryCode);
  await context.table.put({ PK: CONFIG_PARTITION_KEY, SK: `${countryCode}#${fields.productCode}`, ...fields, docsRequired });
}

/** A leftover Dynamo checklist row, written raw: nothing in production writes these any more. */
async function putChecklist(
  context: TestContext,
  tenantId: string,
  input: { countryCode: string; requiredDocuments: string[] },
  updatedBy: string,
): Promise<void> {
  await context.table.put({
    PK: countryChecklistPartitionKey(tenantId, input.countryCode),
    SK: META_SORT_KEY,
    ...input,
    updatedAt: "2026-09-30T10:00:00.000Z",
    updatedBy,
  });
}

async function postgresProduct(sql: SqlClient, countryCode: string): Promise<CountryProduct | undefined> {
  const { countryProducts } = await listCountryProductsPostgres(sql);
  return countryProducts.find((candidate) => candidate.countryCode === countryCode);
}

describe("backfillCountryCatalogToPostgres", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(() => {
    sql = pgliteAsSqlClient(new PGlite());
    context = buildTestContext();
  });

  it("applies the migrations itself, including 005, before copying anything", async () => {
    await backfillCountryCatalogToPostgres({ table: context.table, sql });

    const migrations = await sql.query<{ filename: string }>(`select filename from schema_migrations`);
    expect(migrations.rows.map((row) => row.filename)).toContain("005_crm_country_products.sql");
  });

  it("copies Dynamo rows so the desk's edit beats the migration seed and a Postgres read matches Dynamo", async () => {
    const edited: CountryProduct = { ...seedProduct("AE"), governmentFeeInr: 98765, active: false };
    await putProduct(context, edited);

    const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

    expect(result).toEqual({
      productsUpserted: 1,
      checklistCountriesMerged: 0,
      unreadableProductIds: [],
      unreadableChecklistCountryCodes: [],
    });
    expect(await postgresProduct(sql, "AE")).toEqual(edited);
    const fromDynamo = (await listCountryConfig(context)).countryProducts.find((p) => p.countryCode === "AE");
    expect(await postgresProduct(sql, "AE")).toEqual(fromDynamo);
    // Rows Dynamo never held keep the migration seed.
    const untouched = COUNTRY_PRODUCTS.find((p) => p.countryCode !== "AE");
    expect(untouched).toBeDefined();
    expect(await postgresProduct(sql, untouched!.countryCode)).toEqual(untouched);
  });

  it("is idempotent: a second run reports and stores the same thing", async () => {
    await putProduct(context, { ...seedProduct("AE"), serviceFeeInr: 4321 });
    await putLegacyProduct(context, "SG", ["PASSPORT_BIO"]);
    await putChecklist(
      context,
      TENANT_ID,
      { countryCode: "SG", requiredDocuments: ["Custom letter", DOC_TYPE_LABELS.PASSPORT_BIO] },
      "desk@rgs.test",
    );

    const first = await backfillCountryCatalogToPostgres({ table: context.table, sql });
    const rowsAfterFirst = (await listCountryProductsPostgres(sql)).countryProducts;
    const second = await backfillCountryCatalogToPostgres({ table: context.table, sql });

    expect(second).toEqual(first);
    expect((await listCountryProductsPostgres(sql)).countryProducts).toEqual(rowsAfterFirst);
    expect(first.productsUpserted).toBe(2);
  });

  it("names a corrupt product as countryCode#productCode and still copies the rest", async () => {
    await context.table.put({
      PK: CONFIG_PARTITION_KEY,
      SK: "ZZ#ZZ-BROKEN",
      countryCode: "ZZ",
      productCode: "ZZ-BROKEN",
      governmentFeeInr: "not a number",
    });
    await putProduct(context, { ...seedProduct("AE"), governmentFeeInr: 11111 });

    const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

    expect(result.unreadableProductIds).toEqual(["ZZ#ZZ-BROKEN"]);
    expect(result.productsUpserted).toBe(1);
    expect((await postgresProduct(sql, "AE"))?.governmentFeeInr).toBe(11111);
    expect(await postgresProduct(sql, "ZZ")).toBeUndefined();
  });

  it("names a row with no countryCode/productCode by its storage key", async () => {
    await context.table.put({ PK: CONFIG_PARTITION_KEY, SK: "mystery", visaType: "TOURIST" });

    const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

    expect(result.unreadableProductIds).toEqual(["mystery"]);
    expect(result.productsUpserted).toBe(0);
  });

  describe("checklist fold", () => {
    it("folds checklist labels into a legacy row, same as the retired Dynamo migration stored", async () => {
      await putLegacyProduct(context, "AE", ["PASSPORT_BIO", "PHOTO"]);
      await putChecklist(
        context,
        TENANT_ID,
        { countryCode: "AE", requiredDocuments: ["Custom letter", DOC_TYPE_LABELS.PASSPORT_BIO, "custom letter"] },
        "desk@rgs.test",
      );

      const { requiredDocuments: _legacyBaseline, ...aeFields } = seedProduct("AE");
      const expected: CountryProduct = {
        ...aeFields,
        requiredDocuments: [
          { label: "Custom letter" },
          { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
        ],
      };

      const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

      expect(result.checklistCountriesMerged).toBe(1);
      expect(result.unreadableChecklistCountryCodes).toEqual([]);
      const stored = await postgresProduct(sql, "AE");
      expect(stored?.requiredDocuments).toEqual([
        { label: "Custom letter" },
        { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
      ]);
      expect(stored).toEqual(expected);
    });

    it("fills a converted row whose documents are empty, but leaves one that already has documents", async () => {
      const aeBase = seedProduct("AE");
      const sgBase = seedProduct("SG");
      await putProduct(context, { ...aeBase, active: false, requiredDocuments: [] });
      await putProduct(context, { ...sgBase, requiredDocuments: [{ label: "Desk edit" }] });
      for (const countryCode of ["AE", "SG"]) {
        await putChecklist(
          context,
          TENANT_ID,
          { countryCode, requiredDocuments: [DOC_TYPE_LABELS.PASSPORT_BIO] },
          "desk@rgs.test",
        );
      }

      const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

      expect(result.checklistCountriesMerged).toBe(1);
      expect((await postgresProduct(sql, "AE"))?.requiredDocuments).toEqual([
        { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
      ]);
      expect((await postgresProduct(sql, "SG"))?.requiredDocuments).toEqual([{ label: "Desk edit" }]);
    });

    it("names the country and keeps the product unmerged when the merged result would be invalid", async () => {
      // AE is fulfilled: a free-text-only checklist leaves it with no portal-collectable document.
      await putProduct(context, { ...seedProduct("AE"), requiredDocuments: [] });
      await putChecklist(
        context,
        TENANT_ID,
        { countryCode: "AE", requiredDocuments: ["Free text only"] },
        "desk@rgs.test",
      );

      const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

      expect(result.unreadableChecklistCountryCodes).toEqual(["AE"]);
      expect(result.checklistCountriesMerged).toBe(0);
      expect(result.productsUpserted).toBe(1);
      expect((await postgresProduct(sql, "AE"))?.requiredDocuments).not.toContainEqual({ label: "Free text only" });
    });

    it("names a country with a corrupt checklist, skips its merge, and still copies the product", async () => {
      await putLegacyProduct(context, "AE", ["PASSPORT_BIO"]);
      await context.table.put({
        PK: countryChecklistPartitionKey(TENANT_ID, "AE"),
        SK: META_SORT_KEY,
        countryCode: "AE",
        requiredDocuments: "not a list",
      });

      const result = await backfillCountryCatalogToPostgres({ table: context.table, sql });

      expect(result.unreadableChecklistCountryCodes).toEqual(["AE"]);
      expect(result.checklistCountriesMerged).toBe(0);
      expect(result.productsUpserted).toBe(1);
      expect((await postgresProduct(sql, "AE"))?.requiredDocuments).toEqual([
        { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
      ]);
    });
  });
});
