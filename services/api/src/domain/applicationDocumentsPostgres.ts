import {
  ApplicationDocumentSchema,
  type ApplicationDocument,
  type DocType,
} from "@rgs/shared";
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
 * Postgres storage for application document metadata
 * (`portal_application_documents`, migration 006). The bytes stay in S3; this
 * is only the `s3_key` plus review state plus review state.
 * Rows parse through `ApplicationDocumentSchema`, and an unparseable row is a
 * `CorruptRecordError` that listings skip and name.
 */

const DOCUMENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["applicationId", "application_id"],
  ["docType", "doc_type"],
  ["travellerIndex", "traveller_index"],
  ["s3Key", "s3_key"],
  ["reviewStatus", "review_status"],
  ["rejectReason", "reject_reason"],
  ["uploadedAt", "uploaded_at"],
];

const SELECT_DOCUMENT_SQL = `select application_id, traveller_index, doc_type, s3_key,
            review_status, reject_reason,
            ${isoTimestampSql("uploaded_at")} as uploaded_at
       from portal_application_documents`;

function rowToDocument(documentRow: DbRow): ApplicationDocument {
  const parsed = ApplicationDocumentSchema.safeParse(
    candidateFromColumns(documentRow, DOCUMENT_COLUMNS),
  );
  if (parsed.success) return parsed.data;
  throw corruptRecord(
    "Application document",
    `${String(documentRow["application_id"] ?? "an unidentifiable row")} / ${String(
      documentRow["doc_type"],
    )}#${String(documentRow["traveller_index"])}`,
    describeFirstZodIssue(parsed.error),
  );
}

export interface ApplicationDocumentPostgresListing {
  documents: ApplicationDocument[];
  unreadableDocumentIds: string[];
}

/** One application's documents in a stable order: traveller, then doc type. */
export async function listApplicationDocumentsPostgres(
  sql: SqlClient,
  applicationId: string,
): Promise<ApplicationDocumentPostgresListing> {
  const result = await sql.query<DbRow>(
    `${SELECT_DOCUMENT_SQL}
      where application_id = $1
      order by traveller_index asc, doc_type asc`,
    [applicationId],
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    rowToDocument,
    { entityDescription: "application document" },
  );
  return { documents: records, unreadableDocumentIds: unreadableRecordIds };
}

export async function getApplicationDocumentPostgres(
  sql: SqlClient,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
): Promise<ApplicationDocument | undefined> {
  const result = await sql.query<DbRow>(
    `${SELECT_DOCUMENT_SQL}
      where application_id = $1 and traveller_index = $2 and doc_type = $3`,
    [applicationId, travellerIndex, docType],
  );
  const documentRow = result.rows[0];
  return documentRow === undefined ? undefined : rowToDocument(documentRow);
}

/** An upsert on the primary key; a re-upload resets review state. */
export async function upsertApplicationDocumentPostgres(
  sql: SqlClient,
  document: ApplicationDocument,
): Promise<void> {
  await sql.query(
    `insert into portal_application_documents (
       application_id, traveller_index, doc_type, s3_key, review_status,
       reject_reason, uploaded_at
     ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz)
     on conflict (application_id, traveller_index, doc_type) do update set
       s3_key = excluded.s3_key,
       review_status = excluded.review_status,
       reject_reason = excluded.reject_reason,
       uploaded_at = excluded.uploaded_at`,
    [
      document.applicationId,
      document.travellerIndex,
      document.docType,
      document.s3Key,
      document.reviewStatus,
      orNull(document.rejectReason),
      document.uploadedAt,
    ],
  );
}
