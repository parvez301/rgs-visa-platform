export interface MigrateCountryDocumentsCliDependencies {
  logError: (message: string) => void;
}

/**
 * Retired: the Dynamo-era fold of CRM checklists + `docsRequired` into
 * `CountryProduct.requiredDocuments` now happens inside the Postgres backfill,
 * and the checklist read/write code it depended on is gone. Always exits 1 so a
 * scripted run notices it did nothing.
 */
export function runMigrateCountryDocumentsToProductsCli(
  dependencies: MigrateCountryDocumentsCliDependencies,
): { exitCode: number } {
  dependencies.logError(
    "migrate:country-documents-to-products is retired and did nothing. " +
      "Use `pnpm backfill:country-catalog-postgres` (it copies the country catalog into Postgres " +
      "and folds leftover country checklists into the products).",
  );
  return { exitCode: 1 };
}
