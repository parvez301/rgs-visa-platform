import { z } from "zod";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { newId } from "../lib/ids";
import { requireSql } from "./crm/postgresClient";
import { insertLeadPostgres, listNewLeadsPostgres } from "./leadsPostgres";

export const CreateLeadSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().min(8).max(20),
  topic: z.string().min(1).max(80),
  message: z.string().max(2000).default(""),
});
export type CreateLeadInput = z.infer<typeof CreateLeadSchema>;

export interface Lead extends CreateLeadInput {
  leadId: string;
  createdAt: string;
}

export async function createLead(context: AppContext, input: CreateLeadInput): Promise<Lead> {
  const createdAt = context.now().toISOString();
  const lead: Lead = {
    leadId: newId("lead", context.now().getTime()),
    ...input,
    createdAt,
  };
  await insertLeadPostgres(requireSql(context), lead);
  await logActivity(
    context,
    "LEAD_CREATED",
    "anonymous",
    undefined,
    {
      leadId: lead.leadId,
      topic: input.topic,
    },
    { actorRole: "system" },
  );
  await context.email.send({
    toAddress: context.adminNotificationAddress,
    subject: `New website enquiry — ${input.topic}`,
    bodyText: [
      `Name: ${input.fullName}`,
      `Phone: ${input.phone}`,
      `Topic: ${input.topic}`,
      "",
      input.message,
    ].join("\n"),
  });
  return lead;
}

export async function listNewLeads(context: AppContext, limit = 50): Promise<Lead[]> {
  return listNewLeadsPostgres(requireSql(context), limit);
}
