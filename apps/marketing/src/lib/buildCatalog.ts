import { z } from "zod";
import {
  CountryProductSchema,
  listActiveProducts,
  unwrapListingResponse,
  type CountryProduct,
} from "@rgs/shared";
import { resolveContent } from "./countryContent";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "https://d3yks8h8m1.execute-api.ap-south-1.amazonaws.com";

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
    // { countryProducts, unreadableCountryProductIds }, or a bare array from
    // an API deployed before that change: this build runs against whatever is
    // live at the time, which is not necessarily this commit's API.
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
    const liveCatalog = z.array(CountryProductSchema).parse(listing.records);
    if (liveCatalog.length > 0) return liveCatalog;
  } catch (buildFetchError) {
    console.warn("[buildCatalog] falling back to code catalog:", buildFetchError);
  }
  return listActiveProducts();
}

export function productFromSlug(
  catalog: CountryProduct[],
  slug: string,
): CountryProduct {
  const matchedProduct = catalog.find(
    (countryProduct) => resolveContent(countryProduct).slug === slug,
  );
  if (!matchedProduct) throw new Error(`No country for slug ${slug}`);
  return matchedProduct;
}
