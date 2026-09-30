import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import {
  migrateCountryDocumentsToProducts,
  type MigrateCountryDocumentsReport,
} from "./migrateCountryDocumentsToProducts";

export const MIGRATION_ACTOR = "migration@raysglobalservices.com";

export interface MigrateCountryDocumentsCliDependencies {
  buildContext: () => AppContext;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runMigrateCountryDocumentsToProductsCli(
  dependencies: MigrateCountryDocumentsCliDependencies,
): Promise<{ exitCode: number; report: MigrateCountryDocumentsReport }> {
  const report = await migrateCountryDocumentsToProducts(
    dependencies.buildContext(),
    DEFAULT_TENANT_ID,
    MIGRATION_ACTOR,
  );
  dependencies.logSummary({
    productsUpdated: report.productsUpdated,
    productsSkippedAlreadyMigrated: report.productsSkippedAlreadyMigrated,
    checklistLabelsMerged: report.checklistLabelsMerged,
  });
  return { exitCode: 0, report };
}
