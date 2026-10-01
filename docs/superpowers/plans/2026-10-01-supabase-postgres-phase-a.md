# Supabase Postgres Phase A — CRM Ledger reads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the CRM Ledger (list, search, combined filters, export feed) from Supabase Postgres after an idempotent Dynamo→Postgres backfill, while Dynamo remains the write authority.

**Architecture:** Add a `SqlClient` (`pg` pool → Supabase transaction pooler) beside `TableClient`. Store CRM case ledger projections (+ partners for name search) in Postgres. Feature-flag `LEDGER_STORE=postgres|dynamo` switches `GET /crm/cases/ledger`. Admin sends the full filter set as query params; Postgres path applies them in SQL. No Cognito/S3/SES changes. Phase B (writes) is out of this plan.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, `@electric-sql/pglite` (tests), plain SQL migration files, existing Lambda/CDK, Cognito JWT auth unchanged.

**Spec:** `docs/superpowers/specs/2026-10-01-supabase-postgres-migration-design.md` (Phase A only)

## Global Constraints

- Spec decisions 1–8 closed; do not reopen (Supabase = Postgres+pooler; Cognito/S3/SES stay; phased CRM-first; no big-bang).
- Phase A: **Dynamo remains SoR for writes.** Do not dual-write unless a later plan says so.
- Descriptive names only (no `e`/`x`/`res`/`tmp` outside trivial indexes).
- Match comment density / named-field construction of neighboring CRM code.
- Conventional commits; one commit per task after that task’s tests pass.
- Prefer feature branch / worktree (e.g. `.worktrees/supabase-ledger-reads`).
- Do not deploy prod or create paid Supabase projects without the owner asking.
- Staging + prod = separate Supabase projects (operator step).
- Lambdas must use the **pooler** connection string (transaction mode), never the direct session URL, in deployed env.

## Review Focus

1. **`LEDGER_STORE` unset / `dynamo`** — ledger path unchanged (GSI); pinned Task 6.
2. **`LEDGER_STORE=postgres` but `DATABASE_URL` missing** — handler fails loud at cold start / route returns 503 with clear message; never silent empty ledger; pinned Task 3 + Task 6.
3. **Backfill re-run** — upserts by `case_id` / `partner_id`; no duplicate ledger rows; pinned Task 4.
4. **Corrupt META that fails `LedgerRowSchema`** — named in `unreadableCaseIds`, not silently omitted; pinned Task 4 + Task 5.
5. **Combined filters (status + partner + country + search)** — one SQL query; Dynamo XOR compromise not applied on postgres path; pinned Task 5–7.
6. **Cursor issued for filter A reused with filter B** — 400, same discipline as today’s `scopeKey`; pinned Task 5.

## Open points resolved (this plan)

| Spec open point | Choice |
|---|---|
| Migration tool | Plain SQL files under `services/api/src/db/migrations/` + small `applyMigrations` runner (`pg` / PGlite). No Drizzle in Phase A. |
| Region | Operator creates Supabase project in `ap-south-1` if offered; else nearest Asia region. Document chosen region in staging notes. |
| Dual-write | **None in Phase A.** Re-run backfill before flip; after flip, re-backfill on a schedule or before demos until Phase B. |
| Phase C | Deferred — separate plan after Phase B. |
| CI DB | `@electric-sql/pglite` in Vitest for migration + SQL repository tests. No Docker required. |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/lib/sql.ts` | `SqlClient` interface, `PgSqlClient`, env parsing |
| `services/api/src/db/migrations/001_crm_ledger.sql` | `crm_partners`, `crm_cases` (+ indexes) |
| `services/api/src/db/migrate.ts` | Apply migrations in order |
| `services/api/src/lib/context.ts` | Optional `sql?: SqlClient` on `AppContext` |
| `services/api/src/http/handler.ts` | Build pool when `DATABASE_URL` set |
| `infra/lib/rgs-platform-stack.ts` | `DATABASE_URL`, `LEDGER_STORE` env (from SSM/Secrets or plain staging secret) |
| `services/api/src/domain/crm/ledgerPostgres.ts` | `listLedgerRowsFromPostgres` |
| `services/api/src/domain/crm/ledger.ts` | Keep Dynamo path; shared types/cursors if extracted |
| `services/api/src/http/crmApi.ts` | Parse expanded filters; dispatch by `LEDGER_STORE` |
| `services/migration/src/backfillCrmLedgerToPostgres.ts` (+ cli) | Dynamo META → upsert |
| `apps/admin/src/crm/api/crmClient.ts` | Pass client filters as query params |
| `apps/admin/src/crm/api/hooks.ts` / `LedgerPage.tsx` | Include filters in query key; rely on server filter when store=postgres (see Task 7) |

---

### Task 1: `SqlClient` + `pg` dependency

**Files:**
- Modify: `services/api/package.json` (add `pg`, `@types/pg`; dev `@electric-sql/pglite`)
- Create: `services/api/src/lib/sql.ts`
- Create: `services/api/test/sql.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
    rows: T[];
    rowCount: number;
  }
  export interface SqlClient {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<SqlQueryResult<T>>;
    /** End the pool (tests / Lambda freeze optional). */
    end(): Promise<void>;
  }
  export function databaseUrlFromEnvironment(
    environment: NodeJS.ProcessEnv,
  ): string | undefined;
  export function createPgSqlClient(databaseUrl: string): SqlClient;
  ```

- [ ] **Step 1: Failing test — URL parse**

```ts
import { describe, expect, it } from "vitest";
import { databaseUrlFromEnvironment } from "../src/lib/sql";

