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
  logError: (message: string) => void;
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
    productsSkippedInvalid: report.productsSkippedInvalid,
    checklistsSkippedCorrupt: report.checklistsSkippedCorrupt,
    productsSkippedCorruptChecklist: report.productsSkippedCorruptChecklist,
  });
  for (const invalidProductDetail of report.invalidProductDetails) {
    dependencies.logError(`Product left unmigrated (invalid): ${invalidProductDetail}`);
  }
  if (report.corruptChecklistCountryCodes.length > 0) {
    dependencies.logError(
      `Countries left unmigrated (unreadable checklist, fix then re-run): ${report.corruptChecklistCountryCodes.join(", ")}`,
    );
  }
  // Non-zero when anything was left behind, so a scripted run notices the re-run is needed.
  const leftUnmigrated = report.productsSkippedInvalid + report.productsSkippedCorruptChecklist;
  return { exitCode: leftUnmigrated > 0 ? 1 : 0, report };
}
