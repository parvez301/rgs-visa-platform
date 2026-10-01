create table if not exists schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists crm_partners (
  tenant_id text not null,
  partner_id text not null,
  canonical_name text not null,
  contact_email text,
  updated_at timestamptz not null,
  primary key (tenant_id, partner_id)
);

create table if not exists crm_cases (
  tenant_id text not null,
  case_id text not null,
  case_ref text not null,
  partner_id text not null,
  destination_country char(2) not null,
  case_type text not null,
  visa_type text,
  group_name text,
  case_status text not null,
  billing_status text not null,
  received_date date not null,
  appointment_date date,
  expected_collection_date date,
  total_inr integer not null check (total_inr >= 0),
  updated_at timestamptz not null,
  applicant_summary jsonb,
  search_text text,
  primary key (tenant_id, case_id)
);

create index if not exists crm_cases_tenant_status_updated
  on crm_cases (tenant_id, case_status, updated_at desc);
create index if not exists crm_cases_tenant_partner_received
  on crm_cases (tenant_id, partner_id, received_date desc);
create index if not exists crm_cases_tenant_case_ref
  on crm_cases (tenant_id, lower(case_ref));
create index if not exists crm_cases_tenant_search_text
  on crm_cases (tenant_id, search_text);
