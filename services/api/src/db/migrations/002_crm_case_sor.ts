export const MIGRATION_FILENAME = "002_crm_case_sor.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies.
export const MIGRATION_SQL = `
alter table crm_cases add column if not exists entry_type text;
alter table crm_cases add column if not exists processing text;
alter table crm_cases add column if not exists validity text;
alter table crm_cases add column if not exists submission_date date;
alter table crm_cases add column if not exists appointment_reminder_sent_for date;
alter table crm_cases add column if not exists courier_date date;
alter table crm_cases add column if not exists remarks text;
alter table crm_cases add column if not exists client_email text;
alter table crm_cases add column if not exists line_items jsonb not null default '[]'::jsonb;
alter table crm_cases add column if not exists document_checklist jsonb not null default '[]'::jsonb;
alter table crm_cases add column if not exists watchdog_overrides jsonb not null default '{}'::jsonb;
alter table crm_cases add column if not exists muted_rules jsonb not null default '[]'::jsonb;
alter table crm_cases add column if not exists snoozed_until timestamptz;
alter table crm_cases add column if not exists source_sheet text;
alter table crm_cases add column if not exists source_row integer;
alter table crm_cases add column if not exists legacy_raw jsonb;
alter table crm_cases add column if not exists created_at timestamptz;
alter table crm_cases add column if not exists created_by_email text;

create table if not exists crm_applicants (
  tenant_id text not null,
  case_id text not null,
  applicant_index integer not null check (applicant_index >= 0),
  applicant_ref text not null,
  ref_no text,
  traveller_id text not null,
  passport_number text,
  custody text not null default 'NOT_HELD',
  custody_since timestamptz,
  outcome text not null default 'PENDING',
  courier_mode text,
  tracking_number text,
  visa_result_key text,
  primary key (tenant_id, case_id, applicant_index),
  unique (tenant_id, case_id, applicant_ref),
  foreign key (tenant_id, case_id) references crm_cases (tenant_id, case_id) on delete cascade
);

create index if not exists crm_applicants_tenant_traveller
  on crm_applicants (tenant_id, traveller_id);
create index if not exists crm_applicants_tenant_passport
  on crm_applicants (tenant_id, passport_number)
  where passport_number is not null;

create table if not exists crm_travellers (
  tenant_id text not null,
  traveller_id text not null,
  full_name text not null,
  normalized_name text not null,
  date_of_birth date,
  phone text,
  passport_number text,
  created_at timestamptz not null,
  primary key (tenant_id, traveller_id)
);

create unique index if not exists crm_travellers_tenant_passport
  on crm_travellers (tenant_id, passport_number)
  where passport_number is not null;
create index if not exists crm_travellers_tenant_normalized_name
  on crm_travellers (tenant_id, normalized_name);

create table if not exists crm_events (
  tenant_id text not null,
  event_id text not null,
  case_id text not null,
  event_type text not null,
  actor_email text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  primary key (tenant_id, event_id)
);

create index if not exists crm_events_tenant_case_created
  on crm_events (tenant_id, case_id, created_at, event_id);

create table if not exists crm_ref_claims (
  tenant_id text not null,
  ref_key text not null,
  ref_value text not null,
  case_id text not null,
  claimed_at timestamptz not null,
  primary key (tenant_id, ref_key)
);

create index if not exists crm_ref_claims_tenant_case
  on crm_ref_claims (tenant_id, case_id);
`;
