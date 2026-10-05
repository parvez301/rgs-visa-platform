import { crm } from "@rgs/shared";
import type { SqlClient } from "../../lib/sql";
import {
  candidateFromColumns,
  isoTimestampSql,
  orNull,
  type DbRow,
} from "../../lib/sqlColumns";

/**
 * Postgres storage for CRM partners (`crm_partners`, migrations 001 + 003).
 * Rows come back as *candidates* -- plain objects shaped for
 * `crm.PartnerSchema` -- so `partners.ts` parses them through the same
 * `parseStoredPartner` and a half-written row is a
 * `CorruptRecordError` either way.
 */

/** A stored partner before schema validation, plus the keys lookups match on. */
export interface StoredPartnerCandidate {
  candidate: Record<string, unknown>;
  /** NULL on rows the Phase A backfill wrote; derived from the name at match time. */
  canonicalKey: string | null;
  aliases: string[];
}

const PARTNER_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tenantId", "tenant_id"],
  ["partnerId", "partner_id"],
  ["canonicalName", "canonical_name"],
  ["partnerType", "partner_type"],
  ["aliases", "aliases"],
  ["contactPhone", "contact_phone"],
  ["contactEmail", "contact_email"],
  ["contactWhatsapp", "contact_whatsapp"],
  ["notes", "notes"],
  ["createdAt", "created_at"],
  ["createdByEmail", "created_by_email"],
];

const SELECT_PARTNER_SQL = `
select
  tenant_id, partner_id, canonical_name, canonical_key, partner_type, aliases,
  contact_phone, contact_email, contact_whatsapp, notes,
  -- Phase A rows (migration 001 only) have no created_at: fall back to updated_at.
  ${isoTimestampSql("coalesce(created_at, updated_at)")} as created_at,
  created_by_email
from crm_partners
where tenant_id = $1`;

function aliasesOfRow(dbRow: DbRow): string[] {
  const storedAliases = dbRow["aliases"];
  if (!Array.isArray(storedAliases)) return [];
  return storedAliases.filter((alias): alias is string => typeof alias === "string");
}

function toStoredPartner(dbRow: DbRow): StoredPartnerCandidate {
  const candidate = candidateFromColumns(dbRow, PARTNER_COLUMNS);
  // A NULL or malformed aliases column must not hide the partner: the schema
  // defaults a missing list to [].
  if (!Array.isArray(candidate["aliases"])) delete candidate["aliases"];
  const canonicalKey = dbRow["canonical_key"];
  return {
    candidate,
    canonicalKey: typeof canonicalKey === "string" ? canonicalKey : null,
    aliases: aliasesOfRow(dbRow),
  };
}

export async function insertPartnerPostgres(
  sql: SqlClient,
  partner: crm.Partner,
  canonicalKey: string,
): Promise<void> {
  await sql.query(
    `insert into crm_partners (
       tenant_id, partner_id, canonical_name, canonical_key, partner_type, aliases,
       contact_phone, contact_email, contact_whatsapp, notes,
       created_at, created_by_email, updated_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::timestamptz, $12, $11::timestamptz)`,
    [
      partner.tenantId,
      partner.partnerId,
      partner.canonicalName,
      canonicalKey,
      partner.partnerType,
      JSON.stringify(partner.aliases),
      orNull(partner.contactPhone),
      orNull(partner.contactEmail),
      orNull(partner.contactWhatsapp),
      orNull(partner.notes),
      partner.createdAt,
      orNull(partner.createdByEmail),
    ],
  );
}

/** Every partner row for the tenant, in canonical-name order. */
export async function listPartnerRowsPostgres(
  sql: SqlClient,
  tenantId: string,
): Promise<StoredPartnerCandidate[]> {
  const result = await sql.query<DbRow>(
    `${SELECT_PARTNER_SQL} order by canonical_key nulls last, partner_id`,
    [tenantId],
  );
  return result.rows.map(toStoredPartner);
}

export async function getPartnerRowPostgres(
  sql: SqlClient,
  tenantId: string,
  partnerId: string,
): Promise<StoredPartnerCandidate | undefined> {
  const result = await sql.query<DbRow>(`${SELECT_PARTNER_SQL} and partner_id = $2`, [
    tenantId,
    partnerId,
  ]);
  const partnerRow = result.rows[0];
  return partnerRow === undefined ? undefined : toStoredPartner(partnerRow);
}

export async function updatePartnerContactPostgres(
  sql: SqlClient,
  partner: crm.Partner,
  updatedAt: string,
): Promise<void> {
  await sql.query(
    `update crm_partners
        set contact_email = $3, contact_phone = $4, contact_whatsapp = $5,
            updated_at = $6::timestamptz
      where tenant_id = $1 and partner_id = $2`,
    [
      partner.tenantId,
      partner.partnerId,
      orNull(partner.contactEmail),
      orNull(partner.contactPhone),
      orNull(partner.contactWhatsapp),
      updatedAt,
    ],
  );
}
