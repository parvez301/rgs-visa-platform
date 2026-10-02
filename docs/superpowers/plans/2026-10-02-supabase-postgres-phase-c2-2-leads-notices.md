# Supabase Postgres Phase C.2.2 — Leads + Notices SoR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under existing `CRM_STORE=postgres`, move website leads and admin/public notices onto Postgres so no product SoR remains on Dynamo after this ship (Phase D decommission follows separately).

**Architecture:** Migration `007_portal_leads_notices` adds `portal_leads` and `portal_notices`. Domain entry points branch via `crmPostgresOf`. Activity for `LEAD_CREATED` / `NOTICE_PUBLISHED` already writes Postgres under C.2.1. Ship order: migrate → backfill → deploy. No dual-write. No new env flags. User API already has `DATABASE_URL` + `CRM_STORE`.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, PGlite, existing Lambda/CDK; Cognito/S3/SES unchanged.

**Spec:** `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c2-2-leads-notices-design.md`

## Global Constraints

- Spec decisions 1–9 closed (leads+notices only; gate on `CRM_STORE`; Postgres-only end state; mirror C.2.1; `portal_leads`/`portal_notices`; no lead lifecycle; named unreadable notices; staging first; Phase D next ship).
- Parent migration design decisions 1–8 still apply.
- Lambdas: transaction pooler `:6543`; DDL / backfill: session `:5432`.
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-leads-notices-c2-2` off `main`.
- Do not deploy prod / delete Dynamo / re-run A–C.2.1/C.2.2 backfills after C.2.2 readers are live.
- When `CRM_STORE=postgres`, never fall back to Dynamo for leads or notices — fail if `sql` missing.
- Rollback: `RGS_CRM_STORE=dynamo` + redeploy admin + user API + reminders. PG-only lead/notice writes disappear from Dynamo view.

## Review Focus

1. **`CRM_STORE` unset / `dynamo`** — leads and notices still Dynamo exactly as today; pinned Tasks 2–3.
2. **`CRM_STORE=postgres` without `sql`** — loud fail via `crmPostgresOf`, never silent Dynamo; pinned Tasks 2–3.
3. **Public notices with one corrupt PG row** — response still 200 with `unreadableNoticeIds` named; pinned Task 3.
4. **Lead create under postgres** — no Dynamo `LEAD#` / `STATUS#LEAD_NEW` put; activity still lands in `activity_events`; pinned Task 2.
5. **Notice upsert SK stability** — Dynamo keyed `NOTICE` / `${createdAt}#${noticeId}`; PG upsert by `notice_id` must preserve `created_at` on update (same as today’s `existingNotice?.createdAt`); pinned Task 3.
6. **Empty tables before backfill** — do not deploy C.2.2 readers against empty lead/notice tables if staging had Dynamo data; pinned Tasks 4–5 (runbook).

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Reuse **`CRM_STORE`**; no new store flag. |
| D2 | Migration filename **`007_portal_leads_notices.sql`**. |
| D3 | Tables: **`portal_leads`**, **`portal_notices`**. |
| D4 | Lead list = `order by created_at desc, lead_id desc` with default limit 50 (parity with GSI `STATUS#LEAD_NEW` scanForward false). |
| D5 | No lead `status` column — every row is “new”. |
| D6 | Notice columns match `NoticeSchema`; public filter stays in domain (published / expiry / country / pin) after SQL list. |
| D7 | Backfill script: **`backfill:leads-notices-postgres`**. |
| D8 | No infra Lambda env changes (user API already wired in C.2.1). |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/db/migrations/007_portal_leads_notices.ts` | DDL |
| `services/api/src/db/migrate.ts` | Register 007 after 006 |
| `services/api/src/domain/leadsPostgres.ts` | Lead SQL |
| `services/api/src/domain/leads.ts` | Dispatch create/list |
| `services/api/src/domain/noticesPostgres.ts` | Notice SQL |
| `services/api/src/domain/notices.ts` | Dispatch list/upsert/delete |
| `services/migration/src/backfillLeadsNoticesToPostgres.ts` | Backfill |
| `services/migration/src/backfillLeadsNoticesToPostgresCli.ts` | CLI |
| `services/migration/package.json` | Script entry |
| `docs/superpowers/specs/2026-10-02-supabase-phase-c2-2-staging-runbook.md` | Cutover |

---

### Task 1: Migration `007_portal_leads_notices`

**Files:**
- Create: `services/api/src/db/migrations/007_portal_leads_notices.ts`
- Modify: `services/api/src/db/migrate.ts` — register after 006
- Test: `services/api/test/migratePortalLeadsNotices.test.ts`

**Interfaces — `MIGRATION_SQL` (no `;` in comments; `applyMigrations` splits on `;`):**

```sql
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
```

**Produces:** `MIGRATION_FILENAME = "007_portal_leads_notices.sql"`; `MIGRATION_SQL` as above; registered in `migrate.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// services/api/test/migratePortalLeadsNotices.test.ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import { MIGRATION_SQL } from "../src/db/migrations/007_portal_leads_notices";
import type { SqlClient } from "../src/lib/sql";
import { pgliteAsSqlClient } from "./pgliteSqlClient";

