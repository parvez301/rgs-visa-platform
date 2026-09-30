import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import {
  seedCountryChecklistsFromConfig,
  type SeedCountryChecklistsFromConfigReport,
} from "./seedCountryChecklistsFromConfig";

export interface SeedCountryChecklistsCliDependencies {
  buildContext: () => AppContext;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runSeedCountryChecklistsFromConfigCli(
  dependencies: SeedCountryChecklistsCliDependencies,
): Promise<{ exitCode: number; report: SeedCountryChecklistsFromConfigReport }> {
  const report = await seedCountryChecklistsFromConfig(dependencies.buildContext(), DEFAULT_TENANT_ID);
  dependencies.logSummary({
    countriesConsidered: report.countriesConsidered,
    inserted: report.inserted,
    skippedExisting: report.skippedExisting,
    skippedEmpty: report.skippedEmpty,
  });
  return { exitCode: 0, report };
}
