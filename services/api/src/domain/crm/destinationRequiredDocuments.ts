import { documentLabelsFromProduct } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { listCountryConfig } from "../config";

/**
 * Labels to stamp on a case for a destination ISO country, read from the
 * country's CountryProduct rows. Empty when the country has no product.
 *
 * Several products can share one country code (one per visa type). Active
 * products win (all of them, when none is active); FULFILLED sorts before
 * INFO_ONLY; labels append in that order, skipping duplicates by normalized
 * (trimmed, lower-cased) text.
 */
export async function labelsForDestinationCountry(
  context: AppContext,
  countryCode: string,
): Promise<string[]> {
  const { countryProducts } = await listCountryConfig(context);
  const forCountry = countryProducts.filter(
    (countryProduct) => countryProduct.countryCode === countryCode,
  );
  if (forCountry.length === 0) return [];

  const activeProducts = forCountry.filter((countryProduct) => countryProduct.active);
  const chosenProducts = activeProducts.length > 0 ? activeProducts : forCountry;
  const tierRank = (tier: string): number => (tier === "FULFILLED" ? 0 : 1);
  // Array#sort is stable, so equal-tier products keep catalog order.
  const orderedProducts = [...chosenProducts].sort(
    (left, right) => tierRank(left.tier) - tierRank(right.tier),
  );

  const seenLabels = new Set<string>();
  const labels: string[] = [];
  for (const countryProduct of orderedProducts) {
    for (const label of documentLabelsFromProduct(countryProduct)) {
      const normalizedLabel = label.trim().toLowerCase();
      if (seenLabels.has(normalizedLabel)) continue;
      seenLabels.add(normalizedLabel);
      labels.push(label);
    }
  }
  return labels;
}
