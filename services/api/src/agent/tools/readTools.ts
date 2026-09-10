import { z } from "zod";
import { crm } from "@rgs/shared";
import { getCase, listCasesByPartner, listCasesByStatus } from "../../domain/crm/cases";
import { listPartners } from "../../domain/crm/partners";
import { findTravellerByName, findTravellerByPassport } from "../../domain/crm/travellers";
import { aggregateTool } from "./aggregate";
import { getCountryChecklistTool } from "./checklist";
import type { AgentTool } from "./registry";

const SEARCH_CASES_PAGE_LIMIT = 50;

const getCaseTool: AgentTool<{ caseId: string }> = {
  name: "get_case",
  kind: "read",
  description:
    "Fetch one case by its caseId, with its applicants, three status axes, line items and dates.",
  inputSchema: z.object({ caseId: z.string().min(1) }),
  execute: async (context, tenantId, input) => getCase(context, tenantId, input.caseId),
};

const searchCasesTool: AgentTool<{ caseStatus?: crm.CaseStatus; partnerId?: string; limit?: number }> = {
  name: "search_cases",
  kind: "read",
  description:
    "List cases by status or by partner. Returns at most 50 per call; state which filter you " +
    "used when you answer. The result carries unreadableCaseIds: caseIds that exist in this " +
    "tenant but could not be read back. If it is not empty you MUST say so in your answer and " +
    "give the count -- never present the returned list of cases as complete.",
  inputSchema: z.object({
    caseStatus: z.enum(crm.CASE_STATUSES).optional(),
    partnerId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(SEARCH_CASES_PAGE_LIMIT).optional(),
  }),
  execute: async (context, tenantId, input) => {
    const pageLimit = input.limit ?? SEARCH_CASES_PAGE_LIMIT;
    if (input.partnerId !== undefined) {
      return listCasesByPartner(context, tenantId, input.partnerId, pageLimit);
    }
    if (input.caseStatus !== undefined) {
      return listCasesByStatus(context, tenantId, input.caseStatus, pageLimit);
    }
    // Neither filter given. Refusing beats scanning the whole tenant and
    // handing the model 7,156 cases it cannot hold.
    throw new Error("search_cases needs either caseStatus or partnerId");
  },
};

const findTravellerTool: AgentTool<{ passportNumber?: string; fullName?: string }> = {
  name: "find_traveller",
  kind: "read",
  description: "Find travellers already on file, by passport number or by full name.",
  inputSchema: z.object({
    passportNumber: z.string().min(1).optional(),
    fullName: z.string().min(1).optional(),
  }),
  execute: async (context, tenantId, input) => {
    if (input.passportNumber !== undefined) {
      const matchedTraveller = await findTravellerByPassport(context, tenantId, input.passportNumber);
      return { travellers: matchedTraveller === undefined ? [] : [matchedTraveller] };
    }
    if (input.fullName !== undefined) {
      const matchedTraveller = await findTravellerByName(context, tenantId, input.fullName);
      return { travellers: matchedTraveller === undefined ? [] : [matchedTraveller] };
    }
    throw new Error("find_traveller needs either passportNumber or fullName");
  },
};

const listPartnersTool: AgentTool<Record<string, never>> = {
  name: "list_partners",
  kind: "read",
  description:
    "List every referring agency with its canonical name and aliases. The result carries " +
    "unreadablePartnerIds: partnerIds that exist in this tenant but could not be read back. " +
    "If it is not empty you MUST say so in your answer and give the count -- never present " +
    "the returned list of partners as complete.",
  inputSchema: z.object({}),
  execute: async (context, tenantId) => listPartners(context, tenantId),
};

export const READ_TOOLS: AgentTool[] = [
  getCaseTool,
  searchCasesTool,
  findTravellerTool,
  listPartnersTool,
  aggregateTool,
  getCountryChecklistTool,
];
