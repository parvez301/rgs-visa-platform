import { z } from "zod";
import { labelsForDestinationCountry } from "../../domain/crm/destinationRequiredDocuments";
import type { AgentTool } from "./registry";

/**
 * Reads `CountryProduct.requiredDocuments` — the same source create-case
 * stamps from — not the frozen CRM `CountryChecklist` rows this tool used to
 * serve. After the Config cutover nothing writes those, so the tool would have
 * answered with a list the desk could no longer see or edit.
 */
export const getCountryChecklistTool: AgentTool<{ countryCode: string }> = {
  name: "get_country_checklist",
  kind: "read",
  description:
    "The documents a destination country requires, as configured in Config and stamped on every case bound for it. Use this before saying a file is complete.",
  inputSchema: z.object({ countryCode: z.string().length(2) }),
  // No tenantId: the country catalog is global config, not tenant-scoped.
  execute: async (context, _tenantId, input) => ({
    countryCode: input.countryCode,
    requiredDocuments: await labelsForDestinationCountry(context, input.countryCode),
  }),
};
