import { z } from "zod";
import {
  COUNTRY_PRODUCTS,
  COUNTRY_TIERS,
  REGIONS,
  VISA_TYPES,
  listActiveProducts,
  unwrapListingResponse,
  type CountryProduct,
} from "@rgs/shared";
import { resolveContent } from "./countryContent";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "https://d3yks8h8m1.execute-api.ap-south-1.amazonaws.com";

/**
 * Public catalog rows are already filtered by the API. The admin write schema
 * (checklist uniqueness, fulfilled portal slots, official URL) is too strict
 * here — one extra/legacy field used to drop the whole list, which hid newly
 * enabled countries behind the 8-country seed fallback.
 */
const MarketingCatalogRowSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  productCode: z.string().min(1),
  countryName: z.string().min(1),
  visaType: z.enum(VISA_TYPES),
  region: z.enum(REGIONS),
  tier: z.enum(COUNTRY_TIERS),
  validityDays: z.number().int().positive(),
  stayDays: z.number().int().positive(),
  entry: z.enum(["SINGLE", "MULTIPLE"]),
  governmentFeeInr: z.number().int().nonnegative(),
  serviceFeeInr: z.number().int().nonnegative(),
  processingDays: z.number().int().positive(),
  requiredDocuments: z.array(
    z.object({
      label: z.string(),
      portalDocType: z.string().optional(),
    }),
  ),
  active: z.boolean(),
  officialUrl: z.string().optional(),
});

function parseCatalogRecords(records: unknown[]): CountryProduct[] {
  const products: CountryProduct[] = [];
  for (const record of records) {
    const parsed = MarketingCatalogRowSchema.safeParse(record);
    if (parsed.success) products.push(parsed.data as CountryProduct);
    else {
      const countryCode =
        typeof record === "object" && record !== null && "countryCode" in record
          ? String((record as { countryCode: unknown }).countryCode)
          : "?";
      console.warn(
        `[buildCatalog] skipped catalog row ${countryCode}:`,
        JSON.stringify(parsed.error.issues[0]),
      );
    }
  }
  return products;
}

/**
 * Build-time catalog: the admin-managed DB config is the source of truth for
 * which countries exist publicly. Falls back to the code catalog only when the
 * API is unreachable (e.g. isolated CI), so a build never fails on it.
 * Next.js dedupes this fetch across pages within one build.
 */
export async function fetchBuildCatalog(): Promise<CountryProduct[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/config/countries`, {
      cache: "force-cache",
    });
    if (!response.ok) throw new Error(`config endpoint ${response.status}`);
    const listing = unwrapListingResponse<unknown>(
      await response.json(),
      "countryProducts",
      "unreadableCountryProductIds",
    );
    if (listing.unreadableRecordIds.length > 0) {
      console.warn(
        `[buildCatalog] the API skipped ${listing.unreadableRecordIds.length} unreadable catalog row(s): ${listing.unreadableRecordIds.join(", ")}`,
      );
    }
    const liveCatalog = parseCatalogRecords(listing.records);
    if (liveCatalog.length > 0) return liveCatalog;
  } catch (buildFetchError) {
    console.warn("[buildCatalog] falling back to code catalog:", buildFetchError);
  }
  return listActiveProducts();
}

/** Seed countries plus live rows so a newly enabled destination still has a static visa page. */
export function catalogForStaticPages(liveCatalog: CountryProduct[]): CountryProduct[] {
  const productByCountryCode = new Map<string, CountryProduct>();
  for (const countryProduct of COUNTRY_PRODUCTS) {
    productByCountryCode.set(countryProduct.countryCode, countryProduct);
  }
  for (const countryProduct of liveCatalog) {
    productByCountryCode.set(countryProduct.countryCode, countryProduct);
  }
  return [...productByCountryCode.values()];
}

export function productFromSlug(
  catalog: CountryProduct[],
  slug: string,
): CountryProduct {
  const matchedProduct = catalog.find(
    (countryProduct) => resolveContent(countryProduct).slug === slug,
  );
  if (matchedProduct) return matchedProduct;
  throw new Error(`No country for slug ${slug}`);
}
