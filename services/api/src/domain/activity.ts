import type { ActivityEvent } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { requireSql } from "./crm/postgresClient";
import { listRecentActivityPostgres, listUserActivityPostgres } from "./activityPostgres";

export interface ActivityListing {
  events: ActivityEvent[];
  /**
   * Rows the tenant has that could not be turned back into an ActivityEvent.
   * Named rather than merely absent: an event silently missing from an audit
   * trail is worse than one reported as unreadable.
   */
  unreadableEventIds: string[];
}

/** Reverse-chron feed over the last `daysBack` days (admin dashboard). */
export async function listRecentActivity(
  context: AppContext,
  daysBack = 2,
  limit = 100,
): Promise<ActivityListing> {
  const endDate = context.now();
  const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return listRecentActivityPostgres(requireSql(context), startDate.toISOString(), limit);
}

/** Full activity trail for one user (admin "what is this user doing"). */
export async function listUserActivity(
  context: AppContext,
  userId: string,
  limit = 100,
): Promise<ActivityListing> {
  return listUserActivityPostgres(requireSql(context), userId, limit);
}
