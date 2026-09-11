import { z } from "zod";
import { getCountryChecklist } from "../../domain/crm/countryChecklist";
import type { AgentTool } from "./registry";

export const getCountryChecklistTool: AgentTool<{ countryCode: string }> = {
  name: "get_country_checklist",
  kind: "read",
  description:
    "The documents a destination country requires. Use this before saying a file is complete.",
  inputSchema: z.object({ countryCode: z.string().length(2) }),
  execute: async (context, tenantId, input) =>
    getCountryChecklist(context, tenantId, input.countryCode),
};
