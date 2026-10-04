import { COUNTRY_PRODUCTS, UnknownCountryProductError, getCountryProduct } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listActiveCountryConfig,
  listCountryConfig,
  resolveCountryProduct,
  seedCountryConfig,
  upsertCountryProduct,
} from "../src/domain/config";
import {
  listCountryProductsPostgres,
  upsertCountryProductPostgres,
} from "../src/domain/configCountryProductsPostgres";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, closeTestContexts, type TestContext } from "./helpers";

const uaeSeed = getCountryProduct("AE");

describe("country catalog", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
  });

  afterEach(closeTestContexts);

  it("lists the migrated seed catalog", async () => {
    const listing = await listCountryConfig(context);
    expect(listing.countryProducts).toHaveLength(COUNTRY_PRODUCTS.length);
    expect(listing.unreadableCountryProductIds).toEqual([]);
    const seededUae = listing.countryProducts.find((p) => p.productCode === uaeSeed.productCode);
    expect(seededUae).toEqual(uaeSeed);
  });

  it("does not fall back to the in-memory seed when the table is empty", async () => {
    await sql.query("delete from crm_country_products");
    expect(await listCountryConfig(context)).toEqual({
      countryProducts: [],
      unreadableCountryProductIds: [],
    });
  });

  it("upsert writes Postgres, shows in list", async () => {
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      governmentFeeInr: 7200,
    });
    const listing = await listCountryConfig(context);
    expect(listing.countryProducts).toHaveLength(COUNTRY_PRODUCTS.length);
    expect(
      listing.countryProducts.find((p) => p.productCode === uaeSeed.productCode)?.governmentFeeInr,
    ).toBe(7200);
  });

  it("upsert inserts a brand-new product", async () => {
    const created = await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      countryCode: "ZZ",
      productCode: "ZZ_DESK",
      countryName: "Desk Land",
      requiredDocuments: [...uaeSeed.requiredDocuments],
    });
    expect(created.productCode).toBe("ZZ_DESK");
    const resolved = await resolveCountryProduct(context, "ZZ", "ZZ_DESK");
    expect(resolved.countryName).toBe("Desk Land");
    expect(await listCountryConfig(context).then((l) => l.countryProducts)).toHaveLength(
      COUNTRY_PRODUCTS.length + 1,
    );
  });

  it("resolveCountryProduct finds an upserted row and rejects unknown ones", async () => {
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      serviceFeeInr: 1800,
    });
    expect((await resolveCountryProduct(context, "AE", uaeSeed.productCode)).serviceFeeInr).toBe(1800);
    await expect(resolveCountryProduct(context, "ZZ")).rejects.toBeInstanceOf(
      UnknownCountryProductError,
    );
  });

  it("listActiveCountryConfig filters inactive rows", async () => {
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      active: false,
    });
    const active = await listActiveCountryConfig(context);
    expect(active.countryProducts.find((p) => p.productCode === uaeSeed.productCode)).toBeUndefined();
  });

  it("names a corrupt row in unreadableCountryProductIds and serves the rest", async () => {
    await sql.query(`update crm_country_products set visa_type = 'BOGUS' where product_code = $1`, [
      uaeSeed.productCode,
    ]);
    const listing = await listCountryProductsPostgres(sql);
    expect(listing.unreadableCountryProductIds).toEqual([`AE#${uaeSeed.productCode}`]);
    expect(listing.countryProducts).toHaveLength(COUNTRY_PRODUCTS.length - 1);
  });

  it("upsertCountryProductPostgres is idempotent on (country, product)", async () => {
    await upsertCountryProductPostgres(sql, { ...uaeSeed, serviceFeeInr: 1 });
    await upsertCountryProductPostgres(sql, { ...uaeSeed, serviceFeeInr: 2 });
    const rows = await sql.query<{ n: number }>(
      `select count(*)::int as n from crm_country_products where product_code = $1`,
      [uaeSeed.productCode],
    );
    expect(rows.rows[0]?.n).toBe(1);
    const listing = await listCountryProductsPostgres(sql);
    expect(listing.countryProducts.find((p) => p.productCode === uaeSeed.productCode)?.serviceFeeInr).toBe(2);
  });

  it("seedCountryConfig returns 0 when migration already seeded", async () => {
    expect(await seedCountryConfig(context)).toBe(0);
  });

  it("seedCountryConfig re-inserts only a deleted row and keeps desk edits", async () => {
    await upsertCountryProduct(context, "admin_1", "admin@example.com", {
      ...uaeSeed,
      requiredDocuments: [...uaeSeed.requiredDocuments],
      governmentFeeInr: 7200,
    });
    const other = COUNTRY_PRODUCTS.find((p) => p.productCode !== uaeSeed.productCode);
    if (!other) throw new Error("need a second seed product");
    await sql.query(
      `delete from crm_country_products where country_code = $1 and product_code = $2`,
      [other.countryCode, other.productCode],
    );
    expect(await seedCountryConfig(context)).toBe(1);
    expect(await seedCountryConfig(context)).toBe(0);
    const listing = await listCountryConfig(context);
    expect(listing.countryProducts).toHaveLength(COUNTRY_PRODUCTS.length);
    expect(listing.countryProducts.find((p) => p.productCode === other.productCode)).toEqual(other);
    expect(
      listing.countryProducts.find((p) => p.productCode === uaeSeed.productCode)?.governmentFeeInr,
    ).toBe(7200);
  });
});
