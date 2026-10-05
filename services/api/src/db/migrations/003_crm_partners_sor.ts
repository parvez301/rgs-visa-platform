export const MIGRATION_FILENAME = "003_crm_partners_sor.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies.
//
// Widens the Phase A crm_partners (id, name, contact email, updated_at) to the
// full Partner record so CRM can create, list, look up and edit
// partners. Every new column is nullable (or defaulted) so rows
// the Phase A backfill wrote stay valid. canonical_key is NOT unique:
// createPartner checks first, and a legacy duplicate must not fail the backfill.
export const MIGRATION_SQL = `
alter table crm_partners add column if not exists partner_type text;
alter table crm_partners add column if not exists aliases jsonb not null default '[]'::jsonb;
alter table crm_partners add column if not exists canonical_key text;
alter table crm_partners add column if not exists contact_phone text;
alter table crm_partners add column if not exists contact_whatsapp text;
alter table crm_partners add column if not exists notes text;
alter table crm_partners add column if not exists created_at timestamptz;
alter table crm_partners add column if not exists created_by_email text;

create index if not exists crm_partners_tenant_canonical_key
  on crm_partners (tenant_id, canonical_key);
`;
