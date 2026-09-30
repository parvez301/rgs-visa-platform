import { labelsForCountryCode } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { listCountryConfig } from "../config";

/**
 * Labels to stamp on a case for a destination ISO country, read from the
 * country's CountryProduct rows. Empty when the country has no product.
 * Merge rules live in `labelsForCountryCode` (shared with the admin preview).
 */
export async function labelsForDestinationCountry(
  context: AppContext,
  countryCode: string,
): Promise<string[]> {
  const { countryProducts } = await listCountryConfig(context);
  return labelsForCountryCode(countryProducts, countryCode);
}
