import type { User } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { requireSql } from "./crm/postgresClient";
import {
  getUserProfilePostgres,
  listUserProfilesPostgres,
  upsertUserProfilePostgres,
} from "./userProfilesPostgres";

export async function getUserProfile(
  context: AppContext,
  userId: string,
): Promise<User | null> {
  return (await getUserProfilePostgres(requireSql(context), userId)) ?? null;
}

export interface UserProfileListing {
  users: User[];
  /**
   * Profiles the index names that could not be reassembled. Named rather than
   * merely absent: this list is what puts a human name against an activity
   * row, and a profile missing from it silently reverts that row to a raw id.
   */
  unreadableUserIds: string[];
}

export async function listUserProfiles(context: AppContext): Promise<UserProfileListing> {
  return listUserProfilesPostgres(requireSql(context));
}

export async function ensureUserProfile(
  context: AppContext,
  userId: string,
  email: string,
  extra?: { fullName?: string; phone?: string },
): Promise<User> {
  const existingProfile = await getUserProfile(context, userId);
  if (existingProfile) return existingProfile;

  const createdAt = context.now().toISOString();
  const userProfile: User = {
    userId,
    email,
    fullName: extra?.fullName ?? email.split("@")[0]!,
    createdAt,
    ...(extra?.phone !== undefined ? { phone: extra.phone } : {}),
  };

  await upsertUserProfilePostgres(requireSql(context), userProfile);

  await logActivity(
    context,
    "SIGNED_UP",
    userId,
    undefined,
    { email },
    { actorEmail: email, actorRole: "user" },
  );

  return userProfile;
}
