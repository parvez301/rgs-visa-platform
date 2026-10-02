import { COUNTRY_PRODUCTS, type CountryProduct } from "@rgs/shared";

export const MIGRATION_FILENAME = "005_crm_country_products.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies. Seed literals are built
// by sqlText, which swaps any ";" for chr(59) so the splitter stays safe.
//
// Country visa products: the catalog system of record. Seeded once from the
// COUNTRY_PRODUCTS constant, and only when the table is empty so desk edits are
// never overwritten on a later migration run.

/** Quote a string as a SQL literal, keeping semicolons out of the raw text. */
function sqlText(value: string): string {
  const escaped = value.replace(/'/g, "''");
  return `'${escaped.replace(/;/g, "' || chr(59) || '")}'`;
}

function seedRow(product: CountryProduct): string {
  return `(${[
    sqlText(product.countryCode),
    sqlText(product.productCode),
    sqlText(product.countryName),
    sqlText(product.visaType),
    sqlText(product.region),
    sqlText(product.tier),
    String(Math.trunc(product.validityDays)),
    String(Math.trunc(product.stayDays)),
    sqlText(product.entry),
    String(Math.trunc(product.governmentFeeInr)),
    String(Math.trunc(product.serviceFeeInr)),
    String(Math.trunc(product.processingDays)),
    `(${sqlText(JSON.stringify(product.requiredDocuments))})::jsonb`,
    product.active ? "true" : "false",
    product.officialUrl === undefined ? "null::text" : sqlText(product.officialUrl),
  ].join(", ")})`;
}

const SEED_VALUES = COUNTRY_PRODUCTS.map(seedRow).join(",\n  ");

export const MIGRATION_SQL = `
create table if not exists crm_country_products (
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  product_code text not null,
  country_name text not null,
  visa_type text not null,
  region text not null,
  tier text not null,
  validity_days integer not null check (validity_days > 0),
  stay_days integer not null check (stay_days > 0),
  entry text not null check (entry in ('SINGLE', 'MULTIPLE')),
  government_fee_inr integer not null check (government_fee_inr >= 0),
  service_fee_inr integer not null check (service_fee_inr >= 0),
  processing_days integer not null check (processing_days > 0),
  required_documents jsonb not null default '[]'::jsonb,
  active boolean not null,
  official_url text,
  primary key (country_code, product_code)
);

create index if not exists crm_country_products_active
  on crm_country_products (active);

insert into crm_country_products (
  country_code, product_code, country_name, visa_type, region, tier,
  validity_days, stay_days, entry, government_fee_inr, service_fee_inr,
  processing_days, required_documents, active, official_url
)
select
  country_code, product_code, country_name, visa_type, region, tier,
  validity_days, stay_days, entry, government_fee_inr, service_fee_inr,
  processing_days, required_documents, active, official_url
from (values
  ${SEED_VALUES}
) as seed(
  country_code, product_code, country_name, visa_type, region, tier,
  validity_days, stay_days, entry, government_fee_inr, service_fee_inr,
  processing_days, required_documents, active, official_url
)
where not exists (select 1 from crm_country_products limit 1);
`;
