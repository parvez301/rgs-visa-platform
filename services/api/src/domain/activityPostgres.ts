import { ActivityEventSchema, type ActivityEvent } from "@rgs/shared";
import { corruptRecord } from "../lib/errors";
import type { SqlClient } from "../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../lib/sqlColumns";
import { collectReadableRecords, describeFirstZodIssue } from "../lib/storedRecords";

/**
 * Postgres storage for the activity feed (`activity_events`, migration 006).
 * The recent feed is a time-window query. Rows parse through `ActivityEventSchema`; a row that will not parse is skipped and named.
 */

const ACTIVITY_EVENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["eventId", "event_id"],
  ["eventType", "event_type"],
  ["userId", "user_id"],
  ["applicationId", "application_id"],
  ["meta", "meta"],
  ["createdAt", "created_at"],
  ["actorEmail", "actor_email"],
  ["actorRole", "actor_role"],
];

const SELECT_ACTIVITY_SQL = `select event_id, event_type, user_id, application_id, meta,
            ${isoTimestampSql("created_at")} as created_at, actor_email, actor_role
       from activity_events`;

function rowToActivityEvent(eventRow: DbRow): ActivityEvent {
  const candidate = candidateFromColumns(eventRow, ACTIVITY_EVENT_COLUMNS);
  // A driver that hands jsonb back as text still has to yield an object.
  if (typeof candidate["meta"] === "string") {
    try {
      candidate["meta"] = JSON.parse(candidate["meta"]) as unknown;
    } catch {
      // leave the string; the schema rejects it below and the row is named
    }
  }
  const parsed = ActivityEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  throw corruptRecord(
    "Activity event",
    String(eventRow["event_id"] ?? "an unidentifiable row"),
    describeFirstZodIssue(parsed.error),
  );
}

async function readableEvents(
  eventRows: DbRow[],
): Promise<{ events: ActivityEvent[]; unreadableEventIds: string[] }> {
  const { records, unreadableRecordIds } = await collectReadableRecords(
    eventRows,
    rowToActivityEvent,
    { entityDescription: "activity event" },
  );
  return { events: records, unreadableEventIds: unreadableRecordIds };
}

/** Append one event. Idempotent on `event_id`, so a retried log cannot duplicate a line. */
export async function insertActivityEventPostgres(
  sql: SqlClient,
  event: ActivityEvent,
): Promise<void> {
  await sql.query(
    `insert into activity_events
       (event_id, event_type, user_id, application_id, meta, created_at, actor_email, actor_role)
     values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7, $8)
     on conflict (event_id) do nothing`,
    [
      event.eventId,
      event.eventType,
      event.userId,
      orNull(event.applicationId),
      JSON.stringify(event.meta),
      event.createdAt,
      orNull(event.actorEmail),
      orNull(event.actorRole),
    ],
  );
}

/** Newest first, everything at or after `sinceIso`, capped at `limit`. */
export async function listRecentActivityPostgres(
  sql: SqlClient,
  sinceIso: string,
  limit: number,
): Promise<{ events: ActivityEvent[]; unreadableEventIds: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_ACTIVITY_SQL}
      where created_at >= $1::timestamptz
      order by created_at desc, event_id desc
      limit $2`,
    [sinceIso, limit],
  );
  return readableEvents(result.rows);
}

/** One user's whole trail, newest first, capped at `limit`. */
export async function listUserActivityPostgres(
  sql: SqlClient,
  userId: string,
  limit: number,
): Promise<{ events: ActivityEvent[]; unreadableEventIds: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_ACTIVITY_SQL}
      where user_id = $1
      order by created_at desc, event_id desc
      limit $2`,
    [userId, limit],
  );
  return readableEvents(result.rows);
}
