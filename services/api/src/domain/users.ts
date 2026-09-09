import { UserSchema, type User } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import type { TableItem } from "../lib/db";
import {
  collectReadableRecords,
  parseStoredRecord,
  storedRecordId,
  stripStorageKeys,
} from "../lib/storedRecords";

export const PROFILE_SORT_KEY = "PROFILE";
const USER_PROFILE_GSI_PARTITION = "USERPROFILE";

function userPartitionKey(userId: string): string {
  return `USER#${userId}`;
}

/**
 * The single place a stored row becomes a User.
 *
 * This used to end in a bare `UserSchema.parse()`, and `listUserProfiles`
 * mapped it over every profile the index returned -- so one malformed USER#
 * row answered 500 from `GET /api/v1/admin/users`, which is what resolves
 * names on the activity and user-trail screens.
 */
function itemToUser(item: TableItem): User {
  return parseStoredRecord(
    UserSchema,
    "User profile",
    storedRecordId(item, "userId"),
    stripStorageKeys(item),
  );
}

export async function getUserProfile(
  context: AppContext,
  userId: string,
): Promise<User | null> {
  const profileItem = await context.table.get(userPartitionKey(userId), PROFILE_SORT_KEY);
  if (!profileItem) return null;
  return itemToUser(profileItem);
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
  const profileItems = await context.table.queryGsi("GSI1", USER_PROFILE_GSI_PARTITION);
  const { records, unreadableRecordIds } = await collectReadableRecords(
    profileItems,
    itemToUser,
    { entityDescription: "user profile" },
  );
  return { users: records, unreadableUserIds: unreadableRecordIds };
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

  await context.table.put({
    PK: userPartitionKey(userId),
    SK: PROFILE_SORT_KEY,
    GSI1PK: USER_PROFILE_GSI_PARTITION,
    GSI1SK: createdAt,
    ...userProfile,
  });

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
