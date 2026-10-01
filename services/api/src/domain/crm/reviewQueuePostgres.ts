import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";
import {
  collectReadableRecords,
  parseStoredRecord,
} from "../../lib/storedRecords";

/**
 * Postgres storage for the migration review queue (`crm_review_items`,
 * migration 004). Rows are parsed through the same `crm.ReviewItemSchema` as
 * the Dynamo path, so a half-written row is a `CorruptRecordError` either way
 * and a listing names it in `unreadableReviewItemIds` instead of failing.
 */

const REVIEW_ITEM_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["reviewItemId", "review_item_id"],
  ["reason", "reason"],
  ["reviewStatus", "review_status"],
  ["sourceSheet", "source_sheet"],
  ["sourceRow", "source_row"],
  ["caseRef", "case_ref"],
  ["fieldName", "field_name"],
  ["rawValue", "raw_value"],
  ["proposedValue", "proposed_value"],
  ["confidence", "confidence"],
  ["detail", "detail"],
  ["resolvedValue", "resolved_value"],
  ["resolvedBy", "resolved_by"],
  ["resolvedAt", "resolved_at"],
  ["createdAt", "created_at"],
];

const SELECT_REVIEW_ITEM_SQL = `
select
  tenant_id, review_item_id, reason, review_status, source_sheet, source_row,
  case_ref, field_name, raw_value, proposed_value, confidence, detail,
  resolved_value, resolved_by,
  ${isoTimestampSql("resolved_at")} as resolved_at,
  ${isoTimestampSql("created_at")} as created_at
from crm_review_items
where tenant_id = $1`;

function parseReviewItemRow(dbRow: DbRow): crm.ReviewItem {
  return parseStoredRecord(
    crm.ReviewItemSchema,
    "Review item",
    String(dbRow["review_item_id"]),
    candidateFromColumns(dbRow, REVIEW_ITEM_COLUMNS),
  );
}

/**
 * The single place a review item reaches Postgres. An upsert on the primary
 * key, because resolving an item rewrites the same row (status, resolution)
 * exactly as the Dynamo `put` overwrites its item; `created_at` is never
 * touched on update, so a resolved item keeps its place in the queue.
 */
export async function insertReviewItemPostgres(
  sql: SqlClient,
  item: crm.ReviewItem,
): Promise<void> {
  await sql.query(
    `insert into crm_review_items (
       tenant_id, review_item_id, reason, review_status, source_sheet, source_row,
       case_ref, field_name, raw_value, proposed_value, confidence, detail,
       resolved_value, resolved_by, resolved_at, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15::timestamptz, $16::timestamptz
     )
     on conflict (tenant_id, review_item_id) do update set
       reason = excluded.reason,
       review_status = excluded.review_status,
       source_sheet = excluded.source_sheet,
       source_row = excluded.source_row,
       case_ref = excluded.case_ref,
       field_name = excluded.field_name,
       raw_value = excluded.raw_value,
       proposed_value = excluded.proposed_value,
       confidence = excluded.confidence,
       detail = excluded.detail,
       resolved_value = excluded.resolved_value,
       resolved_by = excluded.resolved_by,
       resolved_at = excluded.resolved_at`,
    [
      item.tenantId,
      item.reviewItemId,
      item.reason,
      item.reviewStatus,
      item.sourceSheet,
      item.sourceRow,
      item.caseRef,
      item.fieldName,
      item.rawValue,
      orNull(item.proposedValue),
      orNull(item.confidence),
      orNull(item.detail),
      orNull(item.resolvedValue),
      orNull(item.resolvedBy),
      orNull(item.resolvedAt),
      item.createdAt,
    ],
  );
}

/** `undefined` when absent; throws `CorruptRecordError` when the row will not parse. */
export async function getReviewItemPostgres(
  sql: SqlClient,
  tenantId: string,
  reviewItemId: string,
): Promise<crm.ReviewItem | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_REVIEW_ITEM_SQL} and review_item_id = $2`, [
    tenantId,
    reviewItemId,
  ]);
  const reviewRow = result.rows[0];
  return reviewRow === undefined ? undefined : parseReviewItemRow(reviewRow);
}

/**
 * One page of a status, oldest first (the order GSI1SK = createdAt gave).
 * Reads `limit + 1` so `hasMore` is known without a count.
 */
export async function listReviewItemsPostgres(
  sql: SqlClient,
  tenantId: string,
  reviewStatus: crm.ReviewStatus,
  limit: number,
): Promise<{ reviewItems: crm.ReviewItem[]; unreadableReviewItemIds: string[]; hasMore: boolean }> {
  const result = await sql.query<DbRow>(
    `${SELECT_REVIEW_ITEM_SQL} and review_status = $2
     order by created_at, review_item_id
     limit $3`,
    [tenantId, reviewStatus, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const { records, unreadableRecordIds } = await collectReadableRecords(
    pageRows,
    parseReviewItemRow,
    { entityDescription: "CRM review item", scopeDescription: `tenant ${tenantId}` },
  );
  return { reviewItems: records, unreadableReviewItemIds: unreadableRecordIds, hasMore };
}

/**
 * The three columns the open-items summary reads, as candidates for
 * `OpenReviewSummaryRowSchema`, with the row id kept beside them so a row the
 * schema refuses can still be named.
 */
export async function listOpenReviewSummaryRowsPostgres(
  sql: SqlClient,
  tenantId: string,
): Promise<Array<{ reviewItemId: string; candidate: Record<string, unknown> }>> {
  const result = await sql.query<DbRow>(
    `select review_item_id, case_ref, reason
       from crm_review_items
      where tenant_id = $1 and review_status = 'OPEN'
      order by created_at, review_item_id`,
    [tenantId],
  );
  return result.rows.map((summaryRow) => ({
    reviewItemId: String(summaryRow["review_item_id"]),
    candidate: candidateFromColumns(summaryRow, [
      ["reviewItemId", "review_item_id"],
      ["caseRef", "case_ref"],
      ["reason", "reason"],
    ]),
  }));
}

/**
 * The six columns the review-group sweep reads, for every OPEN item, as
 * candidates for `ReviewGroupRowSchema` with the row id kept beside them.
 */
export async function listOpenReviewGroupRowsPostgres(
  sql: SqlClient,
  tenantId: string,
): Promise<Array<{ reviewItemId: string; candidate: Record<string, unknown> }>> {
  const result = await sql.query<DbRow>(
    `select review_item_id, case_ref, reason, field_name, raw_value, proposed_value
       from crm_review_items
      where tenant_id = $1 and review_status = 'OPEN'
      order by created_at, review_item_id`,
    [tenantId],
  );
  return result.rows.map((groupRow) => ({
    reviewItemId: String(groupRow["review_item_id"]),
    candidate: candidateFromColumns(groupRow, [
      ["reviewItemId", "review_item_id"],
      ["caseRef", "case_ref"],
      ["reason", "reason"],
      ["fieldName", "field_name"],
      ["rawValue", "raw_value"],
      ["proposedValue", "proposed_value"],
    ]),
  }));
}