async function migratedClient(): Promise<SqlClient> {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  return sql;
}

describe("applyMigrations 007_portal_leads_notices", () => {
  it("has no semicolons inside comments", () => {
    const commentLines = MIGRATION_SQL.split("\n").filter((line) => line.trim().startsWith("--"));
    for (const line of commentLines) {
      expect(line).not.toContain(";");
    }
  });

  it("creates portal_leads and portal_notices", async () => {
    const sql = await migratedClient();
    const tables = await sql.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('portal_leads', 'portal_notices')
       order by table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(["portal_leads", "portal_notices"]);
    await sql.end();
  });

  it("creates the key indexes", async () => {
    const sql = await migratedClient();
    const indexes = await sql.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "portal_leads_created",
        "portal_notices_created",
        "portal_notices_status_pinned_published",
      ]),
    );
    await sql.end();
  });

  it("is idempotent when applied twice", async () => {
    const sql = await migratedClient();
    await applyMigrations(sql);
    const applied = await sql.query<{ filename: string }>(
      `select filename from schema_migrations where filename = '007_portal_leads_notices.sql'`,
    );
    expect(applied.rows).toHaveLength(1);
    await sql.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/api && npx vitest run test/migratePortalLeadsNotices.test.ts`
Expected: FAIL (module / registration missing)

- [ ] **Step 3: Write minimal implementation**

Create `007_portal_leads_notices.ts` exporting `MIGRATION_FILENAME` + `MIGRATION_SQL`. Register in `migrate.ts` after 006 (same import pattern as `006_portal_sor`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/api && npx vitest run test/migratePortalLeadsNotices.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/api/src/db/migrations/007_portal_leads_notices.ts \
  services/api/src/db/migrate.ts \
  services/api/test/migratePortalLeadsNotices.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add portal leads and notices migration 007

EOF
)"
```

---

### Task 2: Leads on Postgres

**Files:**
- Create: `services/api/src/domain/leadsPostgres.ts`
- Modify: `services/api/src/domain/leads.ts` — `createLead`, `listNewLeads`
- Test: `services/api/test/leadsPostgres.test.ts`

**Interfaces:**

```ts
import type { Lead } from "./leads"; // or co-locate Lead type — keep Lead + CreateLeadSchema in leads.ts
import type { SqlClient } from "../lib/sql";

export async function insertLeadPostgres(sql: SqlClient, lead: Lead): Promise<void>;
export async function listNewLeadsPostgres(
  sql: SqlClient,
  limit?: number, // default 50
): Promise<Lead[]>;
```

**Dispatch in `leads.ts`:**

```ts
import { crmPostgresOf } from "./crm/postgresClient";
import { insertLeadPostgres, listNewLeadsPostgres } from "./leadsPostgres";

export async function createLead(context: AppContext, input: CreateLeadInput): Promise<Lead> {
  // ... build lead as today ...
  const sql = crmPostgresOf(context);
  if (sql) {
    await insertLeadPostgres(sql, lead);
  } else {
    await context.table.put({ /* existing LEAD# / STATUS#LEAD_NEW put */ });
  }
  await logActivity(/* unchanged */);
  await context.email.send(/* unchanged */);
  return lead;
}

export async function listNewLeads(context: AppContext, limit = 50): Promise<Lead[]> {
  const sql = crmPostgresOf(context);
  if (sql) return listNewLeadsPostgres(sql, limit);
  // existing GSI path
}
```

**SQL:**

```sql
insert into portal_leads (lead_id, full_name, phone, topic, message, created_at)
values ($1, $2, $3, $4, $5, $6::timestamptz)
on conflict (lead_id) do update set
  full_name = excluded.full_name,
  phone = excluded.phone,
  topic = excluded.topic,
  message = excluded.message,
  created_at = excluded.created_at;

select lead_id, full_name, phone, topic, message,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
  from portal_leads
 order by created_at desc, lead_id desc
 limit $1;
```

Map columns ↔ camelCase (`leadId`, `fullName`, …) via `candidateFromColumns` / `isoTimestampSql` like `userProfilesPostgres.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// services/api/test/leadsPostgres.test.ts — outline
describe("leads with CRM_STORE=postgres", () => {
  it("creates a lead in Postgres and leaves Dynamo without LEAD# / STATUS#LEAD_NEW", async () => {
    const lead = await createLead(context, {
      fullName: "Smoke Lead",
      phone: "+919999999999",
      topic: "UAE visa",
      message: "hello",
    });
    expect(await listNewLeadsPostgres(sql, 50)).toEqual(
      expect.arrayContaining([expect.objectContaining({ leadId: lead.leadId })]),
    );
    expect(await baseContext.table.get(`LEAD#${lead.leadId}`, "PROFILE")).toBeUndefined();
    const gsi = await baseContext.table.queryGsi("GSI1", "STATUS#LEAD_NEW");
    expect(gsi.filter((i) => i["leadId"] === lead.leadId)).toHaveLength(0);
  });

  it("lists newest first with limit", async () => { /* insert 3 with clock advance; list limit 2 */ });

  it("keeps the Dynamo path when CRM_STORE is not postgres", async () => {
    const lead = await createLead(baseContext, { /* ... */ });
    expect(await baseContext.table.get(`LEAD#${lead.leadId}`, "PROFILE")).toBeTruthy();
  });
});
```

Also pin: with `crmStore: "postgres"` and **no** `sql`, `createLead` throws (via `crmPostgresOf`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/api && npx vitest run test/leadsPostgres.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `leadsPostgres.ts` + dispatch**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/api && npx vitest run test/leadsPostgres.test.ts`
Expected: PASS. Also: `npx vitest run test/leads.test.ts` (if present) or any existing lead tests still green.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/leadsPostgres.ts \
  services/api/src/domain/leads.ts \
  services/api/test/leadsPostgres.test.ts
