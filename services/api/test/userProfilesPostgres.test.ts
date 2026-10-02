import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { createDraft } from "../src/domain/applications";
import { ensureUserProfile, getUserProfile, listUserProfiles } from "../src/domain/users";
import {
  getUserProfilePostgres,
  listUserProfilesPostgres,
  upsertUserProfilePostgres,
} from "../src/domain/userProfilesPostgres";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import { buildTestContext, type TestContext } from "./helpers";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

describe("user profiles with CRM_STORE=postgres", () => {
  let sql: SqlClient;
  let baseContext: TestContext;
  let context: TestContext & AppContext;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
    baseContext = buildTestContext();
    context = { ...baseContext, crmStore: "postgres", sql };
  });

  async function dynamoProfileItems() {
    return [
      await baseContext.table.get("USER#user_1", "PROFILE"),
      ...(await baseContext.table.queryGsi("GSI1", "USERPROFILE")),
    ].filter((item) => item !== undefined && item !== null);
  }

  it("ensures a profile in Postgres once and leaves Dynamo without a PROFILE row", async () => {
    const first = await ensureUserProfile(context, "user_1", "priya@example.com", {
      fullName: "Priya Sharma",
      phone: "+919800000000",
    });
    expect(first).toMatchObject({
      userId: "user_1",
      email: "priya@example.com",
      fullName: "Priya Sharma",
      phone: "+919800000000",
    });
    expect(await getUserProfilePostgres(sql, "user_1")).toEqual(first);

    baseContext.advanceClock(60_000);
    const second = await ensureUserProfile(context, "user_1", "priya@example.com", {
      fullName: "Should Not Overwrite",
    });
    expect(second).toEqual(first);
    const count = await sql.query<{ n: string | number }>(
      "select count(*) as n from portal_user_profiles",
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
    expect(await dynamoProfileItems()).toEqual([]);
  });

  it("defaults fullName from the email local-part and keeps phone absent", async () => {
    const profile = await ensureUserProfile(context, "user_1", "asha@example.com");
    expect(profile.fullName).toBe("asha");
    const reloaded = await getUserProfile(context, "user_1");
    expect(reloaded).toEqual(profile);
    expect("phone" in reloaded!).toBe(false);
  });

  it("returns null for an unknown user", async () => {
    expect(await getUserProfile(context, "user_missing")).toBeNull();
    expect(await getUserProfilePostgres(sql, "user_missing")).toBeUndefined();
  });

  it("lists profiles from Postgres, oldest first", async () => {
    await ensureUserProfile(context, "user_2", "two@example.com", { fullName: "Two" });
    baseContext.advanceClock(1000);
    await ensureUserProfile(context, "user_1", "one@example.com", { fullName: "One" });
    const listing = await listUserProfiles(context);
    expect(listing.users.map((user) => user.userId)).toEqual(["user_2", "user_1"]);
    expect(listing.unreadableUserIds).toEqual([]);
    expect(await dynamoProfileItems()).toEqual([]);
  });

  it("creates the profile when a draft is started", async () => {
    await createDraft(context, "user_1", "AE", "user_1@example.com");
    expect((await getUserProfile(context, "user_1"))?.email).toBe("user_1@example.com");
    expect(await dynamoProfileItems()).toEqual([]);
  });

  it("skips and names an unreadable profile instead of failing the listing", async () => {
    await ensureUserProfile(context, "user_1", "one@example.com", { fullName: "One" });
    await sql.query(
      `insert into portal_user_profiles (user_id, email, full_name, created_at)
       values ('user_bad', 'not-an-email', 'Bad', now())`,
    );
    const listing = await listUserProfilesPostgres(sql);
    expect(listing.users.map((user) => user.userId)).toEqual(["user_1"]);
    expect(listing.unreadableUserIds).toEqual(["user_bad"]);
    await expect(getUserProfilePostgres(sql, "user_bad")).rejects.toMatchObject({
      name: "CorruptRecordError",
    });
  });

  it("upsert replaces an existing row and drops a removed phone", async () => {
    const profile = await ensureUserProfile(context, "user_1", "one@example.com");
    await upsertUserProfilePostgres(sql, { ...profile, phone: "+971500000000" });
    expect((await getUserProfilePostgres(sql, "user_1"))?.phone).toBe("+971500000000");
    await upsertUserProfilePostgres(sql, profile);
    expect(await getUserProfilePostgres(sql, "user_1")).toEqual(profile);
  });
});

describe("user profiles with the Dynamo store", () => {
  it("still writes USER#/PROFILE rows and reads them back", async () => {
    const context = buildTestContext();
    const profile = await ensureUserProfile(context, "user_1", "one@example.com");
    expect(await context.table.get("USER#user_1", "PROFILE")).toBeTruthy();
    expect(await getUserProfile(context, "user_1")).toEqual(profile);
    expect((await listUserProfiles(context)).users).toEqual([profile]);
  });
});
