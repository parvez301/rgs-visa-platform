import { labelsForCountryCode } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { listCountryConfig } from "../config";

export interface DestinationCountry {
  countryCode: string;
  countryName: string;
  /**
   * Exactly what create-case will stamp on the case, so the New case drawer can
   * preview it. Carried here rather than fetched from the Config catalog route
   * because Ops and Finance have `config: "none"` and would get a 403 there.
   */
  requiredDocuments: string[];
}

/**
 * Unique destinations for CRM New/Edit case pickers, each with the document
 * labels a case bound for it gets stamped with.
 *
 * Reads the same catalog as portal Config, but the HTTP route gates on CRM
 * screen access so Ops can load full country names — and the document preview —
 * without config permission. Deliberately not `listActiveCountryConfig`: the
 * merge rules for several products sharing one country code live in
 * `labelsForCountryCode`, which needs the inactive rows too.
 */
export async function listDestinationCountries(
  context: AppContext,
): Promise<DestinationCountry[]> {
  const { countryProducts } = await listCountryConfig(context);
  const nameByCode = new Map<string, string>();

  for (const countryProduct of countryProducts) {
    if (!countryProduct.active) continue;
    const existingName = nameByCode.get(countryProduct.countryCode);
    // Prefer the longer name when products disagree (e.g. "UAE" vs full name).
    if (existingName === undefined || countryProduct.countryName.length > existingName.length) {
      nameByCode.set(countryProduct.countryCode, countryProduct.countryName);
    }
  }

  return [...nameByCode.entries()]
    .map(([countryCode, countryName]) => ({
      countryCode,
      countryName,
      requiredDocuments: labelsForCountryCode(countryProducts, countryCode),
    }))
    .sort((left, right) =>
      left.countryName.localeCompare(right.countryName, "en", { sensitivity: "base" }),
    );
}
