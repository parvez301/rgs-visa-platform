import { UserSchema, type User } from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import type { TableItem } from "../lib/db";

export const PROFILE_SORT_KEY = "PROFILE";
const USER_PROFILE_GSI_PARTITION = "USERPROFILE";

function userPartitionKey(userId: string): string {
  return `USER#${userId}`;
}

function itemToUser(item: TableItem): User {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1PartitionKey,
    GSI1SK: _gsi1SortKey,
    GSI2PK: _gsi2PartitionKey,
    GSI2SK: _gsi2SortKey,
    GSI3PK: _gsi3PartitionKey,
    GSI3SK: _gsi3SortKey,
    ...userAttributes
  } = item;
  return UserSchema.parse(userAttributes);
}

export async function getUserProfile(
  context: AppContext,
  userId: string,
): Promise<User | null> {
  const profileItem = await context.table.get(userPartitionKey(userId), PROFILE_SORT_KEY);
  if (!profileItem) return null;
  return itemToUser(profileItem);
}

export async function listUserProfiles(context: AppContext): Promise<User[]> {
  const profileItems = await context.table.queryGsi("GSI1", USER_PROFILE_GSI_PARTITION);
  return profileItems.map(itemToUser);
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
