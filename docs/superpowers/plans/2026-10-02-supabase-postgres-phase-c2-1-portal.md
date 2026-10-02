# Supabase Postgres Phase C.2.1 — Portal + Activity SoR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under existing `CRM_STORE=postgres`, move portal applications, application documents metadata, user profiles, and activity (writes + feeds/trails) onto Postgres so portal and admin no longer depend on Dynamo for those flows.

**Architecture:** Migration `006_portal_sor` adds `portal_applications`, `portal_application_documents`, `portal_user_profiles`, and `activity_events`. Domain entry points branch via `crmPostgresOf`. Document **bytes** stay in S3; metadata moves from Dynamo `APP#…/DOC#…` into `portal_application_documents` (live shape today — not an array on the application row). Ship order: migrate → backfill → deploy. No dual-write. No new env flags.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, PGlite, existing Lambda/CDK; Cognito/S3/SES unchanged.

**Spec:** `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c2-1-portal-design.md`

## Global Constraints

- Spec decisions 1–8 closed (C.2.1 portal+activity; gate on `CRM_STORE`; Postgres-only end state; mirror B.2/C.1; docs metadata SoR; admin queue included; activity included; staging first).
- **Ruling (docs shape):** Spec §4 said metadata “on the application row”; production Dynamo uses separate `APP#${applicationId}` / `DOC#…` items (`listApplicationDocuments`). Plan uses table **`portal_application_documents`**. Cost if wrong: lose multi-doc review fields — follow live SoR.
- Parent migration design decisions 1–8 still apply.
- Lambdas: transaction pooler `:6543`; DDL / backfill: session `:5432`.
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-portal-c2-1` off `main`.
- Do not deploy prod / delete Dynamo / re-run A/B/C.1/C.2.1 backfills after C.2.1 readers are live.
- When `CRM_STORE=postgres`, never fall back to Dynamo for C.2.1 surfaces — fail if `sql` missing.
- Rollback: `RGS_CRM_STORE=dynamo` + redeploy admin (+ reminders). PG-only portal/activity writes disappear from Dynamo view.

## Review Focus

1. **`CRM_STORE` unset / `dynamo`** — apps, docs, profiles, activity still Dynamo exactly as today; pinned Tasks 2–5.
2. **`CRM_STORE=postgres` without `sql`** — loud fail, never silent Dynamo; pinned Tasks 2–5.
3. **Admin status queue after PG-only submit** — `listApplicationsByStatus` sees the new status without Dynamo GSI; pinned Task 2.
4. **Document submit gate** — `missingDocuments` / submit still see PG doc rows; pinned Task 3.
5. **`logActivity` under postgres** — no Dynamo `EVENT#` put; list recent/user trail read PG; pinned Task 5.
6. **Empty tables before backfill** — do not deploy C.2.1 readers against empty portal tables; pinned Tasks 6–7 (runbook).

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Reuse **`CRM_STORE`**; no `PORTAL_STORE`. |
| D2 | Migration filename **`006_portal_sor.sql`**. |
| D3 | Tables: **`portal_applications`**, **`portal_application_documents`**, **`portal_user_profiles`**, **`activity_events`**. |
| D4 | Application complex fields (`travellers`, `essentials`, `amounts`, `internalNotes`) as **jsonb**; scalar status/ids/timestamps as columns. |
| D5 | Documents PK **`(application_id, traveller_index, doc_type)`** (matches uniqueness of upload slot); upsert on re-upload. |
| D6 | Activity: `meta` jsonb; indexes `(created_at DESC)`, `(user_id, created_at DESC)`. |
| D7 | Backfill script: **`backfill:portal-sor-postgres`**. |
| D8 | `logActivity` in `lib/context.ts` dispatches to PG when `crmPostgresOf` set. |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/db/migrations/006_portal_sor.ts` | DDL |
| `services/api/src/db/migrate.ts` | Register 006 |
| `services/api/src/domain/applicationsPostgres.ts` | App SQL |
| `services/api/src/domain/applications.ts` | Dispatch |
| `services/api/src/domain/applicationDocumentsPostgres.ts` | Doc SQL |
| `services/api/src/domain/applications.ts` / `documents.ts` / `admin.ts` | Doc list/put/dispatch |
| `services/api/src/domain/userProfilesPostgres.ts` | Profile SQL |
| `services/api/src/domain/users.ts` | Dispatch |
| `services/api/src/domain/activityPostgres.ts` | Activity SQL |
| `services/api/src/domain/activity.ts` | List dispatch |
| `services/api/src/lib/context.ts` | `logActivity` dispatch |
| `services/api/src/domain/admin.ts` | Status queue + get-with-docs on PG |
| `services/migration/src/backfillPortalSoRToPostgres.ts` | Backfill |
| `services/migration/src/backfillPortalSoRToPostgresCli.ts` | CLI |
| `docs/superpowers/specs/2026-10-02-supabase-phase-c2-1-staging-runbook.md` | Cutover |

---

### Task 1: Migration `006_portal_sor`

**Files:**
- Create: `services/api/src/db/migrations/006_portal_sor.ts`
- Modify: `services/api/src/db/migrate.ts` — register after 005
- Test: `services/api/test/migratePortalSor.test.ts`

**Interfaces — `MIGRATION_SQL` (no `;` in comments; `applyMigrations` splits on `;`):**

```sql
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
```

- [ ] **Step 1: Failing test** — applyMigrations; assert four tables + key indexes exist; re-apply idempotent.

- [ ] **Step 2: Run — expect FAIL.**

```bash
pnpm --filter @rgs/api exec vitest run test/migratePortalSor.test.ts
```

- [ ] **Step 3: Implement + register.** Update any migrate test that lists applied filenames (e.g. case-sor list includes 006).

- [ ] **Step 4: Pass + commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): add portal applications profiles activity migration 006

EOF
)"
```

