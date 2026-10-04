import type { ActivityEvent, ActivityEventType, ActivityActorRole } from "@rgs/shared";
import type { LlmProvider } from "../agent/providers/types";
import type { CognitoAdminsClient } from "./cognitoAdmins";
import type { DocumentStore } from "./documentStore";
import type { EmailSender } from "./email";
import type { SqlClient } from "./sql";
import { newId } from "./ids";
import { requireSql } from "../domain/crm/postgresClient";
import { insertActivityEventPostgres } from "../domain/activityPostgres";

/** Everything a domain function needs, injected once at handler startup. */
export interface AppContext {
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
  /** Postgres pool (Supabase transaction pooler in production, PGlite in tests). */
  sql: SqlClient;
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
  await insertActivityEventPostgres(requireSql(context), activityEvent);
  return activityEvent;
}
