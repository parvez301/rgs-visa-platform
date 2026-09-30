import type { AppContext } from "../../lib/context";
import { listCountryConfig } from "../config";

export interface DestinationCountry {
  countryCode: string;
  countryName: string;
}

/**
 * Unique destinations for CRM New/Edit case pickers.
 * Reads the same catalog as portal Config, but the HTTP route gates on CRM
 * screen access so Ops can load full country names without config permission.
 * Deliberately not `listActiveCountryConfig`: a picker needs codes and names
 * only, and that function's checklist merge would cost a Dynamo get per country
 * — twice over on the Doc checklists route, which then looks the same codes up
 * again.
 */
export async function listDestinationCountries(
  context: AppContext,
): Promise<DestinationCountry[]> {
  const catalog = await listCountryConfig(context);
  const byCode = new Map<string, DestinationCountry>();

  for (const countryProduct of catalog.countryProducts) {
    if (!countryProduct.active) continue;
    const existing = byCode.get(countryProduct.countryCode);
    // Prefer the longer name when products disagree (e.g. "UAE" vs full name).
    if (
      existing === undefined ||
      countryProduct.countryName.length > existing.countryName.length
    ) {
      byCode.set(countryProduct.countryCode, {
        countryCode: countryProduct.countryCode,
        countryName: countryProduct.countryName,
      });
    }
  }

  return [...byCode.values()].sort((left, right) =>
    left.countryName.localeCompare(right.countryName, "en", { sensitivity: "base" }),
  );
}
