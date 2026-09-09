import type { AppContext } from "../../lib/context";
import { newId } from "../../lib/ids";
import { EVENT_SORT_KEY_PREFIX, casePartitionKey, eventSortKey } from "./keys";

export type CrmEventType =
  | "CASE_CREATED"
  | "CASE_STATUS_CHANGED"
  | "CUSTODY_CHANGED"
  | "BILLING_CHANGED"
  | "CASE_UPDATED"
  | "APPLICANT_OUTCOME_CHANGED";

export interface CrmEvent {
  eventId: string;
  eventType: CrmEventType;
  caseId: string;
  actorEmail: string;
  meta: Record<string, string | number | boolean>;
  createdAt: string;
}

/** Append-only. Spec §5 stores these as EVENT#<ts>#<id> under the case partition. */
export async function recordCrmEvent(
  context: AppContext,
  tenantId: string,
  caseId: string,
  eventType: CrmEventType,
  actorEmail: string,
  meta: Record<string, string | number | boolean> = {},
): Promise<CrmEvent> {
  const createdAtDate = context.now();
  const createdAt = createdAtDate.toISOString();
  const eventId = newId("crmevt", createdAtDate.getTime());
  const crmEvent: CrmEvent = { eventId, eventType, caseId, actorEmail, meta, createdAt };

  await context.table.put({
    PK: casePartitionKey(tenantId, caseId),
    SK: `${EVENT_SORT_KEY_PREFIX}${eventSortKey(createdAt, eventId)}`,
    ...crmEvent,
  });
  return crmEvent;
}

export async function listCaseEvents(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<CrmEvent[]> {
  const eventItems = await context.table.query(casePartitionKey(tenantId, caseId), {
    skPrefix: EVENT_SORT_KEY_PREFIX,
  });
  return eventItems.map((eventItem) => ({
    eventId: String(eventItem["eventId"]),
    eventType: eventItem["eventType"] as CrmEventType,
    caseId: String(eventItem["caseId"]),
    actorEmail: String(eventItem["actorEmail"]),
    meta: (eventItem["meta"] ?? {}) as Record<string, string | number | boolean>,
    createdAt: String(eventItem["createdAt"]),
  }));
}
