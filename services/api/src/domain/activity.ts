import { ActivityEventSchema, type ActivityEvent } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../lib/context";
import { CorruptRecordError, corruptRecord } from "../lib/errors";

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

export interface ActivityListing {
  events: ActivityEvent[];
  /**
   * Rows the tenant has that could not be turned back into an ActivityEvent.
   * Named rather than merely absent: an event silently missing from an audit
   * trail is worse than one reported as unreadable.
   */
  unreadableEventIds: string[];
}

/**
 * The single place a stored row becomes an ActivityEvent.
 *
 * Raw, a ZodError is not an ApiError and router.ts maps only ApiError
 * subclasses, so one bad EVENT# item answered 500 for the whole feed: for
 * every admin until that day bucket aged out of the window, and for one
 * user's trail forever. Typed as CorruptRecordError it answers 409 naming
 * the row, and the listings below can catch precisely this and skip.
 */
function itemToActivityEvent(item: Record<string, unknown>): ActivityEvent {
  const { PK, SK, GSI2PK, GSI2SK, ...eventAttributes } = item;
  try {
    return ActivityEventSchema.parse(eventAttributes);
  } catch (error) {
    if (error instanceof ZodError) {
      throw corruptRecord("Activity event", eventIdOfItem(item), describeFirstIssue(error));
    }
    throw error;
  }
}

/**
 * The id that names a stored event row. The body carries it, but a row that
 * lost it is exactly the kind of row this path exists for, and
 * String(undefined) would report the literal id "undefined" — which finds
 * nothing. The storage key always names the row, so it is the fallback.
 */
function eventIdOfItem(item: Record<string, unknown>): string {
  const storedEventId = item["eventId"];
  if (typeof storedEventId === "string" && storedEventId.length > 0) return storedEventId;
  return `${String(item["PK"])} / ${String(item["SK"])}`;
}

function describeFirstIssue(error: ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue
    ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
    : "the stored item failed schema validation";
}

/**
 * One unreadable row must not take a whole feed down with it — it is a log,
 * and a log that refuses to render because one line is malformed is no log at
 * all. The bad row is skipped, warned about with the id that finds it, and
 * named in `unreadableEventIds`. Only CorruptRecordError is swallowed; every
 * other failure still propagates.
 */
function collectReadableEvents(
  items: Record<string, unknown>[],
  events: ActivityEvent[],
  unreadableEventIds: string[],
): void {
  for (const item of items) {
    try {
      events.push(itemToActivityEvent(item));
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      unreadableEventIds.push(error.recordId);
      console.warn(`Skipped unreadable activity event ${error.recordId}: ${error.reason}`);
    }
  }
}

/** Reverse-chron feed over the last `daysBack` days (admin dashboard). */
export async function listRecentActivity(
  context: AppContext,
  daysBack = 2,
  limit = 100,
): Promise<ActivityListing> {
  const endDate = context.now();
  const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const buckets = dayBucketsBetween(startDate, endDate).reverse();
  const events: ActivityEvent[] = [];
  const unreadableEventIds: string[] = [];
  for (const dayBucket of buckets) {
    if (events.length >= limit) break;
    const items = await context.table.query(`EVENT#${dayBucket}`, {
      scanForward: false,
      limit: limit - events.length,
    });
    collectReadableEvents(items, events, unreadableEventIds);
  }
  return { events, unreadableEventIds };
}

/** Full activity trail for one user (admin "what is this user doing"). */
export async function listUserActivity(
  context: AppContext,
  userId: string,
  limit = 100,
): Promise<ActivityListing> {
  const items = await context.table.queryGsi("GSI2", `USER#${userId}`, {
    scanForward: false,
    limit,
  });
  const events: ActivityEvent[] = [];
  const unreadableEventIds: string[] = [];
  collectReadableEvents(items, events, unreadableEventIds);
  return { events, unreadableEventIds };
}