---

### Task 2: Applications on Postgres (+ admin status queue)

**Files:**
- Create: `services/api/src/domain/applicationsPostgres.ts`
- Modify: `services/api/src/domain/applications.ts` — dispatch create/get/patch/submit/listMine
- Modify: `services/api/src/domain/admin.ts` — `listApplicationsByStatus` (+ get application for admin) via PG
- Test: `services/api/test/applicationsPostgres.test.ts` (and extend admin tests if present)

**Interfaces:**

```ts
export async function upsertApplicationPostgres(sql: SqlClient, application: Application): Promise<void>;
export async function getApplicationPostgres(sql: SqlClient, applicationId: string): Promise<Application | undefined>;
export async function listApplicationsByUserPostgres(sql: SqlClient, userId: string): Promise<{ applications: Application[]; unreadableApplicationIds: string[] }>;
export async function listApplicationsByStatusPostgres(sql: SqlClient, status: string): Promise<{ applications: Application[]; unreadableApplicationIds: string[] }>;
```

- Parse through `ApplicationSchema` / existing `itemToApplication` coercion if needed for legacy.
- Under postgres, `getOwnedApplication` loads via SQL then checks `userId`.
- Admin list sorts newest `updated_at` first (match GSI scanForward false).

- [ ] **Step 1: Failing tests** — create draft on PG; list mine; patch; submit status change; admin listByStatus sees it; Dynamo USER# empty; dynamo store path unchanged.

- [ ] **Step 2–4: Implement; pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store portal applications in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 3: Application documents metadata on Postgres

**Files:**
- Create: `services/api/src/domain/applicationDocumentsPostgres.ts`
- Modify: `services/api/src/domain/applications.ts` — `listApplicationDocuments`
- Modify: `services/api/src/domain/documents.ts` — `recordDocumentUpload` put path
- Modify: `services/api/src/domain/admin.ts` — document review updates if they `put` DOC# items
- Test: `services/api/test/applicationDocumentsPostgres.test.ts`

**Interfaces:**

```ts
export async function listApplicationDocumentsPostgres(sql: SqlClient, applicationId: string): Promise<{ documents: ApplicationDocument[]; unreadableDocumentIds: string[] }>;
export async function upsertApplicationDocumentPostgres(sql: SqlClient, document: ApplicationDocument): Promise<void>;
```

- S3 presign paths unchanged.
- Submit `missingDocuments` must see PG docs under postgres.

- [ ] **Step 1: Failing tests** — record upload → list docs on PG; submit gate; Dynamo `APP#/DOC#` empty under postgres.

- [ ] **Step 2–4: Implement; pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store application document metadata in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 4: User profiles on Postgres

**Files:**
- Create: `services/api/src/domain/userProfilesPostgres.ts`
- Modify: `services/api/src/domain/users.ts`
- Test: `services/api/test/userProfilesPostgres.test.ts`

**Interfaces:**

```ts
export async function upsertUserProfilePostgres(sql: SqlClient, user: User): Promise<void>;
export async function getUserProfilePostgres(sql: SqlClient, userId: string): Promise<User | undefined>;
export async function listUserProfilesPostgres(sql: SqlClient): Promise<{ users: User[]; unreadableUserIds: string[] }>;
```

