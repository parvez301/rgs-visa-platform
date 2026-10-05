import { CountryProductSchema, type CountryProduct } from "@rgs/shared";
import { corruptRecord } from "../lib/errors";
import type { SqlClient } from "../lib/sql";
import { candidateFromColumns, type DbRow } from "../lib/sqlColumns";
import { collectReadableRecords, describeFirstZodIssue } from "../lib/storedRecords";

/**
 * Postgres storage for the country catalog (`crm_country_products`, migration
 * 005), primary key `(country_code, product_code)`. Rows parse through the same
 * `CountryProductSchema`. The table is seeded by the
 * migration, so an empty table is a real (empty) catalog, not a cue to fall
 * back to the in-memory seed.
 */

const PRODUCT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["countryCode", "country_code"],
  ["productCode", "product_code"],
  ["countryName", "country_name"],
  ["visaType", "visa_type"],
  ["region", "region"],
  ["tier", "tier"],
  ["validityDays", "validity_days"],
  ["stayDays", "stay_days"],
  ["entry", "entry"],
  ["governmentFeeInr", "government_fee_inr"],
  ["serviceFeeInr", "service_fee_inr"],
  ["processingDays", "processing_days"],
  ["requiredDocuments", "required_documents"],
  ["active", "active"],
  ["officialUrl", "official_url"],
];

function rowId(productRow: DbRow): string {
  const countryCode = productRow["country_code"];
  const productCode = productRow["product_code"];
  if (typeof countryCode === "string" && typeof productCode === "string") {
    return `${countryCode}#${productCode}`;
  }
  return String(productCode ?? countryCode ?? "an unidentifiable row");
}

function rowToCountryProduct(productRow: DbRow): CountryProduct {
  const parsed = CountryProductSchema.safeParse(candidateFromColumns(productRow, PRODUCT_COLUMNS));
  if (parsed.success) return parsed.data;
  throw corruptRecord("Country product", rowId(productRow), describeFirstZodIssue(parsed.error));
}

/** Every catalog row; a row that will not parse is skipped and named. */
export async function listCountryProductsPostgres(
  sql: SqlClient,
): Promise<{ countryProducts: CountryProduct[]; unreadableCountryProductIds: string[] }> {
  const result = await sql.query<DbRow>(
    `select country_code, product_code, country_name, visa_type, region, tier,
            validity_days, stay_days, entry, government_fee_inr, service_fee_inr,
            processing_days, required_documents, active, official_url
       from crm_country_products
      order by country_code, product_code`,
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    rowToCountryProduct,
    { entityDescription: "country product" },
  );
  return { countryProducts: records, unreadableCountryProductIds: unreadableRecordIds };
}

const INSERT_PRODUCT_SQL = `insert into crm_country_products (
       country_code, product_code, country_name, visa_type, region, tier,
       validity_days, stay_days, entry, government_fee_inr, service_fee_inr,
       processing_days, required_documents, active, official_url
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)`;

function productParams(product: CountryProduct): unknown[] {
  return [
    product.countryCode,
    product.productCode,
    product.countryName,
    product.visaType,
    product.region,
    product.tier,
    product.validityDays,
    product.stayDays,
    product.entry,
    product.governmentFeeInr,
    product.serviceFeeInr,
    product.processingDays,
    JSON.stringify(product.requiredDocuments),
    product.active,
    product.officialUrl ?? null,
  ];
}

/** An upsert on the primary key. The caller has already validated the product. */
export async function upsertCountryProductPostgres(
  sql: SqlClient,
  product: CountryProduct,
): Promise<void> {
  await sql.query(
    `${INSERT_PRODUCT_SQL}
     on conflict (country_code, product_code) do update set
       country_name = excluded.country_name,
       visa_type = excluded.visa_type,
       region = excluded.region,
       tier = excluded.tier,
       validity_days = excluded.validity_days,
       stay_days = excluded.stay_days,
       entry = excluded.entry,
       government_fee_inr = excluded.government_fee_inr,
       service_fee_inr = excluded.service_fee_inr,
       processing_days = excluded.processing_days,
       required_documents = excluded.required_documents,
       active = excluded.active,
       official_url = excluded.official_url`,
    productParams(product),
  );
}

/**
 * Inserts the given seed products that have no row yet; existing rows (desk
 * edits included) are left untouched. Returns how many rows were newly inserted.
 */
export async function seedCountryProductsPostgres(
  sql: SqlClient,
  seedProducts: readonly CountryProduct[],
): Promise<number> {
  let insertedCount = 0;
  for (const seedProduct of seedProducts) {
    const result = await sql.query(
      `${INSERT_PRODUCT_SQL}
       on conflict (country_code, product_code) do nothing
       returning product_code`,
      productParams(seedProduct),
    );
    insertedCount += result.rows.length;
  }
  return insertedCount;
}
