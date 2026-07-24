import { z } from "zod";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { newId } from "../lib/ids";

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
  await context.table.put({
    PK: `LEAD#${lead.leadId}`,
    SK: "PROFILE",
    GSI1PK: "STATUS#LEAD_NEW",
    GSI1SK: createdAt,
    ...lead,
  });
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
  );  await context.email.send({
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
  const items = await context.table.queryGsi("GSI1", "STATUS#LEAD_NEW", {
    scanForward: false,
    limit,
  });
  return items.map((item) => {
    const { PK, SK, GSI1PK, GSI1SK, ...leadAttributes } = item;
    return leadAttributes as unknown as Lead;
  });
}