git commit -m "$(cat <<'EOF'
feat(api): store portal leads in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 3: Notices on Postgres

**Files:**
- Create: `services/api/src/domain/noticesPostgres.ts`
- Modify: `services/api/src/domain/notices.ts` — `listNotices`, `upsertNotice`, `deleteNotice` (and thus `listPublicNotices` via `listNotices`)
- Test: `services/api/test/noticesPostgres.test.ts`

**Interfaces:**

```ts
import type { Notice } from "@rgs/shared";
import type { SqlClient } from "../lib/sql";

export async function upsertNoticePostgres(sql: SqlClient, notice: Notice): Promise<void>;
export async function getNoticePostgres(
  sql: SqlClient,
  noticeId: string,
): Promise<Notice | undefined>;
export async function listNoticesPostgres(
  sql: SqlClient,
): Promise<{ notices: Notice[]; unreadableNoticeIds: string[] }>;
export async function deleteNoticePostgres(sql: SqlClient, noticeId: string): Promise<boolean>;
// returns false if no row deleted (caller throws notFound)
```

**Dispatch:**

- `listNotices`: if `crmPostgresOf` → `listNoticesPostgres`; else existing partition query.
- `upsertNotice`: build `Notice` as today (preserve `createdAt` / `publishedAt` / `createdByEmail` rules). If sql → `upsertNoticePostgres`; else Dynamo put. Keep `NOTICE_PUBLISHED` `logActivity` after successful write when status is `PUBLISHED`.
- `deleteNotice`: if sql → `deleteNoticePostgres` or `notFound`; else existing find+delete.
- `findNoticeItem` Dynamo helper stays for dynamo path only; under postgres use `getNoticePostgres` for “existing” in upsert.

**SQL upsert** (preserve created_at on conflict):

