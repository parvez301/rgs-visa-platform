import type { ActivityEvent, ActivityEventType } from "@rgs/shared";
import type { TableClient } from "./db";
import type { DocumentStore } from "./documentStore";
import type { EmailSender } from "./email";
import { newId } from "./ids";

/** Everything a domain function needs, injected once at handler startup. */
export interface AppContext {
  table: TableClient;
  documents: DocumentStore;
  email: EmailSender;
  adminNotificationAddress: string;
  now: () => Date;
}

export async function logActivity(
  context: AppContext,
  eventType: ActivityEventType,
  userId: string,
  applicationId: string | undefined,
  meta: Record<string, string | number | boolean> = {},
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
  };
  await context.table.put({
    PK: `EVENT#${dayBucket}`,
    SK: `${createdAt}#${eventId}`,
    GSI2PK: `USER#${userId}`,
    GSI2SK: createdAt,
    ...activityEvent,
  });
  return activityEvent;
}