describe("databaseUrlFromEnvironment", () => {
  it("returns undefined when DATABASE_URL is missing", () => {
    expect(databaseUrlFromEnvironment({})).toBeUndefined();
  });

  it("returns the trimmed URL when set", () => {
    expect(
      databaseUrlFromEnvironment({ DATABASE_URL: "  postgresql://user:pass@host:6543/postgres  " }),
    ).toBe("postgresql://user:pass@host:6543/postgres");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

Run: `pnpm --filter @rgs/api test test/sql.test.ts`

- [ ] **Step 3: Implement `sql.ts` + add deps**

```ts
import pg from "pg";

export interface SqlQueryResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>>;
  end(): Promise<void>;
}

export function databaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const rawUrl = environment["DATABASE_URL"];
  if (rawUrl === undefined) return undefined;
  const trimmedUrl = rawUrl.trim();
  return trimmedUrl.length > 0 ? trimmedUrl : undefined;
}

export function createPgSqlClient(databaseUrl: string): SqlClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Transaction pooler: keep low; many concurrent Lambdas share Supabase pool.
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async end() {
      await pool.end();
    },
  };
}
```

Install: `pnpm --filter @rgs/api add pg && pnpm --filter @rgs/api add -D @types/pg @electric-sql/pglite`

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add services/api/package.json services/api/src/lib/sql.ts services/api/test/sql.test.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): add SqlClient and DATABASE_URL helper for Supabase

EOF
)"
```

---

### Task 2: CRM ledger schema + migration runner

**Files:**
- Create: `services/api/src/db/migrations/001_crm_ledger.sql`
- Create: `services/api/src/db/migrate.ts`
- Create: `services/api/test/migrateCrmLedger.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function applyMigrations(sql: SqlClient): Promise<void>;
  // Tables: crm_partners(tenant_id, partner_id PK, canonical_name, contact_email, updated_at)
  //         crm_cases(... ledger columns ..., PRIMARY KEY (tenant_id, case_id))
  ```

- [ ] **Step 1: Failing test — PGlite applies 001 and creates tables**

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrate";
import type { SqlClient } from "../src/lib/sql";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query(text, values = []) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

describe("applyMigrations 001_crm_ledger", () => {
  it("creates crm_cases and crm_partners", async () => {
    const database = new PGlite();
    const sql = pgliteAsSqlClient(database);
    await applyMigrations(sql);
    const tables = await sql.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename in ('crm_cases','crm_partners') order by tablename`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual(["crm_cases", "crm_partners"]);
    await sql.end();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write SQL + runner**

`001_crm_ledger.sql`:

```sql
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
```

`migrate.ts`: read migration files in order, skip if `schema_migrations` already has filename, else run file in a transaction and insert filename. Bundle SQL as string imports or `readFileSync` from `import.meta.url` paths — for Lambda, **inline the SQL string in a TS module** `migrations/001_crm_ledger.ts` exporting `FILENAME` + `SQL` so esbuild bundles it (do not rely on loose files on disk in Lambda). Prefer:

```ts
// services/api/src/db/migrations/001_crm_ledger.ts
export const MIGRATION_FILENAME = "001_crm_ledger.sql";
export const MIGRATION_SQL = `...`;
```

and keep a `.sql` copy only if useful for humans — or single `.ts` source of truth.

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): add CRM ledger Postgres schema migration

EOF
)"
```

---

### Task 3: Wire `AppContext.sql` + handler env

**Files:**
- Modify: `services/api/src/lib/context.ts`
- Modify: `services/api/src/http/handler.ts`
- Modify: `infra/lib/rgs-platform-stack.ts` (env keys; values from context/stage props — empty in synth if unset)
- Modify: test helpers that build `AppContext` (add optional `sql`)
- Test: `services/api/test/handlerContextSql.test.ts` (or extend existing handler/env test)

**Interfaces:**
- Produces: `AppContext.sql?: SqlClient`
- Produces: `ledgerStoreFromEnvironment(env) => "dynamo" | "postgres"`
- Consumes: `databaseUrlFromEnvironment`, `createPgSqlClient`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { ledgerStoreFromEnvironment } from "../src/lib/sql"; // or lib/ledgerStore.ts

describe("ledgerStoreFromEnvironment", () => {
  it("defaults to dynamo", () => {
    expect(ledgerStoreFromEnvironment({})).toBe("dynamo");
  });
  it("accepts postgres", () => {
    expect(ledgerStoreFromEnvironment({ LEDGER_STORE: "postgres" })).toBe("postgres");
  });
  it("rejects unknown values", () => {
    expect(() => ledgerStoreFromEnvironment({ LEDGER_STORE: "banana" })).toThrow(/LEDGER_STORE/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export type LedgerStore = "dynamo" | "postgres";

export function ledgerStoreFromEnvironment(environment: NodeJS.ProcessEnv): LedgerStore {
  const rawStore = environment["LEDGER_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "dynamo";
  if (rawStore === "dynamo" || rawStore === "postgres") return rawStore;
  throw new Error(`LEDGER_STORE must be dynamo or postgres, got ${rawStore}`);
}
```

