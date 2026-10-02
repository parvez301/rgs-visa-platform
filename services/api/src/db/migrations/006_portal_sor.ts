export const MIGRATION_FILENAME = "006_portal_sor.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies.
//
// Portal system of record: visa applications, their uploaded documents, user
// profiles and the activity event log.

export const MIGRATION_SQL = `
create table if not exists portal_applications (
  application_id text not null primary key,
  user_id text not null,
  country_code text not null,
  product_code text not null,
  status text not null,
  step_reached text not null,
  travellers jsonb not null,
  essentials jsonb,
  amounts jsonb not null,
  payment_status text not null,
  internal_notes jsonb not null default '[]'::jsonb,
  visa_result_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists portal_applications_user_updated
  on portal_applications (user_id, updated_at desc);
create index if not exists portal_applications_status_updated
  on portal_applications (status, updated_at desc);

create table if not exists portal_application_documents (
  application_id text not null,
  traveller_index integer not null check (traveller_index >= 0),
  doc_type text not null,
  s3_key text not null,
  review_status text not null,
  reject_reason text,
  uploaded_at timestamptz not null,
  primary key (application_id, traveller_index, doc_type)
);
create index if not exists portal_application_documents_app
  on portal_application_documents (application_id);

create table if not exists portal_user_profiles (
  user_id text not null primary key,
  email text not null,
  full_name text not null,
  phone text,
  created_at timestamptz not null
);

create table if not exists activity_events (
  event_id text not null primary key,
  event_type text not null,
  user_id text not null,
  application_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  actor_email text,
  actor_role text
);
create index if not exists activity_events_created
  on activity_events (created_at desc);
create index if not exists activity_events_user_created
  on activity_events (user_id, created_at desc);
`;
