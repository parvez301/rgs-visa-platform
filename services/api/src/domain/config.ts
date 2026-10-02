import {
  COUNTRY_PRODUCTS,
  CountryProductSchema,
  UnknownCountryProductError,
  requiredDocumentsFromLegacyDocTypes,
  type CountryProduct,
  type DocType,
} from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { badRequest, corruptRecord } from "../lib/errors";
import {
  listCountryProductsPostgres,
  upsertCountryProductPostgres,
} from "./configCountryProductsPostgres";
import { crmPostgresOf } from "./crm/postgresClient";
import {
  collectReadableRecords,
  describeFirstZodIssue,
  storedRecordId,
  stripStorageKeys,
} from "../lib/storedRecords";

const CONFIG_PARTITION_KEY = "CONFIG#COUNTRY";

function configSortKey(countryCode: string, productCode: string): string {
  return `${countryCode}#${productCode}`;
}

/**
 * Rows written before `requiredDocuments` existed carry `docsRequired` (portal
 * DocTypes) instead. Until the `migrate:country-documents-to-products` script
 * has run, read such a row as if it had been migrated: one checklist line per
 * legacy DocType. A row that already has a non-empty `requiredDocuments` wins,
 * and the legacy/read-time-only attributes are dropped either way so they never
 * reach the schema or the response.
 */
export function coerceLegacyCountryProduct(raw: Record<string, unknown>): unknown {
  if (Array.isArray(raw["requiredDocuments"]) && raw["requiredDocuments"].length > 0) {
    const {
      docsRequired: _legacyDocTypes,
      requiredDocumentLabels: _readTimeLabels,
      ...withoutLegacyAttributes
    } = raw;
    return withoutLegacyAttributes;
  }
  if (Array.isArray(raw["docsRequired"])) {
    const {
      docsRequired,
      requiredDocumentLabels: _readTimeLabels,
      ...withoutLegacyAttributes
    } = raw;
    return {
      ...withoutLegacyAttributes,
      requiredDocuments: requiredDocumentsFromLegacyDocTypes(docsRequired as DocType[]),
    };
  }
  const { docsRequired: _legacyDocTypes, requiredDocumentLabels: _readTimeLabels, ...rest } = raw;
  return { ...rest, requiredDocuments: raw["requiredDocuments"] ?? [] };
}

/**
 * The single place a stored row becomes a CountryProduct.
 *
 * This used to end in `throw directParse.error` — a bare ZodError, which
 * `router.ts` does not map — so one malformed CONFIG#COUNTRY row answered 500
 * from the admin catalog screen AND from `GET /api/v1/config/countries`,
 * which is unauthenticated and is what the marketing site and the portal read
 * their prices from. Typed as CorruptRecordError, the one bad row is skipped
 * and named while the rest of the catalog serves.
 */
function itemToCountryProduct(item: Record<string, unknown>): CountryProduct {
  const productAttributes = coerceLegacyCountryProduct(stripStorageKeys(item)) as Record<
    string,
    unknown
  >;
  const directParse = CountryProductSchema.safeParse(productAttributes);
  if (directParse.success) return directParse.data;
  // Schema evolution: rows written before newer fields existed are healed by
  // merging defaults from the code catalog; admin-edited values still win.
  const seedDefaults = COUNTRY_PRODUCTS.find(
    (seedProduct) => seedProduct.productCode === productAttributes["productCode"],
  );
  if (seedDefaults) {
    const hasStoredDocuments =
      Array.isArray(productAttributes["requiredDocuments"]) &&
      productAttributes["requiredDocuments"].length > 0;
    const mergedParse = CountryProductSchema.safeParse({
      ...seedDefaults,
      ...productAttributes,
      ...(hasStoredDocuments ? {} : { requiredDocuments: seedDefaults.requiredDocuments }),
    });
    if (mergedParse.success) return mergedParse.data;
  }
  throw corruptRecord(
    "Country product",
    storedRecordId(item, "productCode"),
    describeFirstZodIssue(directParse.error),
  );
}

export interface CountryConfigListing {
  countryProducts: CountryProduct[];
  /**
   * Catalog rows that could not be reassembled even after the seed-merge
   * heal. Named rather than merely absent: a country that silently drops out
   * of the catalog stops being sellable on the public site, and nothing else
   * would say why.
   */
  unreadableCountryProductIds: string[];
}

/**
 * Runtime catalog: DB rows when seeded, static code catalog as fallback.
 * The static catalog in @rgs/shared is the SEED — after deployment, admins
 * edit the DB copy and it wins everywhere (portal, API guards, pricing).
 */
export async function listCountryConfig(context: AppContext): Promise<CountryConfigListing> {
  const sql = crmPostgresOf(context);
  if (sql !== undefined) return listCountryProductsPostgres(sql);
  const configItems = await context.table.query(CONFIG_PARTITION_KEY);
  if (configItems.length === 0) {
    return { countryProducts: [...COUNTRY_PRODUCTS], unreadableCountryProductIds: [] };
  }
  const { records, unreadableRecordIds } = await collectReadableRecords(
    configItems,
    itemToCountryProduct,
    { entityDescription: "country product" },
  );
  return { countryProducts: records, unreadableCountryProductIds: unreadableRecordIds };
}

export async function listActiveCountryConfig(
  context: AppContext,
): Promise<CountryConfigListing> {
  const catalog = await listCountryConfig(context);
  return {
    countryProducts: catalog.countryProducts.filter((countryProduct) => countryProduct.active),
    unreadableCountryProductIds: catalog.unreadableCountryProductIds,
  };
}

export async function resolveCountryProduct(
  context: AppContext,
  countryCode: string,
  productCode?: string,
): Promise<CountryProduct> {
  const allProducts = (await listCountryConfig(context)).countryProducts;
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
  adminEmail: string,
  productInput: unknown,
): Promise<CountryProduct> {
  // Clients (and older admin builds) may still send the legacy or read-time
  // attributes; persist `requiredDocuments` only.
  const { docsRequired: _legacyDocTypes, requiredDocumentLabels: _readTimeLabels, ...sanitizedInput } =
    typeof productInput === "object" && productInput !== null
      ? (productInput as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const parseResult = CountryProductSchema.safeParse(sanitizedInput);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw badRequest(
      firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid country product",
    );
  }
  const countryProduct = parseResult.data;

  const sql = crmPostgresOf(context);
  if (sql !== undefined) {
    // Migration 005 seeds the table; no first-write seeding needed.
    await upsertCountryProductPostgres(sql, countryProduct);
  } else {
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
  }
  await logActivity(
    context,
    "CONFIG_CHANGED",
    adminId,
    undefined,
    {
      countryCode: countryProduct.countryCode,
      productCode: countryProduct.productCode,
      governmentFeeInr: countryProduct.governmentFeeInr,
      serviceFeeInr: countryProduct.serviceFeeInr,
      processingDays: countryProduct.processingDays,
      active: countryProduct.active,
    },
    { actorEmail: adminEmail, actorRole: "admin" },
  );
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
      requiredDocuments: seedProduct.requiredDocuments.map((requiredDocument) => ({
        ...requiredDocument,
      })),
    });
    seededCount += 1;
  }
  return seededCount;
}
