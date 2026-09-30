import { labelsForDocTypes, type DocType } from "@rgs/shared";
import { putCountryChecklistIfAbsent } from "@rgs/api/src/domain/crm/countryChecklist";
import type { AppContext } from "@rgs/api/src/lib/context";
import { listCountryConfig } from "@rgs/api/src/domain/config";

export const SEED_ACTOR = "migration@raysglobalservices.com";

export interface SeedCountryChecklistsFromConfigReport {
  countriesConsidered: number;
  inserted: number;
  skippedExisting: number;
  skippedEmpty: number;
}

/**
 * One-time (idempotent) migrate: portal Config docsRequired → CRM country checklists.
 * Unions DocTypes across products for the same countryCode; never overwrites desk edits.
 */
export async function seedCountryChecklistsFromConfig(
  context: AppContext,
  tenantId: string,
): Promise<SeedCountryChecklistsFromConfigReport> {
  const catalog = await listCountryConfig(context);
  const docsByCountry = new Map<string, DocType[]>();

  for (const countryProduct of catalog.countryProducts) {
    const existing = docsByCountry.get(countryProduct.countryCode) ?? [];
    const merged = [...existing];
    for (const docType of countryProduct.docsRequired) {
      if (!merged.includes(docType)) merged.push(docType);
    }
    docsByCountry.set(countryProduct.countryCode, merged);
  }

  let inserted = 0;
  let skippedExisting = 0;
  let skippedEmpty = 0;

  for (const [countryCode, docTypes] of docsByCountry) {
    const requiredDocuments = labelsForDocTypes(docTypes);
    if (requiredDocuments.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    const outcome = await putCountryChecklistIfAbsent(
      context,
      tenantId,
      { countryCode, requiredDocuments },
      SEED_ACTOR,
    );
    if (outcome === "inserted") inserted += 1;
    else skippedExisting += 1;
  }

  return {
    countriesConsidered: docsByCountry.size,
    inserted,
    skippedExisting,
    skippedEmpty,
  };
}
