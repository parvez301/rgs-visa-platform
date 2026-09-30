import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { seedStatusEmailTemplates, type SeedStatusEmailTemplatesReport } from "./seedStatusEmailTemplates";

export interface SeedStatusEmailTemplatesCliDependencies {
  buildContext: () => AppContext;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runSeedStatusEmailTemplatesCli(
  dependencies: SeedStatusEmailTemplatesCliDependencies,
): Promise<{ exitCode: number; report: SeedStatusEmailTemplatesReport }> {
  const report = await seedStatusEmailTemplates(dependencies.buildContext(), DEFAULT_TENANT_ID);
  dependencies.logSummary({ inserted: report.inserted });
  return { exitCode: 0, report };
}
