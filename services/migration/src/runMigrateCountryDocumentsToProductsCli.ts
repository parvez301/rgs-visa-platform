export interface MigrateCountryDocumentsCliDependencies {
  logError: (message: string) => void;
}

/**
 * Retired: the Dynamo-era fold of CRM checklists + `docsRequired` into
 * `CountryProduct.requiredDocuments` is finished and its code is gone; the
 * country catalog now lives in Postgres. Nothing to run. Always exits 1 so a
 * scripted run notices it did nothing.
 */
export function runMigrateCountryDocumentsToProductsCli(
  dependencies: MigrateCountryDocumentsCliDependencies,
): { exitCode: number } {
  dependencies.logError(
    "migrate:country-documents-to-products is retired: there is nothing to do " +
      "(the country catalog lives in Postgres) and this command changed nothing.",
  );
  return { exitCode: 1 };
}