```sql
insert into portal_notices (
  notice_id, title, body, category, severity, country_code, pinned, status,
  published_at, expires_at, created_at, updated_at, created_by_email
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::date,$11::timestamptz,$12::timestamptz,$13
)
on conflict (notice_id) do update set
  title = excluded.title,
  body = excluded.body,
  category = excluded.category,
  severity = excluded.severity,
  country_code = excluded.country_code,
  pinned = excluded.pinned,
  status = excluded.status,
  published_at = excluded.published_at,
  expires_at = excluded.expires_at,
  updated_at = excluded.updated_at,
  created_by_email = excluded.created_by_email;
-- do NOT overwrite created_at on conflict
```

List: `order by created_at desc, notice_id desc`. Parse via `NoticeSchema` + `collectReadableRecords` (same unreadable naming as Dynamo).

`listPublicNotices` keeps existing filter/sort on the `notices` array from `listNotices` — do not reimplement filter in SQL in this task (YAGNI; parity with today).

- [ ] **Step 1: Write the failing tests**

```ts
describe("notices with CRM_STORE=postgres", () => {
  it("upserts a draft then publishes; Dynamo NOTICE partition stays empty", async () => {
    const draft = await upsertNotice(context, "admin@example.com", {
      title: "UAE fee change notice",
      body: "Fees update next week for tourist visas.",
      category: "FEE_CHANGE", // use real NOTICE_CATEGORIES value from shared
      severity: "INFO",
      status: "DRAFT",
    });
    const published = await upsertNotice(context, "admin@example.com", {
      noticeId: draft.noticeId,
      title: draft.title,
      body: draft.body,
      category: draft.category,
      severity: draft.severity,
      status: "PUBLISHED",
    });
    expect(published.publishedAt).toBeTruthy();
    expect(published.createdAt).toBe(draft.createdAt);
    expect(await context.table.query("NOTICE")).toHaveLength(0);
    const listed = await listNotices(context);
    expect(listed.notices.map((n) => n.noticeId)).toContain(draft.noticeId);
  });

  it("names an unreadable notice id and still returns readable ones", async () => {
    // insert valid via upsert; raw sql insert corrupt title ''; listNotices names id
  });

  it("listPublicNotices filters unpublished and expired", async () => { /* ... */ });

  it("deleteNotice removes the PG row", async () => { /* ... */ });

  it("keeps Dynamo path when CRM_STORE is not postgres", async () => { /* ... */ });
});
```

Use exact `NOTICE_CATEGORIES` / `NOTICE_SEVERITIES` / `NOTICE_STATUSES` values from `@rgs/shared` (read `packages/shared/src/statuses.ts` or schemas — do not invent enums).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/api && npx vitest run test/noticesPostgres.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement + dispatch**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/api && npx vitest run test/noticesPostgres.test.ts test/notices.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/noticesPostgres.ts \
  services/api/src/domain/notices.ts \
  services/api/test/noticesPostgres.test.ts
git commit -m "$(cat <<'EOF'
feat(api): store portal notices in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 4: Backfill leads + notices

**Files:**
- Create: `services/migration/src/backfillLeadsNoticesToPostgres.ts`
- Create: `services/migration/src/backfillLeadsNoticesToPostgresCli.ts`
- Modify: `services/migration/package.json` — add `"backfill:leads-notices-postgres": "tsx src/backfillLeadsNoticesToPostgresCli.ts"`
- Test: `services/migration/test/backfillLeadsNoticesToPostgres.test.ts`

**Interfaces:**

```ts
export interface BackfillLeadsNoticesResult {
  leadsUpserted: number;
  noticesUpserted: number;
  unreadableLeadIds: string[];
  unreadableNoticeIds: string[];
}

export async function backfillLeadsNoticesToPostgres(args: {
  table: TableClient; // same type as other backfills (DynamoTableClient / test fake)
  sql: SqlClient;
  onProgress?: (label: string, n: number) => void;
}): Promise<BackfillLeadsNoticesResult>;
```

**Behaviour:**

1. `await applyMigrations(sql)` first.
2. **Leads:** `table.queryGsi("GSI1", "STATUS#LEAD_NEW")` (paginate if the client supports pages — drain all pages like portal backfill). Strip PK/SK/GSI keys; parse into `Lead` shape (`leadId`, `fullName`, `phone`, `topic`, `message`, `createdAt`). Upsert via `insertLeadPostgres` (or shared upsert). Corrupt → name in `unreadableLeadIds`, continue.
3. **Notices:** `table.query("NOTICE")`. Parse via same `NoticeSchema` path as domain (or `parseStoredRecord`). Upsert via `upsertNoticePostgres`. Corrupt → `unreadableNoticeIds`.
4. Idempotent second run: same counts / same PG state.
5. Do **not** read `CRM_STORE`; CLI only needs `TABLE_NAME` + `DATABASE_URL`.
6. CLI: `console.table` upserted + unreadable counts; print named ids to stderr; `process.exitCode = 1` if any unreadable list non-empty. Mirror `backfillPortalSoRToPostgresCli.ts` structure.