In `handler.ts` admin context build: if `databaseUrlFromEnvironment` set, `createPgSqlClient` and attach `.sql`. If `LEDGER_STORE=postgres` and no URL, **throw at startup** (fail deploy/cold start loudly).

CDK: add to shared Lambda env:

```ts
DATABASE_URL: process.env.RGS_DATABASE_URL ?? "", // filled by deploy pipeline / context
LEDGER_STORE: process.env.RGS_LEDGER_STORE ?? "dynamo",
```

Document in plan commit message / short `docs/superpowers/specs/` note: staging deploy must set `RGS_DATABASE_URL` to Supabase **pooler** URI (`:6543`, `?pgbouncer=true` if required by Supabase).

- [ ] **Step 3: Tests PASS + typecheck**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): wire optional SqlClient and LEDGER_STORE into admin handler

EOF
)"
```

---

### Task 4: Backfill Dynamo → `crm_cases` / `crm_partners`

**Files:**
- Create: `services/migration/src/backfillCrmLedgerToPostgres.ts`
- Create: `services/migration/src/backfillCrmLedgerToPostgresCli.ts`
- Modify: `services/migration/package.json` (script + `pg` if not via `@rgs/api`)
- Test: `services/migration/test/backfillCrmLedgerToPostgres.test.ts`

**Interfaces:**
- Consumes: Dynamo `TableClient` / existing case META GSI scan patterns (`listCaseRefsByStatus` or META projection like ledger), `SqlClient`, `applyMigrations`
- Produces:
  ```ts
  export interface BackfillCrmLedgerResult {
    partnersUpserted: number;
    casesUpserted: number;
    unreadableCaseIds: string[];
  }
  export async function backfillCrmLedgerToPostgres(options: {
    table: TableClient;
    sql: SqlClient;
    tenantId: string;
  }): Promise<BackfillCrmLedgerResult>;
  ```

- [ ] **Step 1: Failing test — upserts a projected META row; second run does not duplicate**

Use InMemoryTableClient with one META case item (same shape `writeCase` puts) + PGlite after migrations. Assert `count(*) = 1` after two runs. Assert a deliberately corrupt META (missing `caseRef`) lands in `unreadableCaseIds` and is not inserted.

- [ ] **Step 2: Implement upsert SQL**

```sql
insert into crm_cases (
  tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
  visa_type, group_name, case_status, billing_status, received_date,
  appointment_date, expected_collection_date, total_inr, updated_at,
  applicant_summary, search_text
) values (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
)
on conflict (tenant_id, case_id) do update set
  case_ref = excluded.case_ref,
  partner_id = excluded.partner_id,
  -- ... all projected columns ...
  search_text = excluded.search_text;
