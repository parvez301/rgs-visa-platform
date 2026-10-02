import type { ActivityEvent, ActivityEventType, ActivityActorRole } from "@rgs/shared";
import type { LlmProvider } from "../agent/providers/types";
import type { TableClient } from "./db";
import type { CognitoAdminsClient } from "./cognitoAdmins";
import type { DocumentStore } from "./documentStore";
import type { EmailSender } from "./email";
import type { CrmStore, LedgerStore, SqlClient } from "./sql";
import { newId } from "./ids";
import { crmPostgresOf } from "../domain/crm/postgresClient";
import { insertActivityEventPostgres } from "../domain/activityPostgres";

/** Everything a domain function needs, injected once at handler startup. */
export interface AppContext {
  table: TableClient;
  documents: DocumentStore;
  email: EmailSender;
  adminNotificationAddress: string;
  now: () => Date;
  /**
   * The agent's model seam. Optional because every route that predates the
   * agent builds a context without one, and a required field here would mean
   * touching every existing test.
   */
  llm?: LlmProvider;
  /** Staff administration seam; supplied by admin handlers that manage Cognito. */
  cognitoAdmins?: CognitoAdminsClient;
  /** Postgres pool when DATABASE_URL is configured (Supabase transaction pooler). */
  sql?: SqlClient;
  /** Where the CRM ledger is read from. Absent means "dynamo". */
  ledgerStore?: LedgerStore;
  /** Where CRM case data is read/written. Absent means "dynamo". */
  crmStore?: CrmStore;
}

export async function logActivity(
  context: AppContext,
  eventType: ActivityEventType,
  userId: string,
  applicationId: string | undefined,
  meta: Record<string, string | number | boolean> = {},
  actor?: { actorEmail?: string; actorRole?: ActivityActorRole },
): Promise<ActivityEvent> {
  const createdAtDate = context.now();
  const createdAt = createdAtDate.toISOString();
  const dayBucket = createdAt.slice(0, 10);
  const eventId = newId("evt", createdAtDate.getTime());
  const activityEvent: ActivityEvent = {
    eventId,
    eventType,
    userId,
    ...(applicationId !== undefined ? { applicationId } : {}),
    meta,
    createdAt,
    ...(actor?.actorEmail !== undefined ? { actorEmail: actor.actorEmail } : {}),
    ...(actor?.actorRole !== undefined ? { actorRole: actor.actorRole } : {}),
  };
  const sql = crmPostgresOf(context);
  if (sql) {
    await insertActivityEventPostgres(sql, activityEvent);
    return activityEvent;
  }
  await context.table.put({
    PK: `EVENT#${dayBucket}`,
    SK: `${createdAt}#${eventId}`,
    GSI2PK: `USER#${userId}`,
    GSI2SK: createdAt,
    ...activityEvent,
  });
  return activityEvent;
}
