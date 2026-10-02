export const MIGRATION_FILENAME = "007_portal_leads_notices.sql";

// NOTE: applyMigrations splits this text on ";" -- keep semicolons out of
// comments, string literals and dollar-quoted bodies.
//
// Portal leads (contact form submissions) and public notices.

export const MIGRATION_SQL = `
create table if not exists portal_leads (
  lead_id text not null primary key,
  full_name text not null,
  phone text not null,
  topic text not null,
  message text not null default '',
  created_at timestamptz not null
);
create index if not exists portal_leads_created
  on portal_leads (created_at desc, lead_id desc);

create table if not exists portal_notices (
  notice_id text not null primary key,
  title text not null,
  body text not null,
  category text not null,
  severity text not null,
  country_code text,
  pinned boolean not null default false,
  status text not null,
  published_at timestamptz,
  expires_at date,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  created_by_email text
);
create index if not exists portal_notices_created
  on portal_notices (created_at desc, notice_id desc);
create index if not exists portal_notices_status_pinned_published
  on portal_notices (status, pinned desc, published_at desc nulls last);
`;