- [ ] **Step 1: Write the failing tests**

```ts
describe("backfillLeadsNoticesToPostgres", () => {
  it("copies leads and notices from Dynamo into Postgres", async () => {
    // put LEAD# + NOTICE items on fake table; run backfill; assert PG rows
  });

  it("is idempotent on a second run", async () => { /* same upserted counts; same PG */ });

  it("names unreadable leads and notices and still copies the rest", async () => {
    // corrupt lead missing fullName; corrupt notice; one good of each
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd services/migration && npx vitest run test/backfillLeadsNoticesToPostgres.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement backfill + CLI + package.json script**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/migration && npx vitest run test/backfillLeadsNoticesToPostgres.test.ts`
Expected: PASS. Also `pnpm --filter @rgs/migration typecheck` if available.

- [ ] **Step 5: Commit**

```bash
git add services/migration/src/backfillLeadsNoticesToPostgres.ts \
  services/migration/src/backfillLeadsNoticesToPostgresCli.ts \
  services/migration/test/backfillLeadsNoticesToPostgres.test.ts \
  services/migration/package.json
git commit -m "$(cat <<'EOF'
feat(migration): backfill portal leads and notices into Postgres

EOF
)"
```

---

### Task 5: Staging runbook

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-supabase-phase-c2-2-staging-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c2-2-leads-notices-design.md` — status → approved (implementation plan landed); Runbook link
- Modify: `docs/superpowers/specs/2026-10-02-supabase-phase-c2-1-staging-runbook.md` — Related: pointer that leads/notices close via C.2.2 runbook

**Must include (mirror C.2.1 runbook layout):**

- Staging target: `rgs_staging`, project `kblgpjwqqixkcnbdfzsn`, `ap-south-1`
- Freshness: no dual-write; never re-run `backfill:leads-notices-postgres` (or A–C.2.1 backfills) after deploy
- Preconditions: C.2.1 live; `CRM_STORE=postgres` on admin + user + reminders; migrations 001–006 applied
- §1 migrate 007 (session URL)
- §2 `backfill:leads-notices-postgres` with `TABLE_NAME=rgs-platform-staging`; gate exit 0 + all `unreadable*` = 0
- §3 count parity SQL vs backfill summary vs Dynamo (`STATUS#LEAD_NEW`, `NOTICE` partition)
- §4 deploy no flag flip; confirm user API still has `CRM_STORE` + `DATABASE_URL` (no new wiring)
- §5 smoke: marketing lead; admin leads; public notices; admin upsert/publish/delete; activity events; Dynamo silent for new lead/notice
- §6 rollback: `RGS_CRM_STORE=dynamo` redeploy admin+user+reminders
- Env table; Related runbooks including C.2.1

- [ ] **Step 1: Write the runbook + update design/C.2.1 related links**

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-supabase-phase-c2-2-staging-runbook.md \
  docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c2-2-leads-notices-design.md \
  docs/superpowers/specs/2026-10-02-supabase-phase-c2-1-staging-runbook.md
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase C.2.2 staging cutover runbook

EOF
)"
```

---

## Self-review

| Spec requirement | Task |
|---|---|
| Migration 007 / `portal_leads` + `portal_notices` | T1 |
| Leads create/list under `CRM_STORE` | T2 |
| Notices list/upsert/delete + public filter + unreadable naming | T3 |
| Backfill + CLI gate | T4 |
| Staging runbook + rollback + no re-run | T5 |
| No Phase D / no dual-write / no new flag | Global + all tasks |
| User API already wired | D8 / runbook §4 |

Placeholder scan: none. Interfaces consistent across T2–T4 (`insertLeadPostgres` / `upsertNoticePostgres`). Review Focus items pinned to tasks.

---

## Execution handoff

Plan complete. Prefer **subagent-driven** (5 tasks, clear interfaces, staging blast radius if wrong). Native OK if you want speed.