```

Same pattern for `crm_partners` from partner META list GSI.

CLI: require `RGS_TABLE_NAME` / existing Dynamo env helpers + `DATABASE_URL`; call `applyMigrations` then backfill.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): backfill CRM ledger projections into Postgres

EOF
)"
```

---

### Task 5: `listLedgerRowsFromPostgres`

**Files:**
- Create: `services/api/src/domain/crm/ledgerPostgres.ts`
- Create: `services/api/test/crm/ledgerPostgres.test.ts`
- Optionally extract shared cursor helpers from `ledger.ts` if duplication hurts — only if needed

**Interfaces:**
- Produces:
  ```ts
  export interface PostgresLedgerQuery {
    statuses: crm.CaseStatus[]; // empty = no status filter
    partnerId?: string;
    destinationCountry?: string;
    caseType?: crm.CaseType;
    billingStatuses?: crm.BillingStatus[];
    appointmentDateOn?: string; // YYYY-MM-DD
    expectedCollectionDateOn?: string;
    search?: string;
    limit: number;
    cursor?: string;
  }
  export async function listLedgerRowsFromPostgres(
    sql: SqlClient,
    tenantId: string,
    query: PostgresLedgerQuery,
  ): Promise<LedgerPage>; // same LedgerPage as ledger.ts
  ```

- [ ] **Step 1: Failing PGlite tests**

Seed 3 cases (different status/partner/country). Assert:
- filter status+partner+country returns 1
- search matches `case_ref` and `search_text` and partner `canonical_name` (join `crm_partners`)
- bad cursor / wrong scopeKey → throws with message matching today’s ledger cursor errors (use same `badRequest` helper)
- row that cannot map through `LedgerRowSchema` → `unreadableCaseIds`

- [ ] **Step 2: Implement SQL builder**

Use parameterized `WHERE tenant_id = $1 AND (...)` fragments. Sort default `received_date DESC, case_id DESC` for stable cursors. Keyset or offset cursor is fine for Phase A; prefer **keyset** on `(received_date, case_id)` encoded in base64url JSON with `scopeKey` hash of normalized filters (sorted statuses, etc.) — refuse mismatched scope.

Map DB snake_case → `LedgerRow` camelCase before `LedgerRowSchema.parse`.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): list CRM ledger rows from Postgres with combined filters

EOF
)"
```

---

### Task 6: HTTP dispatch by `LEDGER_STORE`

**Files:**
- Modify: `services/api/src/http/crmApi.ts`
- Modify: `services/api/test/crm/crmApi.test.ts` (or ledger HTTP tests)
- Modify: `services/api/src/lib/context.ts` if store flag should live on context (optional `ledgerStore: LedgerStore`)

**Interfaces:**
- Consumes: `listLedgerRows`, `listLedgerRowsFromPostgres`, `context.sql`, `ledgerStore`
- Expands query parsing: `destinationCountry`, `caseType`, `billingStatus` (comma list), `appointmentDateOn`, `expectedCollectionDateOn`, `search`
- `appliedQuery` on postgres path includes the filters actually applied (status **and** partner allowed together)

- [ ] **Step 1: Failing API tests**

With InMemory table + PGlite sql on context, `LEDGER_STORE=postgres`:
- `GET .../ledger?status=NEW&partnerId=p1&destinationCountry=AE&search=asha` hits SQL path (seed PG only — Dynamo empty) and returns the PG row.
With `LEDGER_STORE=dynamo` (default): ignores PG seed; existing GSI behaviour still passes.

When store=postgres and `context.sql` undefined → 503 / typed error with message containing `DATABASE_URL`.

- [ ] **Step 2: Implement dispatch in ledger route**

```ts
if (ledgerStore === "postgres") {
  if (context.sql === undefined) throw /* serviceUnavailable */ ("Ledger Postgres is enabled but DATABASE_URL is not configured");
  return listLedgerRowsFromPostgres(context.sql, tenantId, { ... });
}
return listLedgerRows(context, tenantId, { statuses, partnerId, limit, cursor });
```

Keep Dynamo path’s “partner XOR status” behaviour unchanged when store=dynamo.

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): serve ledger from Postgres when LEDGER_STORE=postgres

EOF
)"
```

