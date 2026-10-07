import { ISO_COUNTRIES, labelsForCountryCode } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { listCountryConfig } from "../config";

export interface DestinationCountry {
  countryCode: string;
  countryName: string;
  /**
   * Exactly what create-case will stamp on the case, so the New case drawer can
   * preview it. Carried here rather than fetched from the Config catalog route
   * because Ops and Finance have `config: "none"` and would get a 403 there.
   * Empty when Config has no product for this country.
   */
  requiredDocuments: string[];
}

/**
 * Unique destinations for CRM New/Edit case pickers: every ISO-3166 alpha-2
 * country, with Config names/document labels overlaid when a product exists.
 *
 * Reads the same catalog as portal Config, but the HTTP route gates on CRM
 * screen access so Ops can load full country names — and the document preview —
 * without config permission. Inactive Config rows still contribute their name
 * and stamp so desk agents can open a case for a country that is not yet
 * sold on marketing.
 */
export async function listDestinationCountries(
  context: AppContext,
): Promise<DestinationCountry[]> {
  const { countryProducts } = await listCountryConfig(context);
  const configNameByCode = new Map<string, string>();

  for (const countryProduct of countryProducts) {
    const existingName = configNameByCode.get(countryProduct.countryCode);
    // Prefer the longer name when products disagree (e.g. "UAE" vs full name).
    if (existingName === undefined || countryProduct.countryName.length > existingName.length) {
      configNameByCode.set(countryProduct.countryCode, countryProduct.countryName);
    }
  }

  return ISO_COUNTRIES.map((isoCountry) => {
    const configName = configNameByCode.get(isoCountry.countryCode);
    return {
      countryCode: isoCountry.countryCode,
      countryName: configName ?? isoCountry.countryName,
      requiredDocuments: labelsForCountryCode(countryProducts, isoCountry.countryCode),
    };
  }).sort((left, right) =>
    left.countryName.localeCompare(right.countryName, "en", { sensitivity: "base" }),
  );
}
