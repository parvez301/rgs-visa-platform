export const MIGRATION_FILENAME = "004_crm_remaining_sor.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies.
//
// The remaining Dynamo-backed CRM records, so CRM_STORE=postgres can serve them
// without Dynamo: importer ref reservations, the import review queue, staged
// agent proposals, agent memory, per-user agent prefs and status-email
// templates. Column names are the snake_case of the Zod / interface fields.
// Timestamps are timestamptz and the ISO strings the domain code holds are
// converted at the store boundary, the same as the case tables.
export const MIGRATION_SQL = `
create table if not exists crm_case_ref_reservations (
  tenant_id text not null,
  case_ref text not null,
  case_id text not null,
  reserved_at timestamptz not null,
  completed_at timestamptz,
  primary key (tenant_id, case_ref)
);

create table if not exists crm_review_items (
  tenant_id text not null,
  review_item_id text not null,
  reason text not null,
  review_status text not null default 'OPEN' check (review_status in ('OPEN', 'APPLIED', 'DISMISSED')),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  case_ref text not null,
  field_name text not null,
  raw_value text not null,
  proposed_value text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  detail text,
  resolved_value text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null,
  primary key (tenant_id, review_item_id)
);

create index if not exists crm_review_items_tenant_status
  on crm_review_items (tenant_id, review_status);

create table if not exists crm_proposals (
  tenant_id text not null,
  proposal_id text not null,
  status text not null check (status in ('PENDING', 'APPROVED', 'DISCARDED')),
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  summary jsonb not null default '[]'::jsonb,
  case_id text,
  proposed_by text not null,
  proposed_at timestamptz not null,
  decided_by text,
  decided_at timestamptz,
  discard_reason text,
  primary key (tenant_id, proposal_id)
);

create index if not exists crm_proposals_tenant_status
  on crm_proposals (tenant_id, status);

create table if not exists crm_memories (
  tenant_id text not null,
  scope text not null,
  memory_key text not null,
  text text not null,
  source_case_id text,
  created_by text not null check (created_by in ('agent', 'human')),
  created_at timestamptz not null,
  created_by_email text,
  primary key (tenant_id, scope, memory_key)
);

create index if not exists crm_memories_tenant_scope
  on crm_memories (tenant_id, scope);

create table if not exists crm_user_prefs (
  tenant_id text not null,
  email text not null,
  trust_level smallint not null default 0 check (trust_level in (0, 1, 2)),
  auto_apply_opt_in boolean not null default false,
  default_filters jsonb not null default '{}'::jsonb,
  confirmed_without_edit_count integer not null default 0 check (confirmed_without_edit_count >= 0),
  primary key (tenant_id, email)
);

create table if not exists crm_status_email_templates (
  tenant_id text not null,
  case_status text not null,
  subject text not null,
  body text not null,
  enabled boolean not null,
  updated_at timestamptz not null,
  updated_by text not null default '',
  primary key (tenant_id, case_status)
);
`;
