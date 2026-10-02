import { PGlite } from "@electric-sql/pglite";
import type { Application } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { listRecentActivityPostgres } from "@rgs/api/src/domain/activityPostgres";
import { listRecentActivity } from "@rgs/api/src/domain/activity";
import { listApplicationDocumentsPostgres } from "@rgs/api/src/domain/applicationDocumentsPostgres";
import { applicationToItem, listApplicationDocuments, listMyApplications } from "@rgs/api/src/domain/applications";
import { listApplicationsByUserPostgres } from "@rgs/api/src/domain/applicationsPostgres";
import { listUserProfiles } from "@rgs/api/src/domain/users";
import { listUserProfilesPostgres } from "@rgs/api/src/domain/userProfilesPostgres";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { buildTestContext, createSubmittableUaeDraft, type TestContext } from "@rgs/api/test/helpers";
import { pgliteAsSqlClient } from "@rgs/api/test/pgliteSqlClient";
import { backfillPortalSoRToPostgres } from "../src/backfillPortalSoRToPostgres";

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH = "1970-01-01T00:00:00.000Z";

function byEventId<T extends { eventId: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => a.eventId.localeCompare(b.eventId));
}

/** Two users, three days apart, so activity lands in more than one EVENT# bucket. */
async function seedTwoUsersOnDifferentDays(context: TestContext): Promise<void> {
  await createSubmittableUaeDraft(context, "user_1");
  context.advanceClock(45 * DAY_MS);
  await createSubmittableUaeDraft(context, "user_2");
}

async function postgresApplicationsOf(sql: SqlClient, userId: string): Promise<Application[]> {
  return (await listApplicationsByUserPostgres(sql, userId)).applications;
}

