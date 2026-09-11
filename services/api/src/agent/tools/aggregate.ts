import { z } from "zod";
import { CASE_COUNT_GROUP_BY_FIELDS, countCasesByField, type CaseCountGroupByField } from "../../domain/crm/cases";
import type { AgentTool } from "./registry";

export const aggregateTool: AgentTool<{ groupBy: CaseCountGroupByField }> = {
  name: "aggregate",
  kind: "read",
  description:
    "Count cases grouped by status, destination country, billing status or partner. Returns numbers only — use this instead of listing cases when the question is 'how many'.",
  inputSchema: z.object({ groupBy: z.enum(CASE_COUNT_GROUP_BY_FIELDS) }),
  execute: async (context, tenantId, input) => {
    const caseCounts = await countCasesByField(context, tenantId, input.groupBy);
    // A corrupt row is named, never silently dropped from a number the owner
    // will act on. Same rule the listing endpoints follow.
    return caseCounts.uncountedCaseIds.length > 0
      ? {
          groupBy: input.groupBy,
          counts: caseCounts.counts,
          total: caseCounts.total,
          uncountedCaseIds: caseCounts.uncountedCaseIds,
        }
      : { groupBy: input.groupBy, counts: caseCounts.counts, total: caseCounts.total };
  },
};
