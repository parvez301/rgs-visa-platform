import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import { candidateFromColumns, type DbRow, isoTimestampSql } from "../../lib/sqlColumns";
import { parseStoredRecord } from "../../lib/storedRecords";

/**
 * Postgres storage for status email templates (`crm_status_email_templates`,
 * migration 004), primary key `(tenant_id, case_status)`. Rows are parsed
 * through the same `crm.StatusEmailTemplateSchema` .
 */

const TEMPLATE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["caseStatus", "case_status"],
  ["subject", "subject"],
  ["body", "body"],
  ["enabled", "enabled"],
  ["updatedAt", "updated_at"],
  ["updatedBy", "updated_by"],
];

/** `undefined` when no row; throws `CorruptRecordError` when it will not parse. */
export async function getStatusEmailTemplatePostgres(
  sql: SqlClient,
  tenantId: string,
  caseStatus: crm.CaseStatus,
): Promise<crm.StatusEmailTemplate | undefined> {
  const result = await sql.query<DbRow>(
    `select tenant_id, case_status, subject, body, enabled,
            ${isoTimestampSql("updated_at")} as updated_at, updated_by
       from crm_status_email_templates
      where tenant_id = $1 and case_status = $2`,
    [tenantId, caseStatus],
  );
  const templateRow = result.rows[0];
  if (templateRow === undefined) return undefined;
  return parseStoredRecord(
    crm.StatusEmailTemplateSchema,
    "StatusEmailTemplate",
    caseStatus,
    candidateFromColumns(templateRow, TEMPLATE_COLUMNS),
  );
}

/** An upsert on the primary key. The caller has already validated the template. */
export async function upsertStatusEmailTemplatePostgres(
  sql: SqlClient,
  template: crm.StatusEmailTemplate,
): Promise<void> {
  await sql.query(
    `insert into crm_status_email_templates (
       tenant_id, case_status, subject, body, enabled, updated_at, updated_by
     ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7)
     on conflict (tenant_id, case_status) do update set
       subject = excluded.subject,
       body = excluded.body,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    templateValues(template),
  );
}

/** Insert-if-absent for seeding. Returns whether this call inserted the row. */
export async function insertStatusEmailTemplateIfAbsentPostgres(
  sql: SqlClient,
  template: crm.StatusEmailTemplate,
): Promise<boolean> {
  const result = await sql.query(
    `insert into crm_status_email_templates (
       tenant_id, case_status, subject, body, enabled, updated_at, updated_by
     ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7)
     on conflict (tenant_id, case_status) do nothing
     returning case_status`,
    templateValues(template),
  );
  return result.rows.length > 0;
}

function templateValues(template: crm.StatusEmailTemplate): unknown[] {
  return [
    template.tenantId,
    template.caseStatus,
    template.subject,
    template.body,
    template.enabled,
    template.updatedAt,
    template.updatedBy,
  ];
}
