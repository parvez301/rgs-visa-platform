import {
  APPLICATION_STATUSES,
  ApplicationDocumentSchema,
  ActivityEventSchema,
  UserSchema,
  type ActivityEvent,
  type Application,
  type ApplicationDocument,
  type User,
} from "@rgs/shared";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { insertActivityEventPostgres } from "@rgs/api/src/domain/activityPostgres";
import { upsertApplicationDocumentPostgres } from "@rgs/api/src/domain/applicationDocumentsPostgres";
import { itemToApplication } from "@rgs/api/src/domain/applications";
import { upsertApplicationPostgres } from "@rgs/api/src/domain/applicationsPostgres";
import { upsertUserProfilePostgres } from "@rgs/api/src/domain/userProfilesPostgres";
import type { TableClient, TableItem } from "@rgs/api/src/lib/db";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { parseStoredRecord, storedRecordId, stripStorageKeys } from "@rgs/api/src/lib/storedRecords";
import { describeError, isRecordLevelDatabaseError } from "./backfillCrmRemainingToPostgres";

// Mirrors the private keys in @rgs/api domain/users.ts and activity logging in lib/context.ts.
const USER_PROFILE_GSI_PARTITION = "USERPROFILE";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackfillPortalSoRResult {
  applicationsUpserted: number;
  documentsUpserted: number;
  profilesUpserted: number;
  activityEventsUpserted: number;
  /** Application ids (or storage keys) that would not read or that Postgres rejected. */
  unreadableApplicationIds: string[];
  /** `applicationId / DOC#type#index` of document rows that would not read or that Postgres rejected. */
  unreadableDocumentIds: string[];
  unreadableUserIds: string[];
  unreadableEventIds: string[];
}

export interface BackfillPortalSoROptions {
  table: TableClient;
  sql: SqlClient;
  /** Called once per record copied, so a large run is not silent. */
  onProgress?: (label: string, n: number) => void;
  /** Upper end of the activity day-bucket walk. Defaults to the wall clock. */
  now?: () => Date;
  /**
   * Earliest day (`YYYY-MM-DD`) the activity walk starts from, when events may
   * predate every profile and application. Only ever widens the walk.
   */
  activityStartDate?: string;
}

