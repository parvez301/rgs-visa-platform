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
import { badRequest } from "../lib/errors";
import {
  listCountryProductsPostgres,
  seedCountryProductsPostgres,
  upsertCountryProductPostgres,
} from "./configCountryProductsPostgres";
import { requireSql } from "./crm/postgresClient";

/**
 * Rows written before `requiredDocuments` existed carry `docsRequired` (portal
 * DocTypes) instead. Read such a row as if it had been migrated: one
 * checklist line per legacy DocType. A row that already has a non-empty `requiredDocuments` wins,
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
 * Runtime catalog: rows in `crm_country_products` (seeded at migrate; no
 * empty-read fallback). Admins edit the store copy and it wins everywhere
 * (portal, API guards, pricing).
 */
export async function listCountryConfig(context: AppContext): Promise<CountryConfigListing> {
  return listCountryProductsPostgres(requireSql(context));
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

  // Migration 005 seeds the table; no first-write seeding needed.
  await upsertCountryProductPostgres(requireSql(context), countryProduct);
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

/** Copies the static seed catalog into rows that don't exist yet. Idempotent. */
export async function seedCountryConfig(context: AppContext): Promise<number> {
  return seedCountryProductsPostgres(requireSql(context), COUNTRY_PRODUCTS);
}
