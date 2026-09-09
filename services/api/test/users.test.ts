import { describe, expect, it } from "vitest";
import { ensureUserProfile, getUserProfile, listUserProfiles } from "../src/domain/users";
import { createDraft } from "../src/domain/applications";
import { buildTestContext } from "./helpers";

describe("ensureUserProfile", () => {
  it("creates a profile and logs SIGNED_UP once", async () => {
    const context = buildTestContext();
    const firstProfile = await ensureUserProfile(
      context,
      "user_1",
      "priya@example.com",
      { fullName: "Priya Sharma" },
    );
    expect(firstProfile.fullName).toBe("Priya Sharma");
    expect(firstProfile.email).toBe("priya@example.com");
    expect(firstProfile.phone).toBeUndefined();

    context.advanceClock(60_000);
    const secondProfile = await ensureUserProfile(
      context,
      "user_1",
      "priya@example.com",
      { fullName: "Should Not Overwrite" },
    );
    expect(secondProfile.createdAt).toBe(firstProfile.createdAt);
    expect(secondProfile.fullName).toBe("Priya Sharma");

    const dayEvents = await context.table.query("EVENT#2026-07-23");
    const signupEvents = dayEvents.filter(
      (eventItem) => eventItem["eventType"] === "SIGNED_UP",
    );
    expect(signupEvents).toHaveLength(1);
    expect(signupEvents[0]?.["actorRole"]).toBe("user");
    expect(signupEvents[0]?.["actorEmail"]).toBe("priya@example.com");
  });

  it("defaults fullName from the email local-part", async () => {
    const context = buildTestContext();
    const userProfile = await ensureUserProfile(context, "user_2", "asha@example.com");
    expect(userProfile.fullName).toBe("asha");
  });
});

describe("listUserProfiles", () => {
  it("returns profiles created via ensureUserProfile", async () => {
    const context = buildTestContext();
    await ensureUserProfile(context, "user_1", "one@example.com", { fullName: "One" });
    await ensureUserProfile(context, "user_2", "two@example.com", { fullName: "Two" });
    const profiles = (await listUserProfiles(context)).users;
    expect(profiles.map((userProfile) => userProfile.userId).sort()).toEqual([
      "user_1",
      "user_2",
    ]);
  });
});

describe("createDraft profile side-effect", () => {
  it("creates a user profile the first time a draft is started", async () => {
    const context = buildTestContext();
    await createDraft(context, "user_1", "AE", "user_1@example.com");
    const userProfile = await getUserProfile(context, "user_1");
    expect(userProfile?.email).toBe("user_1@example.com");
    expect(userProfile?.fullName).toBe("user_1");
  });
});
