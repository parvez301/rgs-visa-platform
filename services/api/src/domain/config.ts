import {
  COUNTRY_PRODUCTS,
  CountryProductSchema,
  UnknownCountryProductError,
  type CountryProduct,
} from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { badRequest } from "../lib/errors";

const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

function configSortKey(countryCode: string, productCode: string): string {
  return `${countryCode}#${productCode}`;
}

function itemToCountryProduct(item: Record<string, unknown>): CountryProduct {
  const { PK, SK, ...productAttributes } = item;
  const directParse = CountryProductSchema.safeParse(productAttributes);
  if (directParse.success) return directParse.data;
  // Schema evolution: rows written before newer fields existed are healed by
  // merging defaults from the code catalog; admin-edited values still win.
  const seedDefaults = COUNTRY_PRODUCTS.find(
    (seedProduct) => seedProduct.productCode === productAttributes["productCode"],
  );
  if (seedDefaults) {
    const mergedParse = CountryProductSchema.safeParse({
      ...seedDefaults,
      docsRequired: [...seedDefaults.docsRequired],
      ...productAttributes,
    });
    if (mergedParse.success) return mergedParse.data;
  }
  throw directParse.error;
}

/**
 * Runtime catalog: DB rows when seeded, static code catalog as fallback.
 * The static catalog in @rgs/shared is the SEED — after deployment, admins
 * edit the DB copy and it wins everywhere (portal, API guards, pricing).
 */
export async function listCountryConfig(context: AppContext): Promise<CountryProduct[]> {
  const configItems = await context.table.query(CONFIG_PARTITION_KEY);
  if (configItems.length === 0) return [...COUNTRY_PRODUCTS];
  return configItems.map(itemToCountryProduct);
}

export async function listActiveCountryConfig(context: AppContext): Promise<CountryProduct[]> {
  const allProducts = await listCountryConfig(context);
  return allProducts.filter((countryProduct) => countryProduct.active);
}

export async function resolveCountryProduct(
  context: AppContext,
  countryCode: string,
  productCode?: string,
): Promise<CountryProduct> {
  const allProducts = await listCountryConfig(context);
  const resolvedProduct = allProducts.find(
    (candidate) =>
      candidate.countryCode === countryCode &&
      (productCode === undefined || candidate.productCode === productCode),
  );
  if (!resolvedProduct) throw new UnknownCountryProductError(countryCode, productCode);
  return resolvedProduct;
}

export async function upsertCountryProduct(
  context: AppContext,
  adminId: string,
  productInput: unknown,
): Promise<CountryProduct> {
  const parseResult = CountryProductSchema.safeParse(productInput);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw badRequest(
      firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid country product",
    );
  }
  const countryProduct = parseResult.data;

  // First write on a fresh table: seed everything else so one edit
  // doesn't make the rest of the catalog vanish from DB reads.
  const existingItems = await context.table.query(CONFIG_PARTITION_KEY);
  if (existingItems.length === 0) {
    await seedCountryConfig(context);
  }

  await context.table.put({
    PK: CONFIG_PARTITION_KEY,
    SK: configSortKey(countryProduct.countryCode, countryProduct.productCode),
    ...countryProduct,
  });
  await logActivity(context, "CONFIG_CHANGED", adminId, undefined, {
    countryCode: countryProduct.countryCode,
    productCode: countryProduct.productCode,
    governmentFeeInr: countryProduct.governmentFeeInr,
    serviceFeeInr: countryProduct.serviceFeeInr,
    processingDays: countryProduct.processingDays,
    active: countryProduct.active,
  });
  return countryProduct;
}

/** Copies the static seed catalog into DB rows that don't exist yet. Idempotent. */
export async function seedCountryConfig(context: AppContext): Promise<number> {
  let seededCount = 0;
  for (const seedProduct of COUNTRY_PRODUCTS) {
    const sortKey = configSortKey(seedProduct.countryCode, seedProduct.productCode);
    const existingItem = await context.table.get(CONFIG_PARTITION_KEY, sortKey);
    if (existingItem) continue;
    await context.table.put({
      PK: CONFIG_PARTITION_KEY,
      SK: sortKey,
      ...seedProduct,
      docsRequired: [...seedProduct.docsRequired],
    });
    seededCount += 1;
  }
  return seededCount;
}
