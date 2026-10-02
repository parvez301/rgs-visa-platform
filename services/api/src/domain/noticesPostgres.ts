import { NoticeSchema, type Notice } from "@rgs/shared";
import type { SqlClient } from "../lib/sql";
import {
  candidateFromColumns,
  isoDateSql,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../lib/sqlColumns";
import { collectReadableRecords, parseStoredRecord } from "../lib/storedRecords";

/** Postgres storage for portal notices (`portal_notices`, migration 007). */

const NOTICE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["noticeId", "notice_id"],
  ["title", "title"],
  ["body", "body"],
  ["category", "category"],
  ["severity", "severity"],
  ["countryCode", "country_code"],
  ["pinned", "pinned"],
  ["status", "status"],
  ["publishedAt", "published_at"],
  ["expiresAt", "expires_at"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
  ["createdByEmail", "created_by_email"],
];

const SELECT_NOTICE_SQL = `select notice_id, title, body, category, severity, country_code, pinned, status,
       ${isoTimestampSql("published_at")} as published_at,
       ${isoDateSql("expires_at")} as expires_at,
       ${isoTimestampSql("created_at")} as created_at,
       ${isoTimestampSql("updated_at")} as updated_at,
       created_by_email
  from portal_notices`;

/**
 * The single place a `portal_notices` row becomes a Notice. A schema failure
 * is a CorruptRecordError naming the notice, exactly as on the Dynamo path, so
 * the unauthenticated public ticker never answers 500 for one bad row.
 */
function rowToNotice(noticeRow: DbRow): Notice {
  const noticeId =
    typeof noticeRow["notice_id"] === "string" ? noticeRow["notice_id"] : "an unidentifiable row";
  return parseStoredRecord(
    NoticeSchema,
    "Notice",
    noticeId,
    candidateFromColumns(noticeRow, NOTICE_COLUMNS),
  );
}

/**
 * Insert or update on the primary key. `created_at` is deliberately absent
 * from the update list: a re-save never rewrites when the notice was created.
 */
export async function upsertNoticePostgres(sql: SqlClient, notice: Notice): Promise<void> {
  await sql.query(
    `insert into portal_notices (
       notice_id, title, body, category, severity, country_code, pinned, status,
       published_at, expires_at, created_at, updated_at, created_by_email
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::date, $11::timestamptz, $12::timestamptz, $13
     )
     on conflict (notice_id) do update set
       title = excluded.title,
       body = excluded.body,
       category = excluded.category,
       severity = excluded.severity,
       country_code = excluded.country_code,
       pinned = excluded.pinned,
       status = excluded.status,
       published_at = excluded.published_at,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at,
       created_by_email = excluded.created_by_email`,
    [
      notice.noticeId,
      notice.title,
      notice.body,
      notice.category,
      notice.severity,
      orNull(notice.countryCode),
      notice.pinned,
      notice.status,
      orNull(notice.publishedAt),
      orNull(notice.expiresAt),
      notice.createdAt,
      notice.updatedAt,
      orNull(notice.createdByEmail),
    ],
  );
}

export async function getNoticePostgres(
  sql: SqlClient,
  noticeId: string,
): Promise<Notice | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_NOTICE_SQL} where notice_id = $1`, [
    noticeId,
  ]);
  const noticeRow = result.rows[0];
  return noticeRow === undefined ? undefined : rowToNotice(noticeRow);
}

/** Newest first; unreadable rows are skipped and named, like the Dynamo list. */
export async function listNoticesPostgres(
  sql: SqlClient,
): Promise<{ notices: Notice[]; unreadableNoticeIds: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_NOTICE_SQL} order by portal_notices.created_at desc, notice_id desc`,
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    rowToNotice,
    { entityDescription: "notice" },
  );
  return { notices: records, unreadableNoticeIds: unreadableRecordIds };
}

/** False when no row matched, so the caller can answer 404. */
export async function deleteNoticePostgres(
  sql: SqlClient,
  noticeId: string,
): Promise<boolean> {
  const result = await sql.query<DbRow>(
    `delete from portal_notices where notice_id = $1 returning notice_id`,
    [noticeId],
  );
  return result.rows.length > 0;
}
