import { ActivityEventSchema, type ActivityEvent } from "@rgs/shared";
import type { AppContext } from "../lib/context";

function dayBucketsBetween(startDate: Date, endDate: Date): string[] {
  const buckets: string[] = [];
  const cursor = new Date(startDate);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= endDate.getTime()) {
    buckets.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return buckets;
}

function itemToActivityEvent(item: Record<string, unknown>): ActivityEvent {
  const { PK, SK, GSI2PK, GSI2SK, ...eventAttributes } = item;
  return ActivityEventSchema.parse(eventAttributes);
}

/** Reverse-chron feed over the last `daysBack` days (admin dashboard). */
export async function listRecentActivity(
  context: AppContext,
  daysBack = 2,
  limit = 100,
): Promise<ActivityEvent[]> {
  const endDate = context.now();
  const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const buckets = dayBucketsBetween(startDate, endDate).reverse();
  const collectedEvents: ActivityEvent[] = [];
  for (const dayBucket of buckets) {
    if (collectedEvents.length >= limit) break;
    const items = await context.table.query(`EVENT#${dayBucket}`, {
      scanForward: false,
      limit: limit - collectedEvents.length,
    });
    collectedEvents.push(...items.map(itemToActivityEvent));
  }
  return collectedEvents;
}

/** Full activity trail for one user (admin "what is this user doing"). */
export async function listUserActivity(
  context: AppContext,
  userId: string,
  limit = 100,
): Promise<ActivityEvent[]> {
  const items = await context.table.queryGsi("GSI2", `USER#${userId}`, {
    scanForward: false,
    limit,
  });
  return items.map(itemToActivityEvent);
}
