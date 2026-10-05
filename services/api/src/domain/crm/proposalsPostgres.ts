import type { ProposedChange } from "../../agent/approval";
import { ProposedChangeSchema } from "../../agent/proposedChangeSchema";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";
import { collectReadableRecords, parseStoredRecord } from "../../lib/storedRecords";

/**
 * Postgres storage for agent proposals (`crm_proposals`, migration 004). The
 * row is parsed back through `ProposedChangeSchema`; a half-written row is a
 * `CorruptRecordError` and a listing names it in `unreadableProposalIds`.
 * `input` and `summary` are jsonb.
 */

const PROPOSAL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["proposalId", "proposal_id"],
  ["toolName", "tool_name"],
  ["input", "input"],
  ["summary", "summary"],
  ["caseId", "case_id"],
  ["proposedBy", "proposed_by"],
  ["proposedAt", "proposed_at"],
  ["status", "status"],
  ["decidedBy", "decided_by"],
  ["decidedAt", "decided_at"],
  ["discardReason", "discard_reason"],
];

const SELECT_PROPOSAL_SQL = `
select
  proposal_id, tool_name, input, summary, case_id, proposed_by,
  ${isoTimestampSql("proposed_at")} as proposed_at,
  status, decided_by,
  ${isoTimestampSql("decided_at")} as decided_at,
  discard_reason
from crm_proposals
where tenant_id = $1`;

function parseProposalRow(dbRow: DbRow): ProposedChange {
  return parseStoredRecord(
    ProposedChangeSchema,
    "Agent proposal",
    String(dbRow["proposal_id"]),
    candidateFromColumns(dbRow, PROPOSAL_COLUMNS),
  );
}

/**
 * The single place a proposal reaches Postgres, at any status. An upsert on
 * the primary key, because approving or discarding rewrites the same row.
 * The caller has already validated the proposal.
 */
export async function upsertProposalPostgres(
  sql: SqlClient,
  tenantId: string,
  proposal: ProposedChange,
): Promise<void> {
  await sql.query(
    `insert into crm_proposals (
       tenant_id, proposal_id, status, tool_name, input, summary, case_id,
       proposed_by, proposed_at, decided_by, decided_at, discard_reason
     ) values (
       $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::timestamptz, $10,
       $11::timestamptz, $12
     )
     on conflict (tenant_id, proposal_id) do update set
       status = excluded.status,
       tool_name = excluded.tool_name,
       input = excluded.input,
       summary = excluded.summary,
       case_id = excluded.case_id,
       proposed_by = excluded.proposed_by,
       proposed_at = excluded.proposed_at,
       decided_by = excluded.decided_by,
       decided_at = excluded.decided_at,
       discard_reason = excluded.discard_reason`,
    [
      tenantId,
      proposal.proposalId,
      proposal.status,
      proposal.toolName,
      JSON.stringify(proposal.input),
      JSON.stringify(proposal.summary),
      orNull(proposal.caseId),
      proposal.proposedBy,
      proposal.proposedAt,
      orNull(proposal.decidedBy),
      orNull(proposal.decidedAt),
      orNull(proposal.discardReason),
    ],
  );
}

/** `undefined` when absent; throws `CorruptRecordError` when the row will not parse. */
export async function getProposalPostgres(
  sql: SqlClient,
  tenantId: string,
  proposalId: string,
): Promise<ProposedChange | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_PROPOSAL_SQL} and proposal_id = $2`, [
    tenantId,
    proposalId,
  ]);
  const proposalRow = result.rows[0];
  return proposalRow === undefined ? undefined : parseProposalRow(proposalRow);
}

/** Oldest first. */
export async function listProposalsByStatusPostgres(
  sql: SqlClient,
  tenantId: string,
  status: ProposedChange["status"],
  limit: number,
): Promise<{ proposals: ProposedChange[]; unreadableProposalIds: string[] }> {
  const result = await sql.query<DbRow>(
    `${SELECT_PROPOSAL_SQL} and status = $2
     order by proposed_at, proposal_id
     limit $3`,
    [tenantId, status, limit],
  );
  const { records, unreadableRecordIds } = await collectReadableRecords(
    result.rows,
    parseProposalRow,
    { entityDescription: "agent proposal", scopeDescription: `tenant ${tenantId}` },
  );
  return { proposals: records, unreadableProposalIds: unreadableRecordIds };
}
