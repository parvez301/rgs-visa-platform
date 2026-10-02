import { UserSchema, type User } from "@rgs/shared";
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
 * Postgres storage for portal user profiles (`portal_user_profiles`,
 * migration 006). Rows parse through the same `UserSchema` as the Dynamo
 * path; a row that will not parse is a `CorruptRecordError` that the listing
 * skips and names, as the Dynamo listing does.
 */

const USER_PROFILE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["userId", "user_id"],
  ["email", "email"],
  ["fullName", "full_name"],
  ["phone", "phone"],
  ["createdAt", "created_at"],
];

const SELECT_USER_PROFILE_SQL = `select user_id, email, full_name, phone,
            ${isoTimestampSql("created_at")} as created_at
       from portal_user_profiles`;

function rowToUser(profileRow: DbRow): User {
  const parsed = UserSchema.safeParse(candidateFromColumns(profileRow, USER_PROFILE_COLUMNS));
  if (parsed.success) return parsed.data;
  throw corruptRecord(
    "User profile",
    String(profileRow["user_id"] ?? "an unidentifiable row"),
    describeFirstZodIssue(parsed.error),
  );
}

/** An upsert on the primary key. The caller has already validated the user. */
export async function upsertUserProfilePostgres(sql: SqlClient, user: User): Promise<void> {
  await sql.query(
    `insert into portal_user_profiles (user_id, email, full_name, phone, created_at)
     values ($1, $2, $3, $4, $5::timestamptz)
     on conflict (user_id) do update set
       email = excluded.email,
       full_name = excluded.full_name,
       phone = excluded.phone,
       created_at = excluded.created_at`,
    [user.userId, user.email, user.fullName, orNull(user.phone), user.createdAt],
  );
}

export async function getUserProfilePostgres(
  sql: SqlClient,
  userId: string,
): Promise<User | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_USER_PROFILE_SQL} where user_id = $1`, [
    userId,
  ]);
  const profileRow = result.rows[0];
  return profileRow === undefined ? undefined : rowToUser(profileRow);
}

/** Every profile, oldest first (the Dynamo index orders by `createdAt`); unreadable rows are named. */
export async function listUserProfilesPostgres(
  sql: SqlClient,
): Promise<{ users: User[]; unreadableUserIds: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_USER_PROFILE_SQL} order by created_at asc, user_id asc`,
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(result.rows, rowToUser, {
    entityDescription: "user profile",
  });
  return { users: records, unreadableUserIds: unreadableRecordIds };
}
