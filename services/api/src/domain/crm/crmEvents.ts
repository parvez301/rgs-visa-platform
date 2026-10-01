import type { AppContext } from "../../lib/context";
import { newId } from "../../lib/ids";
import { EVENT_SORT_KEY_PREFIX, casePartitionKey, eventSortKey } from "./keys";
import { postgresClientFor } from "./postgresClient";

export type CrmEventType =
  | "CASE_CREATED"
  | "CASE_STATUS_CHANGED"
  | "CUSTODY_CHANGED"
  | "BILLING_CHANGED"
  | "CASE_UPDATED"
  | "APPLICANT_OUTCOME_CHANGED"
  | "APPLICANT_UPDATED"
  | "APPLICANT_ADDED"
  | "APPLICANT_REMOVED"
  | "LINE_ITEM_ADDED"
  // Widening this union is safe here: the admin activity feed switches on
  // ActivityEventType (packages/shared/src/statuses.ts), a different union,
  // and a CrmEvent never reaches it (task-8-controller-notes.md P36).
  | "PROPOSAL_APPROVED"
  | "PROPOSAL_DISCARDED"
  // Recorded by rememberMemory when the memory cites a sourceCaseId (fix
  // round 1, Minor 5) -- same safety argument as PROPOSAL_APPROVED above.
  | "MEMORY_REMEMBERED"
  | "DOCUMENT_CHECKLIST_CHANGED"
  | "INVOICE_GENERATED"
  | "PARTNER_NOTIFIED"
  | "CLIENT_NOTIFIED"
  | "APPOINTMENT_REMINDER_SENT";

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

  if (context.crmStore === "postgres") {
    // Single INSERT: atomic on its own, no transaction needed.
    await postgresClientFor(context).query(
      `insert into crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
      [tenantId, eventId, caseId, eventType, actorEmail, JSON.stringify(meta), createdAt],
    );
    return crmEvent;
  }

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
  if (context.crmStore === "postgres") {
    // created_at formatted in SQL (UTC, ms) so node-pg Date coercion and the
    // process timezone cannot change the string. event_id breaks ties the way
    // the Dynamo sort key (`<createdAt>#<eventId>`) does.
    const result = await postgresClientFor(context).query<{
      event_id: string;
      event_type: string;
      case_id: string;
      actor_email: string;
      meta: Record<string, string | number | boolean> | null;
      created_at: string;
    }>(
      `select event_id, event_type, case_id, actor_email, meta,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
         from crm_events
        where tenant_id = $1 and case_id = $2
        order by crm_events.created_at asc, event_id asc`,
      [tenantId, caseId],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type as CrmEventType,
      caseId: row.case_id,
      actorEmail: row.actor_email,
      meta: row.meta ?? {},
      createdAt: row.created_at,
    }));
  }
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