- [ ] **Step 1: Failing tests** — ensure/get/list on PG; Dynamo profile empty under postgres.

- [ ] **Step 2–4: Implement; pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store user profiles in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 5: Activity on Postgres (`logActivity` + lists)

**Files:**
- Create: `services/api/src/domain/activityPostgres.ts`
- Modify: `services/api/src/lib/context.ts` — `logActivity`
- Modify: `services/api/src/domain/activity.ts` — `listRecentActivity`, `listUserActivity`
- Test: `services/api/test/activityPostgres.test.ts`

**Interfaces:**

```ts
export async function insertActivityEventPostgres(sql: SqlClient, event: ActivityEvent): Promise<void>;
export async function listRecentActivityPostgres(sql: SqlClient, sinceIso: string, limit: number): Promise<{ events: ActivityEvent[]; unreadableEventIds: string[] }>;
export async function listUserActivityPostgres(sql: SqlClient, userId: string, limit: number): Promise<{ events: ActivityEvent[]; unreadableEventIds: string[] }>;
```

- Under postgres, `logActivity` must **not** `table.put` EVENT#.
- Recent list: `created_at >= now - daysBack` order desc limit (no day buckets).

- [ ] **Step 1: Failing tests** — log + list recent + list user; Dynamo EVENT# empty; dynamo path still uses buckets.

- [ ] **Step 2–4: Implement; pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store activity events in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 6: Backfill portal SoR

**Files:**
- Create: `services/migration/src/backfillPortalSoRToPostgres.ts`
- Create: `services/migration/src/backfillPortalSoRToPostgresCli.ts`
- Modify: `services/migration/package.json` — `backfill:portal-sor-postgres`
- Test: `services/migration/test/backfillPortalSoRToPostgres.test.ts`

**Interfaces:**

```ts
export interface BackfillPortalSoRResult {
  applicationsUpserted: number;
  documentsUpserted: number;
  profilesUpserted: number;
  activityEventsUpserted: number;
  unreadableApplicationIds: string[];
  unreadableDocumentIds: string[];
  unreadableUserIds: string[];
  unreadableEventIds: string[];
}

export async function backfillPortalSoRToPostgres(args: {
  table: TableClient;
  sql: SqlClient;
  onProgress?: (label: string, n: number) => void;
}): Promise<BackfillPortalSoRResult>;
```

- `applyMigrations` first.
- Discover apps: status GSI walk (`STATUS#…`) and/or user partitions as today’s list paths do; also backfill docs per `APP#` partition.
- Profiles: `USERPROFILE` GSI (or equivalent used by `listUserProfiles`).
- Activity: walk recent day buckets / scan strategy matching how much staging needs (document window in runbook if capped — default: all `EVENT#YYYY-MM-DD` partitions discoverable via known date range from earliest profile/app `createdAt` through today, or progressive bucket walk).
- Upsert idempotent; CLI exit 1 if any unreadable* non-empty; do not require `CRM_STORE=postgres`.

- [ ] **Step 1: Failing tests** — fixture Dynamo → PG round-trip; idempotent; corrupt named.

- [ ] **Step 2–4: Implement; pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): backfill portal applications profiles activity into Postgres

EOF
)"
```

---

### Task 7: Staging runbook

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-supabase-phase-c2-1-staging-runbook.md`
- Modify: design status → approved when plan lands; Related link
- Modify: C.1 runbook — one-line pointer that portal/activity closes via C.2.1 runbook

**Must include:** B.2/C.1 preconds; migrate 006; `backfill:portal-sor-postgres` gate; count parity; deploy no flag flip; smoke portal/admin/docs/activity; forbid A/B/C.1/C.2.1 backfill re-run; rollback `CRM_STORE=dynamo`.

- [ ] **Step 1–2: Write + commit.**

```bash
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase C.2.1 staging cutover runbook

EOF
)"
```

---

## Self-review (author)

| Spec requirement | Task |
|---|---|
| Applications R/W + list mine | 2 |
| Admin status queue | 2 |
| Documents metadata (+ S3 unchanged) | 3 (+ ruling: separate table) |
| User profiles | 4 |
| Activity write + lists | 5 |
| Migration + backfill + runbook | 1, 6, 7 |
| Gate on CRM_STORE; no dual-write | Global |
| Leads/notices out | Global |

**Review Focus:** each of the six lines pinned to Tasks 2–7 as listed.