function dayBucketsBetween(startMs: number, endMs: number): string[] {
  const buckets: string[] = [];
  const cursor = new Date(startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= endMs) {
    buckets.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return buckets;
}

function storageKey(storedItem: TableItem): string {
  return `${String(storedItem["PK"])}|${String(storedItem["SK"])}`;
}

function createdAtMillis(storedItem: TableItem): number | undefined {
  const createdAt = storedItem["createdAt"];
  if (typeof createdAt !== "string") return undefined;
  const millis = Date.parse(createdAt);
  return Number.isNaN(millis) ? undefined : millis;
}

/**
 * Copies the portal system of record from Dynamo into the migration 006
 * tables -- the ones `CRM_STORE=postgres` reads -- through the same upsert
 * helpers the live API writes with. Reads Dynamo regardless of `CRM_STORE`.
 *
 * Discovery (Dynamo has no table scan here, so every record is reached through
 * a key the live code already queries):
 *  - Profiles: the `USERPROFILE` partition of GSI1, as `listUserProfiles` does.
 *  - Applications: the union of (a) every `STATUS#<status>` partition of GSI1
 *    for each known status, which finds applications whose owner has no
 *    profile, and (b) every profiled user's `USER#<id>` partition (`APP#`
 *    prefix), which finds applications whose status is not a known one. The
 *    two are de-duplicated on the storage key. An application that is in
 *    neither (no profile AND an unknown status) is unreachable, but it is also
 *    unreadable by the live API.
 *  - Documents: the `APP#<applicationId>` partition (`DOC#` prefix) of every
 *    application found above, readable or not. Documents of an application
 *    that was not discovered are not copied.
 *  - Activity: `EVENT#YYYY-MM-DD` day buckets cannot be listed, so the walk
 *    visits every day from the earliest known `createdAt` (any profile or
 *    application, readable or not; optionally widened by `activityStartDate`)
 *    through today. Every event is logged on or after its user's profile
 *    exists, so the earliest profile bounds the walk. A bad date in a stored
 *    row is ignored for this bound only. The cost is one partition query per
 *    day, so a year of history is ~365 cheap queries.
 *
 * Idempotent: Dynamo is only read; applications, documents and profiles are
 * upserts and events are `on conflict (event_id) do nothing`. Only safe before
 * cutover -- afterwards Postgres holds newer rows a re-run would overwrite. A
 * record that cannot be copied is named in the result, never silently dropped:
 * cutover needs every `unreadable*` list empty.
 */
export async function backfillPortalSoRToPostgres(
  options: BackfillPortalSoROptions,
): Promise<BackfillPortalSoRResult> {
  const { table, sql, onProgress } = options;
  const now = options.now ?? (() => new Date());
  const result: BackfillPortalSoRResult = {
    applicationsUpserted: 0,
    documentsUpserted: 0,
    profilesUpserted: 0,
    activityEventsUpserted: 0,
    unreadableApplicationIds: [],
    unreadableDocumentIds: [],
    unreadableUserIds: [],
    unreadableEventIds: [],
  };

  await applyMigrations(sql);

  let earliestKnownMs: number | undefined;
  const noteCreatedAt = (storedItem: TableItem): void => {
    const millis = createdAtMillis(storedItem);
    if (millis !== undefined && (earliestKnownMs === undefined || millis < earliestKnownMs)) {
      earliestKnownMs = millis;
    }
  };

  /** Parse then write one record; name it (and move on) if it is corrupt or Postgres rejects it. */
  async function copyRecord<RecordType>(
    storedItem: TableItem,
    parse: (storedItem: TableItem) => RecordType,
    write: (record: RecordType) => Promise<void>,
    target: { description: string; unreadableIds: string[]; recordId: (storedItem: TableItem) => string },
  ): Promise<boolean> {
    let record: RecordType;
    try {
      record = parse(storedItem);
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      console.warn(`Skipping unreadable ${target.description} ${error.recordId}: ${error.reason}`);
      target.unreadableIds.push(error.recordId);
      return false;
    }
    try {
      await write(record);
    } catch (error) {
      if (!isRecordLevelDatabaseError(error)) throw error;
      const recordId = target.recordId(storedItem);
      console.warn(`Skipping ${target.description} ${recordId}: ${describeError(error)}`);
      target.unreadableIds.push(recordId);
      return false;
    }
    return true;
  }

  // --- Profiles -----------------------------------------------------------
  const profileItems = await table.queryGsi("GSI1", USER_PROFILE_GSI_PARTITION);
  const profileOwnerPartitions: string[] = [];
  for (const profileItem of profileItems) {
    noteCreatedAt(profileItem);
    if (typeof profileItem["PK"] === "string") profileOwnerPartitions.push(profileItem["PK"]);
    const copied = await copyRecord<User>(
      profileItem,
      (storedItem) =>
        parseStoredRecord(UserSchema, "User profile", storedRecordId(storedItem, "userId"), stripStorageKeys(storedItem)),
      (user) => upsertUserProfilePostgres(sql, user),
      {
        description: "user profile",
        unreadableIds: result.unreadableUserIds,
        recordId: (storedItem) => storedRecordId(storedItem, "userId"),
      },
    );
    if (copied) {
      result.profilesUpserted += 1;
      onProgress?.("profiles", result.profilesUpserted);
    }
  }

  // --- Applications -------------------------------------------------------
  const seenApplicationKeys = new Set<string>();
  const applicationIds: string[] = [];
  const copyApplicationItem = async (applicationItem: TableItem): Promise<void> => {
    const key = storageKey(applicationItem);
    if (seenApplicationKeys.has(key)) return;
    seenApplicationKeys.add(key);
    noteCreatedAt(applicationItem);
    const sortKey = applicationItem["SK"];
    applicationIds.push(
      typeof sortKey === "string" && sortKey.startsWith("APP#")
        ? sortKey.slice("APP#".length)
        : storedRecordId(applicationItem, "applicationId"),
    );
    const copied = await copyRecord<Application>(
      applicationItem,
      itemToApplication,
      (application) => upsertApplicationPostgres(sql, application),
      {
        description: "application",
        unreadableIds: result.unreadableApplicationIds,
        recordId: (storedItem) => storedRecordId(storedItem, "applicationId"),
      },
    );
    if (copied) {
      result.applicationsUpserted += 1;
      onProgress?.("applications", result.applicationsUpserted);
    }
  };

  for (const status of APPLICATION_STATUSES) {
    for (const applicationItem of await table.queryGsi("GSI1", `STATUS#${status}`)) {
      await copyApplicationItem(applicationItem);
    }
  }
  for (const ownerPartition of profileOwnerPartitions) {
    for (const applicationItem of await table.query(ownerPartition, { skPrefix: "APP#" })) {
      await copyApplicationItem(applicationItem);
    }
  }

  // --- Documents ----------------------------------------------------------
  for (const applicationId of applicationIds) {
    for (const documentItem of await table.query(`APP#${applicationId}`, { skPrefix: "DOC#" })) {
      const documentName = `${applicationId} / ${String(documentItem["SK"])}`;
      const copied = await copyRecord<ApplicationDocument>(
        documentItem,
        (storedItem) =>
          parseStoredRecord(ApplicationDocumentSchema, "Application document", documentName, stripStorageKeys(storedItem)),
        (document) => upsertApplicationDocumentPostgres(sql, document),
        { description: "application document", unreadableIds: result.unreadableDocumentIds, recordId: () => documentName },
      );
      if (copied) {
        result.documentsUpserted += 1;
        onProgress?.("documents", result.documentsUpserted);
      }
    }
  }

  // --- Activity -----------------------------------------------------------
  const endMs = now().getTime();
  let startMs = earliestKnownMs ?? endMs;
  if (options.activityStartDate !== undefined) {
    const requestedMs = Date.parse(options.activityStartDate);
    if (Number.isNaN(requestedMs)) throw new Error(`Invalid activityStartDate: ${options.activityStartDate}`);
    startMs = Math.min(startMs, requestedMs);
  }
  // One day of slack each side: bucket names are UTC days and the clock may be a little ahead of an event.
  for (const dayBucket of dayBucketsBetween(startMs, endMs + DAY_MS)) {
    for (const eventItem of await table.query(`EVENT#${dayBucket}`)) {
      const copied = await copyRecord<ActivityEvent>(
        eventItem,
        (storedItem) =>
          parseStoredRecord(
            ActivityEventSchema,
            "Activity event",
            storedRecordId(storedItem, "eventId"),
            stripStorageKeys(storedItem),
          ),
        (event) => insertActivityEventPostgres(sql, event),
        {
          description: "activity event",
          unreadableIds: result.unreadableEventIds,
          recordId: (storedItem) => storedRecordId(storedItem, "eventId"),
        },
      );
      if (copied) {
        result.activityEventsUpserted += 1;
        onProgress?.("activityEvents", result.activityEventsUpserted);
      }
    }
  }

  return result;
}
