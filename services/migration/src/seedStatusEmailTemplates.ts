import { seedStatusEmailTemplatesIfAbsent } from "@rgs/api/src/domain/crm/statusEmailTemplates";
import type { AppContext } from "@rgs/api/src/lib/context";

export const SEED_ACTOR = "migration@raysglobalservices.com";

export interface SeedStatusEmailTemplatesReport {
  inserted: number;
}

/** Writes the built-in default for every status that has no stored row; desk edits are never overwritten. */
export async function seedStatusEmailTemplates(
  context: AppContext,
  tenantId: string,
): Promise<SeedStatusEmailTemplatesReport> {
  return { inserted: await seedStatusEmailTemplatesIfAbsent(context, tenantId, SEED_ACTOR) };
}
