# RGS — Supabase Postgres Phase D.3 (Dynamo code cleanup)

**Date:** 2026-10-03  
**Status:** approved (owner 2026-10-03 chat: go ahead)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md` § Phase D  
**Prior:** D.1 staging defaults; D.2 orphan+delete staging table; prod cutover + prod table delete (AWS empty of RGS platform tables)  
**Ships:** **one smash** — runtime postgres-only **and** tests/CLIs off Dynamo.  
**Plan:** `docs/superpowers/plans/2026-10-03-supabase-postgres-phase-d3-dynamo-code-cleanup.md`

---

## 1. Why

Live AWS (staging + prod) already serves CRM, portal, catalog, ledger, leads,
and notices from Postgres. Platform Dynamo tables are gone. The repo still
contains a second store: `crmPostgresOf` Dynamo `else` branches,
`DynamoTableClient` / `InMemoryTableClient`, `TABLE_NAME`, CDK `PlatformTable`
on non-staging/non-prod stages, Dynamo→Postgres backfill CLIs, and hundreds of
Vitest suites that seed a fake Dynamo table.

That leftover is not rollback. Tables are deleted. A `CRM_STORE=dynamo` deploy
cannot recover data. Keeping the branch is a silent footgun and a dual-SoR
test harness that no longer matches production.

**Goal:** Repo matches live: Postgres is the only product store. No Dynamo
client, no table in CDK, no in-memory Dynamo fake, no Dynamo→PG backfill
entrypoints. Tests exercise the same SQL adapters Lambdas run.

**Said vs assumed:** Owner said “cleanup dynamo” then “full smash” (runtime +
tests + CLIs together). Assumed: Cognito / S3 / SES stay; git history of
deleted files stays; Excel import remains a product CLI (rewrite to Postgres,
do not leave it writing a missing table).

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | **One smash** for runtime + tests + CLIs | Ship A (runtime only, keep `InMemoryTableClient`) then later B |
| 2 | Postgres is the **only** store. Unset `CRM_STORE` / `LEDGER_STORE` = postgres. Value `dynamo` **fails boot** | Keep dynamo parser for rollback; omit flags and infer only from `DATABASE_URL` |
| 3 | CDK **never** creates `PlatformTable` (including `test` synth). No `TABLE_NAME`, no Dynamo IAM, no TableName output | Leave test-stage table “for local” |
| 4 | `AppContext.table` **removed**. Domain uses `context.sql` (required). `crmPostgresOf` / dual `if (sql)` branches go away | Keep unused `table` field + unavailable stub |
| 5 | Tests use existing **PGlite + `pgliteAsSqlClient` + migrations 001–007**. `buildTestContext` becomes async and always attaches SQL | Testcontainers; keep InMemory as “fast path” |
| 6 | Delete Dynamo-shaped tests (`db.test.ts` key-order/GSI, `tableRetry` Dynamo throttling). Collapse `foo.test.ts` + `fooPostgres.test.ts` to **one** PGlite suite (keep the stronger assertions from both) | Run both harnesses forever |
| 7 | Delete **Dynamo→Postgres** backfill CLIs + tests (tables gone; re-run forbidden). Delete **Dynamo-era** in-table backfills (`summary`, `search-text`, `ref-claims`, `case-status-rename`) | Keep CLIs “for a rainy day” |
| 8 | **Rewrite Excel `importRun` / `import` CLI to Postgres** via existing domain SQL writers | Delete import; leave import on Dynamo |
| 9 | Seed-status-email + country-documents-to-products CLIs that still touch `context.table` move to SQL | Dual-write during cleanup |
| 10 | Fix-forward only. No Dynamo rollback runbook | Recreate tables from snapshot |

---

## 3. Scope

### In

| Area | Change |
|---|---|
| Boot | `buildProductionContext` requires `DATABASE_URL`. Store env unset → postgres; `dynamo` throws. No `TABLE_NAME` |
| Domain | Drop Dynamo `else` in cases, travellers, partners, ledger, reviews, memory, prefs, proposals, templates, ref-claims, catalog, applications, documents metadata, users, activity, leads, notices, admin queues, appointment reminders, agent approval |
| Client | Delete `DynamoTableClient`, `InMemoryTableClient`, `unavailableTableClient`, Dynamo `tableRetry`, AWS Dynamo SDK deps on `@rgs/api` if unused |
| CDK | Remove `aws_dynamodb` table construct, grants, `TABLE_NAME`, `resolveStoreEnv` dynamo default. All stages default postgres. `RGS_*=dynamo` must not produce a healthy template that expects a table (infra tests assert dynamo is rejected or unused) |
| Tests | Async PGlite `buildTestContext`; migrate helper; drop Dynamo unit tests; merge duplicate Postgres files |
| Migration pkg | Delete Dynamo→PG backfills + Dynamo in-place backfills; rewrite import + remaining seeds to SQL |
| Eval | `runIntakeEval` uses PGlite context |
| Docs | Root `README.md` + `services/migration/README.md`: Postgres SoR, import env is `DATABASE_URL` not `TABLE_NAME` |

### Out

- Recreating or querying AWS Dynamo tables.
- Re-running A–C.2.2 backfills against live Postgres.
- Cognito / S3 / SES / CloudFront changes.
- Moving object bytes off S3.
- Ledger UI feature work (combined filters already a Phase A follow-up; do not expand here unless a deleted Dynamo-only code path forces a tiny compile fix).
- Dropping `CRM_STORE` / `LEDGER_STORE` env vars from Lambdas in this smash (keep them set to `postgres` so operators can grep). Parsers still exist; they no longer accept `dynamo`.

---

## 4. Architecture

### Boot

```
DATABASE_URL required
CRM_STORE    unset or postgres → postgres; dynamo → throw
LEDGER_STORE unset or postgres → postgres; dynamo → throw (admin API only, as today)
User API still does not receive LEDGER_STORE
Reminders receive DATABASE_URL + CRM_STORE=postgres
```

`buildProductionContext` builds `sql` from `DATABASE_URL`. It never
constructs a Dynamo client. After a successful parse, callers do not read
store flags off `AppContext`.

### Domain

Every former `const sql = crmPostgresOf(context); if (sql) { … } else { table… }`
becomes a single Postgres function that takes `context.sql` (required). Delete
`crmPostgresOf` (the optional branch). Keep `postgresClientFor` only if some
call sites still need a throw-if-missing helper; otherwise use `context.sql`
directly. Delete Dynamo key helpers that exist only to format `PK`/`SK`/`GSI*`
for table items. Keep domain IDs and Zod schemas.

`AppContext` after this ship:

- **Required:** `documents`, `email`, `adminNotificationAddress`, `now`, `sql`
- **Optional (unchanged purpose):** `llm`, `cognitoAdmins`
- **Gone:** `table`, `crmStore`, `ledgerStore`

Excel import inserts through the **same domain Postgres functions** the API
uses (create case, travellers, partners, etc.), not a parallel SQL writer.

### Tests

`services/api/test/pgliteSqlClient.ts` stays. Add (or extend) a helper that:

1. `new PGlite()`
2. Runs SQL migrations `001`–`007` (same files Lambdas use)
3. Returns `AppContext` with `sql`, in-memory documents/email, fixed clock
4. Seeds status-email templates via the **Postgres** seed path (not table `put`)
5. `afterEach` / caller `sql.end()` so PGlite does not leak

`buildTestContext` today is **sync** and hundreds of callers are sync. Smash
makes it **async**. Every caller awaits. No second “legacy sync Dynamo”
helper.

Where `foo.test.ts` (Dynamo) and `fooPostgres.test.ts` both exist, **one**
file remains: PGlite, covering product behavior. Dynamo-specific assertions
(GSI consistent-read, UTF-8 key order vs ICU, `Limit` on Query, projection
attribute lists for DocumentClient) are deleted, not ported.

### Import CLI

`importRun` today writes cases/partners/travellers through `TableClient`.
After smash it creates the same CRM records through the same Postgres domain
functions the API uses. Dry-run / residue / workbook mapping stay. Tests
(`importRun.test.ts`) use PGlite, not `InMemoryTableClient`.

### CDK

`ownPlatformTable` goes away. No `dynamodb.Table`. Infra tests today that
assert “prod unset → dynamo” and “staging explicit dynamo → dynamo” become:
all stages unset → postgres; explicit dynamo is either ignored-with-fail at
Lambda boot (CDK may still pass the string through) **or** CDK refuses to
synth dynamo. Prefer **CDK still interpolates `RGS_*` when set**, and unit
tests document that `dynamo` is an invalid runtime value — the Lambda must
not be expected to work. Do not add a Dynamo table to make that env “work”.

---

## 5. Cutover

This ship is **code only**. No migrate, no backfill, no table delete.

1. Land smash on `main` (or feature branch then merge).
2. Deploy staging, then prod, with existing `RGS_DATABASE_URL` (flags already
   postgres in live).
3. Smoke: cold start; CRM read/write; portal; public leads/notices.
4. Confirm synth: zero `AWS::DynamoDB::Table`; Lambdas have no `TABLE_NAME`.

Do not set `RGS_CRM_STORE=dynamo` after this lands.

---

## 6. Rollback

Dynamo tables are already gone. Rolling back this commit without a table
leaves the old Dynamo branches calling a missing client.

**Rollback = git revert of D.3 plus an emergency Dynamo rebuild is out of
scope.** Fix-forward on Postgres. If a deploy is bad, revert to the previous
**postgres** artifact (pre-D.3 code still ran postgres in prod).

---

## 7. Testing

- Infra: no Dynamo table on `test` / `staging` / `prod` synth; no `TABLE_NAME`;
  unset store env → postgres on admin, user, reminders (reminders get
  `CRM_STORE` on every stage, not only staging).
- Handler: boot with `DATABASE_URL` and no `TABLE_NAME` succeeds; `CRM_STORE=dynamo`
  throws; missing `DATABASE_URL` throws.
- Domain: existing PGlite suites stay green; former Dynamo suites converted or
  deleted; `pnpm test` (api + migration + infra + admin as today) green.
- Import: at least one workbook-shaped fixture inserts a case into PGlite and
  is readable via `getCase` / ledger list.
- Eval script typechecks / smoke with PGlite if it is in CI; otherwise keep it
  runnable locally.

---

## 8. File map (indicative)

| Area | Location |
|---|---|
| Context / boot | `services/api/src/lib/context.ts`, `http/handler.ts`, `lib/sql.ts` |
| Delete Dynamo client | `services/api/src/lib/db.ts`, `unavailableTableClient.ts`, `tableRetry.ts` |
| Domain | `services/api/src/domain/**`, `agent/approval.ts`, `agent/prefs.ts` |
| Test helper | `services/api/test/helpers.ts`, `pgliteSqlClient.ts` |
| CDK | `infra/lib/rgs-platform-stack.ts`, `infra/test/admin-rbac.test.ts` |
| Backfill delete | `services/migration/src/backfill*ToPostgres*`, Dynamo-era `backfillCli.ts` / search-text / ref-claims / case-status-rename |
| Import rewrite | `services/migration/src/importRun.ts`, `cli.ts`, tests |
| Docs | `README.md`, `services/migration/README.md` |

Implementation checkboxes live in a **D.3 plan** (writing-plans after this
written spec is approved).

---

## 9. Success criteria

1. `rg` / typecheck: no `TableClient`, `InMemoryTableClient`,
   `DynamoTableClient`, `TABLE_NAME` product usage (docs history in
   `docs/superpowers/**` may still mention Dynamo as past tense).
2. CDK synth for test/staging/prod: no `AWS::DynamoDB::Table`.
3. API boots without `TABLE_NAME`; refuses `CRM_STORE=dynamo` /
   `LEDGER_STORE=dynamo`.
4. Domain has no `context.table` reads/writes.
5. Vitest does not instantiate a Dynamo SDK client or in-memory table fake.
6. Excel import writes Postgres.
7. Live deploy is a no-behavior-change for data (already on PG); smoke still
   passes.

---

## 10. Approval

Owner chose **full smash** in chat 2026-10-03. This file is the written spec
gate: review and say if anything is wrong before the implementation plan.