---

### Task 7: Admin client sends full filter query

**Files:**
- Modify: `apps/admin/src/crm/api/crmClient.ts` (`fetchLedgerPage` / `loadLedger` params)
- Modify: `apps/admin/src/crm/api/hooks.ts` (`useLedgerRows` key includes filter fingerprint)
- Modify: `apps/admin/src/crm/ledger/LedgerPage.tsx` — pass `clientLedgerFilters` into the hook; when server returns rows for those filters, either skip re-applying the same filters or keep `applyFilters` as a no-harm safety net (identical predicates)
- Test: `apps/admin/test/crm/` — extend client or LedgerPage tests for query string building

**Interfaces:**
- Produces: `loadLedger(idToken, { statuses, partnerId, destinationCountry, caseType, billingStatuses, appointmentDateOn, expectedCollectionDateOn, search })`

- [ ] **Step 1: Failing test — fetchLedgerPage encodes search + country**

Stub `fetch`; assert URL contains `destinationCountry=AE` and `search=asha`.

- [ ] **Step 2: Wire LedgerPage → hook → client**

Include filters in React Query key so changing search refetches.

**Partner + status together:** stop clearing the other when `LEDGER_STORE` is postgres? Server capabilities differ by env. Safer Phase A approach: **always send both if set**; Dynamo path still XOR (partner wins today). Update UI comment: selecting partner no longer must clear statuses **only if** we also change XOR — to avoid lying chips on Dynamo staging, **keep XOR UI until staging runs postgres**, then in same Task when flipping docs say: on postgres, allow both. Implement: remove XOR clear when `import.meta.env.VITE_LEDGER_COMBINED_FILTERS === "true"` (set true on staging admin build when PG ledger is on).

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): send ledger filters to API for Postgres ledger path

EOF
)"
```

---

### Task 8: Staging runbook (ops, not more product code)

**Files:**
- Create: `docs/superpowers/specs/2026-10-01-supabase-phase-a-staging-runbook.md` (short)

**Steps (checklist in the doc):**

1. Create Supabase project (region note); copy **pooler** URI → SSM/secret / `RGS_DATABASE_URL`.
2. From laptop: `DATABASE_URL=... pnpm --filter @rgs/api exec tsx -e '...'` or a small `pnpm --filter @rgs/migration migrate:crm-ledger` that only runs `applyMigrations`.
3. Backfill: `pnpm --filter @rgs/migration backfill:crm-ledger-postgres` against staging Dynamo + Supabase.
4. Compare counts: Dynamo `countCasesByField` / GSI totals vs `select count(*) from crm_cases`.
5. Deploy admin API with `LEDGER_STORE=postgres` + `DATABASE_URL`.
6. Smoke: open Ledger Live work, search, partner+status if combined flag on, export.
7. Rollback: set `LEDGER_STORE=dynamo`, redeploy (Postgres data kept).

- [ ] **Step 1: Write runbook**
- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase A staging runbook

EOF
)"
```

---

## Out of this plan (Phase B+)

- Case/partner/traveller **writes** to Postgres
- Dual-write
- Visa-platform tables (applications, config, …)
- Dropping Dynamo
- Supabase Auth / Storage
- `tsvector` polish (optional follow-up; `ILIKE` / `position` OK for Phase A)

## Spec coverage

| Spec Phase A ask | Task |
|---|---|
| Supabase Postgres SoR for ledger reads | 5–6 |
| Pooler / Lambda | 1, 3, runbook |
| Cognito/S3/SES unchanged | (no tasks touch them) |
| Backfill idempotent | 4 |
| Combined filters | 5–7 |
| Staging first / rollback | 8 |
| Separate staging/prod projects | 8 |
| Unreadable rows named | 4–5 |

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-01-supabase-postgres-phase-a.md`.

Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — fresh subagent per task + reviewer between tasks; best when interfaces must stay exact across 8 tasks.
- **Native** — I implement every task in this session, one whole-branch review at the end; faster.

**Recommend Subagent-driven**, because Tasks 1→7 share `SqlClient` / `LedgerPage` / filter contracts and a wrong interface early poisons the backfill and HTTP flip. Does the plan capture what you want, and which approach should we use?
