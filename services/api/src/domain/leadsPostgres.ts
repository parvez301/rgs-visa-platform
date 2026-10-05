import type { SqlClient } from "../lib/sql";
import { candidateFromColumns, isoTimestampSql, type DbRow } from "../lib/sqlColumns";
import type { Lead } from "./leads";

/** Postgres storage for portal leads (`portal_leads`, migration 007). */

const LEAD_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["leadId", "lead_id"],
  ["fullName", "full_name"],
  ["phone", "phone"],
  ["topic", "topic"],
  ["message", "message"],
  ["createdAt", "created_at"],
];

function rowToLead(leadRow: DbRow): Lead {
  return candidateFromColumns(leadRow, LEAD_COLUMNS) as unknown as Lead;
}

/** An upsert on the primary key. The caller has already validated the lead. */
export async function insertLeadPostgres(sql: SqlClient, lead: Lead): Promise<void> {
  await sql.query(
    `insert into portal_leads (lead_id, full_name, phone, topic, message, created_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz)
     on conflict (lead_id) do update set
       full_name = excluded.full_name,
       phone = excluded.phone,
       topic = excluded.topic,
       message = excluded.message,
       created_at = excluded.created_at`,
    [lead.leadId, lead.fullName, lead.phone, lead.topic, lead.message, lead.createdAt],
  );
}

/** Newest first. */
export async function listNewLeadsPostgres(sql: SqlClient, limit = 50): Promise<Lead[]> {
  const result = await sql.query<DbRow>(
    `select lead_id, full_name, phone, topic, message,
            ${isoTimestampSql("created_at")} as created_at
       from portal_leads
      order by portal_leads.created_at desc, lead_id desc
      limit $1`,
    [limit],
  );
  return result.rows.map(rowToLead);
}