describe("backfillPortalSoRToPostgres", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(() => {
    sql = pgliteAsSqlClient(new PGlite());
    context = buildTestContext();
  });

  it("applies the migrations itself, including 006, before copying anything", async () => {
    await backfillPortalSoRToPostgres({ table: context.table, sql });

    const migrations = await sql.query<{ filename: string }>(`select filename from schema_migrations`);
    expect(migrations.rows.map((row) => row.filename)).toContain("006_portal_sor.sql");
  });

  it("copies applications, documents, profiles and activity so Postgres reads match Dynamo reads", async () => {
    await seedTwoUsersOnDifferentDays(context);

    const result = await backfillPortalSoRToPostgres({ table: context.table, sql });

    expect(result).toEqual({
      applicationsUpserted: 2,
      documentsUpserted: 4,
      profilesUpserted: 2,
      activityEventsUpserted: expect.any(Number),
      unreadableApplicationIds: [],
      unreadableDocumentIds: [],
      unreadableUserIds: [],
      unreadableEventIds: [],
    });

    for (const userId of ["user_1", "user_2"]) {
      const fromDynamo = (await listMyApplications(context, userId)).applications;
      expect(fromDynamo).toHaveLength(1);
      expect(await postgresApplicationsOf(sql, userId)).toEqual(fromDynamo);
      const applicationId = fromDynamo[0]!.applicationId;
      const docsFromDynamo = await listApplicationDocuments(context, applicationId);
      const docsFromPostgres = (await listApplicationDocumentsPostgres(sql, applicationId)).documents;
      expect(docsFromPostgres).toHaveLength(2);
      expect(docsFromPostgres).toEqual(
        [...docsFromDynamo].sort((a, b) => a.docType.localeCompare(b.docType)),
      );
    }

    const profilesFromDynamo = (await listUserProfiles(context)).users;
    expect((await listUserProfilesPostgres(sql)).users).toEqual(profilesFromDynamo);

    // Dynamo's reader is bounded by daysBack; 90 days covers both buckets (45 days apart).
    const eventsFromDynamo = (await listRecentActivity(context, 90, 1000)).events;
    const eventsFromPostgres = (await listRecentActivityPostgres(sql, EPOCH, 1000)).events;
    expect(eventsFromDynamo.length).toBeGreaterThan(4);
    expect(new Set(eventsFromDynamo.map((event) => event.createdAt.slice(0, 10))).size).toBeGreaterThan(1);
    expect(byEventId(eventsFromPostgres)).toEqual(byEventId(eventsFromDynamo));
    expect(result.activityEventsUpserted).toBe(eventsFromDynamo.length);
  });

  it("is idempotent: a second run reports and stores the same thing", async () => {
    await seedTwoUsersOnDifferentDays(context);

    const first = await backfillPortalSoRToPostgres({ table: context.table, sql });
    const snapshot = async () => ({
      applications: [...(await postgresApplicationsOf(sql, "user_1")), ...(await postgresApplicationsOf(sql, "user_2"))],
      profiles: (await listUserProfilesPostgres(sql)).users,
      events: byEventId((await listRecentActivityPostgres(sql, EPOCH, 1000)).events),
      documentCount: (await sql.query<{ n: string }>(`select count(*)::text as n from portal_application_documents`))
        .rows[0]!.n,
    });
    const afterFirst = await snapshot();
    const second = await backfillPortalSoRToPostgres({ table: context.table, sql });

    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("finds an application by status even when its owner has no profile, and by owner even when its status is unknown", async () => {
    await createSubmittableUaeDraft(context, "user_1");
    const orphan = (await listMyApplications(context, "user_1")).applications[0]!;
    const orphanOwnerless: Application = { ...orphan, applicationId: "app_no_profile", userId: "ghost_user" };
    await context.table.put(applicationToItem(orphanOwnerless));
    // A status the GSI walk does not know: only the owner's partition reveals it.
    await context.table.put({
      ...applicationToItem(orphan),
      SK: "APP#app_odd_status",
      applicationId: "app_odd_status",
      status: "ARCHIVED",
      GSI1PK: "STATUS#ARCHIVED",
      GSI3PK: "APP#app_odd_status",
    });

    const result = await backfillPortalSoRToPostgres({ table: context.table, sql });

    expect(await postgresApplicationsOf(sql, "ghost_user")).toEqual([orphanOwnerless]);
    // ARCHIVED is not a valid status, so the row is named, not silently dropped.
    expect(result.unreadableApplicationIds).toEqual(["app_odd_status"]);
    expect(result.applicationsUpserted).toBe(2);
  });

  it("names corrupt applications, documents, profiles and events and still copies the rest", async () => {
    await createSubmittableUaeDraft(context, "user_1");
    const good = (await listMyApplications(context, "user_1")).applications[0]!;
    await context.table.put({
      PK: "USER#user_1",
      SK: "APP#app_broken",
      GSI1PK: "STATUS#DRAFT",
      GSI1SK: good.updatedAt,
      applicationId: "app_broken",
      userId: "user_1",
      travellers: "not a list",
    });
    await context.table.put({
      PK: `APP#${good.applicationId}`,
      SK: "DOC#VISA#0",
      applicationId: good.applicationId,
      docType: "NOT_A_DOC",
      travellerIndex: 0,
    });
    await context.table.put({
      PK: "USER#user_bad",
      SK: "PROFILE",
      GSI1PK: "USERPROFILE",
      GSI1SK: good.createdAt,
      userId: "user_bad",
      email: 42,
      createdAt: good.createdAt,
    });
    await context.table.put({
      PK: `EVENT#${good.createdAt.slice(0, 10)}`,
      SK: `${good.createdAt}#evt_broken`,
      eventId: "evt_broken",
      eventType: "NOT_AN_EVENT",
      userId: "user_1",
      meta: {},
      createdAt: good.createdAt,
    });

    const result = await backfillPortalSoRToPostgres({ table: context.table, sql });

    expect(result.unreadableApplicationIds).toEqual(["app_broken"]);
    expect(result.unreadableDocumentIds).toHaveLength(1);
    expect(result.unreadableDocumentIds[0]).toContain(good.applicationId);
    expect(result.unreadableDocumentIds[0]).toContain("DOC#VISA#0");
    expect(result.unreadableUserIds).toEqual(["user_bad"]);
    expect(result.unreadableEventIds).toEqual(["evt_broken"]);
    expect(result.applicationsUpserted).toBe(1);
    expect(result.documentsUpserted).toBe(2);
    expect(result.profilesUpserted).toBe(1);
    expect(await postgresApplicationsOf(sql, "user_1")).toEqual([good]);
    // The corrupt profile's partition is still walked for applications.
    expect((await listUserProfilesPostgres(sql)).users.map((user) => user.userId)).toEqual(["user_1"]);
  });

  it("copies activity from days before today back to the earliest known profile or application", async () => {
    await createSubmittableUaeDraft(context, "user_1");
    context.advanceClock(400 * DAY_MS);

    const result = await backfillPortalSoRToPostgres({ table: context.table, sql, now: context.now });

    expect(result.activityEventsUpserted).toBeGreaterThan(0);
    expect((await listRecentActivityPostgres(sql, EPOCH, 1000)).events).toHaveLength(
      result.activityEventsUpserted,
    );
  });

  it("does not need CRM_STORE=postgres or a context: it reads Dynamo and writes the given sql client", async () => {
    const previousStore = process.env["CRM_STORE"];
    delete process.env["CRM_STORE"];
    try {
      await createSubmittableUaeDraft(context, "user_1");
      const result = await backfillPortalSoRToPostgres({ table: context.table, sql });
      expect(result.applicationsUpserted).toBe(1);
    } finally {
      if (previousStore !== undefined) process.env["CRM_STORE"] = previousStore;
    }
  });
});
