# Supabase Postgres Phase D.3 — Dynamo Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Dynamo from the RGS repo so Postgres is the only product store: boot, domain, CDK, tests, Excel import, and CLIs.

**Architecture:** Keep each task green. Parsers/boot and CDK land first (they do not flip unit-test `AppContext.crmStore`). Add async PGlite `buildSqlTestContext`, migrate tests onto it in clusters, then delete Dynamo `else` branches, `AppContext.table`, `db.ts`, backfill CLIs, and Dynamo-shaped tests. Excel `importRun` already calls domain functions — once those are SQL-only and the CLI context has `sql`, import follows; delete `TableClient` spies in `importCli`.

**Tech Stack:** Vitest, PGlite (`@electric-sql/pglite`), existing `applyMigrations` / `pgliteAsSqlClient`, AWS CDK, Node `node:test` infra tests.

**Spec:** `docs/superpowers/specs/2026-10-03-supabase-postgres-phase-d3-dynamo-code-cleanup-design.md`

## Global Constraints

- Spec decisions 1–10 closed (one smash; unset store = postgres; `dynamo` fails boot; no CDK table on any stage; `AppContext.table` / `crmStore` / `ledgerStore` gone at end; PGlite tests; delete Dynamo→PG and Dynamo-era in-table backfills; rewrite Excel import onto domain SQL; keep `CRM_STORE`/`LEDGER_STORE` Lambda env set to `postgres`; fix-forward only).
- Do **not** recreate AWS Dynamo tables, re-run A–C.2.2 backfills, or set `RGS_*=dynamo`.
- Do **not** change Cognito / S3 / SES / CloudFront.
- Keep user API without `LEDGER_STORE`.
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-phase-d3-dynamo-code-cleanup` off `main`.
- Historical `docs/superpowers/**` may still mention Dynamo in past tense. Product code must not.

## Review Focus

1. **Unset `CRM_STORE` / `LEDGER_STORE`** — parsers return postgres (not dynamo); pinned Task 1.
2. **`CRM_STORE=dynamo` or `LEDGER_STORE=dynamo`** — `buildProductionContext` throws; pinned Task 1.
3. **Missing `DATABASE_URL`** — boot throws; no Dynamo fallback; pinned Task 1.
4. **CDK `test` / `staging` / `prod`** — zero `AWS::DynamoDB::Table`, no `TABLE_NAME`; reminders always get `CRM_STORE=postgres` when unset; pinned Task 2.
5. **Excel import after table removal** — a mapped fixture creates a case readable via Postgres domain reads; no `context.table`; pinned Task 10.

## Decisions locked in this plan

| # | Choice |
|---|---|
| P1 | `LedgerStore` / `CrmStore` types become `"postgres"` only. Parsers: unset/`""` → `"postgres"`; `"postgres"` ok; `"dynamo"` and any other string throw. |
| P2 | Temporary dual test helpers until Task 8: keep sync `buildTestContext()` (InMemory Dynamo) so unconverted tests stay green; add async `buildSqlTestContext()`. Task 8 deletes the Dynamo helper and renames SQL helper to `buildTestContext`. |
| P3 | Domain strip happens in Task 7 **after** listed product tests use `buildSqlTestContext`. Do not remove `crmPostgresOf` before those tests are converted. |
| P4 | Collapse `foo.test.ts` + `fooPostgres.test.ts` when converting that cluster: keep product assertions; drop Dynamo-only ones (GSI, key byte-order, `tableRetry` throttle). |
| P5 | CDK still copies non-empty `RGS_CRM_STORE` / `RGS_LEDGER_STORE` into Lambda env. Invalid `dynamo` is a **runtime** throw, not a synth error. |
| P6 | Missing-env error string no longer lists `TABLE_NAME`. Required: `DATABASE_URL`, `DOCUMENTS_BUCKET`, `EMAIL_SENDER`, `ADMIN_NOTIFICATION_EMAIL`. |
| P7 | `importRun` stays; `importCli` drops `TableClient` wrappers. Delete Dynamo throttle tests in `importCli.test.ts`. |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/lib/sql.ts` | Parsers; store types |
| `services/api/src/http/handler.ts` | Postgres-only `buildProductionContext` |
| `services/api/test/handlerContextSql.test.ts` | Boot matrix |
| `infra/lib/rgs-platform-stack.ts` | No table; postgres defaults all stages |
| `infra/test/admin-rbac.test.ts` | Synth matrix |
| `services/api/test/helpers.ts` | Dual helpers then SQL-only |
| `services/api/src/lib/context.ts` | Required `sql`; drop `table` / store fields |
| `services/api/src/domain/**`, `agent/**` | SQL-only |
| `services/api/src/lib/db.ts`, `tableRetry.ts`, `unavailableTableClient.ts` | Delete |
| `services/migration/src/backfill*` (Dynamo sources) | Delete |
| `services/migration/src/importCli.ts` | No table spies |
| `README.md`, `services/migration/README.md` | Postgres SoR |

---

### Task 1: Store parsers + production boot (no Dynamo client)

**Files:**
- Modify: `services/api/src/lib/sql.ts`
- Modify: `services/api/src/http/handler.ts`
- Modify: `services/api/test/handlerContextSql.test.ts`

**Interfaces:**

```ts
export type LedgerStore = "postgres";
export type CrmStore = "postgres";

export function ledgerStoreFromEnvironment(environment: NodeJS.ProcessEnv): LedgerStore {
  const rawStore = environment["LEDGER_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "postgres";
  if (rawStore === "postgres") return "postgres";
  throw new Error(`LEDGER_STORE must be postgres, got ${rawStore}`);
}

export function crmStoreFromEnvironment(environment: NodeJS.ProcessEnv): CrmStore {
  const rawStore = environment["CRM_STORE"]?.trim();
  if (rawStore === undefined || rawStore === "") return "postgres";
  if (rawStore === "postgres") return "postgres";
  throw new Error(`CRM_STORE must be postgres, got ${rawStore}`);
}
```

`buildProductionContext` after this task:

- Parse stores with the functions above (so `dynamo` throws before table logic).
- Require `databaseUrlFromEnvironment` — throw `DATABASE_URL is not configured` if missing (drop the old “store is postgres but URL missing” split; URL is always required).
- Require `DOCUMENTS_BUCKET`, `EMAIL_SENDER`, `ADMIN_NOTIFICATION_EMAIL`. Error message must **not** mention `TABLE_NAME`.
- `sql: createPgSqlClient(databaseUrl)` always.
- **Do not** construct `DynamoTableClient` or `unavailableTableClient`. Until Task 7, `AppContext.table` is still required by the type: attach a local stub that `get`/`put`/… **throw** `Error("DynamoDB client removed")` so accidental table use fails loud. Do not import `db.ts` if you can define a 6-method stub inline in `handler.ts`. Prefer importing `unavailableTableClient` **only if** you rewrite its message to `DynamoDB client removed` — delete the `TABLE_NAME unset` wording.
- Stop setting nothing: still assign `ledgerStore` / `crmStore` as `"postgres"` until Task 7 removes those fields.
- Remove `dynamoTableRequired`, `withWriteRetries`, `TABLE_NAME` reads.

- [ ] **Step 1: Rewrite `handlerContextSql.test.ts` to the new matrix**

Replace the file body (keep `vi.resetModules` pattern). `requiredEnv` is:

```ts
const requiredEnv = {
  DOCUMENTS_BUCKET: "rgs-documents",
  EMAIL_SENDER: "noreply@rgs.test",
  ADMIN_NOTIFICATION_EMAIL: "info@rgs.test",
  DATABASE_URL: "postgresql://user:pass@localhost:6543/postgres",
};
```

Cases:

1. Happy path: no `TABLE_NAME`, no store flags → `context.sql` defined, `context.crmStore === "postgres"`, `context.ledgerStore === "postgres"`. `end()` the pool.
2. Explicit `CRM_STORE=postgres` + `LEDGER_STORE=postgres` → same.
3. Missing `DATABASE_URL` → throw `/DATABASE_URL/`.
4. `CRM_STORE=dynamo` → throw `/CRM_STORE must be postgres/`.
5. `LEDGER_STORE=dynamo` → throw `/LEDGER_STORE must be postgres/`.
6. Missing `DOCUMENTS_BUCKET` → throw; message must not match `/TABLE_NAME/`.

Delete old cases: “boots without TABLE_NAME then table.get throws TABLE_NAME unset”, “still requires TABLE_NAME when CRM defaults to dynamo”, “requires TABLE_NAME when LEDGER_STORE=dynamo”.

- [ ] **Step 2: Run the file; expect FAIL** on default-dynamo / TABLE_NAME cases (or missing new throws).

Run: `pnpm --filter @rgs/api exec vitest run test/handlerContextSql.test.ts`

- [ ] **Step 3: Implement parsers + `buildProductionContext` as specified**

- [ ] **Step 4: Re-run the file; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add services/api/src/lib/sql.ts services/api/src/http/handler.ts services/api/test/handlerContextSql.test.ts
git commit -m "$(cat <<'EOF'
fix(api): require postgres store and DATABASE_URL at boot

Unset CRM/LEDGER flags now mean postgres; dynamo fails closed so a
Lambda cannot aim at a deleted table.
EOF
)"
```

---

### Task 2: CDK — no table, postgres on every stage

**Files:**
- Modify: `infra/lib/rgs-platform-stack.ts`
- Modify: `infra/test/admin-rbac.test.ts`

**Interfaces — replace `resolveStoreEnv`:**

```ts
/** When RGS_* unset/empty: postgres. Non-empty env is copied through (runtime rejects dynamo). */
function resolveStoreEnv(envValue: string | undefined): string {
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }
  return "postgres";
}
```

Call as `resolveStoreEnv(process.env.RGS_CRM_STORE)` (drop `stage` argument).

Stack:

- Delete `ownPlatformTable`, `platformTable`, `aws_dynamodb` import, GSI loop, `TABLE_NAME` env, `grantReadWriteData` for Dynamo, `CfnOutput` `TableName`.
- Admin + user: always `DATABASE_URL` (`RGS_DATABASE_URL ?? ""`) + `CRM_STORE` from helper.
- Admin: `LEDGER_STORE` from helper.
- Reminders: always set `CRM_STORE` from helper (all stages). Set `DATABASE_URL` when `RGS_DATABASE_URL` non-empty (same as today for the URL; still always set `CRM_STORE`).
- User API must not get `LEDGER_STORE`.

- [ ] **Step 1: Change infra tests**

Keep `does not own a platform Dynamo table on staging` and `prod`. Add:

```ts
it("does not own a platform Dynamo table on test", () => {
  const resources = synthesizedResources();
  assert.equal(dynamoTables(resources).length, 0);
  const env = lambdaEnvByName(resources);
  assert.equal(env["rgs-admin-api-test"]?.["TABLE_NAME"], undefined);
  assert.equal(env["rgs-user-api-test"]?.["TABLE_NAME"], undefined);
  assert.equal(env["rgs-appointment-reminders-test"]?.["TABLE_NAME"], undefined);
});
```

Change “defaults CRM_STORE and LEDGER_STORE to postgres on staging when RGS_* unset” — keep staging assertions; they stay valid.

**Delete** the test that sets `RGS_*=dynamo` and expects Dynamo on staging Lambdas.

**Replace** “prod unset → dynamo” with:

```ts
it("defaults CRM_STORE and LEDGER_STORE to postgres on prod when RGS_* unset", () => {
  // same save/restore env as the staging unset test
  const env = lambdaEnvByName(synthesizedResourcesForStage("prod"));
  assert.equal(env["rgs-admin-api-prod"]?.["CRM_STORE"], "postgres");
  assert.equal(env["rgs-admin-api-prod"]?.["LEDGER_STORE"], "postgres");
  assert.equal(env["rgs-user-api-prod"]?.["CRM_STORE"], "postgres");
  assert.equal(env["rgs-user-api-prod"]?.["LEDGER_STORE"], undefined);
  assert.equal(env["rgs-appointment-reminders-prod"]?.["CRM_STORE"], "postgres");
});
```

If a test asserted reminders omit `CRM_STORE` on non-staging unset, delete that assertion.

- [ ] **Step 2: Run infra tests; expect FAIL** (`test` stage still has a table).

```bash
cd infra && node --import tsx --test test/admin-rbac.test.ts
```

Need `PATH` so CDK can find `esbuild` (same as D.1/D.2). `pnpm --filter @rgs/infra test` is only `cdk synth`, not these unit tests.

- [ ] **Step 3: Implement stack changes**

- [ ] **Step 4: Re-run infra tests; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add infra/lib/rgs-platform-stack.ts infra/test/admin-rbac.test.ts
git commit -m "$(cat <<'EOF'
fix(infra): drop PlatformTable and default every stage to postgres

Test synth no longer creates Dynamo. Unset RGS store flags cannot
point Lambdas at a table that no longer exists.
EOF
)"
```

---

### Task 3: Async PGlite helper (`buildSqlTestContext`)

**Files:**
- Modify: `services/api/test/helpers.ts`
- Create: `services/api/test/helpersSql.test.ts`

**Interfaces:**

```ts
export interface SqlTestContext extends AppContext {
  sql: SqlClient;
  documents: InMemoryDocumentStore;
  email: InMemoryEmailSender;
  advanceClock(milliseconds: number): void;
}

export async function buildSqlTestContext(
  options: BuildTestContextOptions = {},
): Promise<SqlTestContext>
```

Implementation:

1. `const database = new PGlite()` then `const sql = pgliteAsSqlClient(database)`.
2. `await applyMigrations(sql)`.
3. Clock / documents / email same as `buildTestContext`.
4. `crmStore: "postgres"`, `ledgerStore: "postgres"`, `sql`.
5. Until Task 7, still attach `table: new InMemoryTableClient()` so `AppContext.table` typechecks. Converted tests must not seed or assert via `table`.
6. If `options.seedStatusEmailTemplates !== false`, `await seedStatusEmailTemplatesIfAbsent(context, "rgs", "seed@rgs.local")` using the context **after** sql/crmStore are set (Postgres path). Remove the sync `table.put` seed from this helper only; leave it on `buildTestContext`.

Leave existing `buildTestContext` **unchanged**.

- [ ] **Step 1: Failing test** in `helpersSql.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { createPartner } from "../src/domain/crm/partners";
import { buildSqlTestContext } from "./helpers";

describe("buildSqlTestContext", () => {
  it("migrates PGlite and writes a partner through CRM_STORE=postgres", async () => {
    const context = await buildSqlTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels" },
      "desk@rgs.local",
    );
    expect(partner.partnerId).toMatch(/^ptr_/);
    const listed = await context.sql.query<{ n: string }>(
      `select count(*)::text as n from crm_partners`,
    );
    expect(listed.rows[0]?.n).toBe("1");
    await context.sql.end();
  });
});
```

- [ ] **Step 2: Run; expect FAIL** (`buildSqlTestContext` missing)

Run: `pnpm --filter @rgs/api exec vitest run test/helpersSql.test.ts`

- [ ] **Step 3: Implement helper**

- [ ] **Step 4: Re-run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add services/api/test/helpers.ts services/api/test/helpersSql.test.ts
git commit -m "$(cat <<'EOF'
test(api): add PGlite buildSqlTestContext for postgres SoR tests

Converted suites can share one migrated database instead of each
file wiring PGlite by hand.
EOF
)"
```

---

### Task 4: Convert CRM Vitest clusters to `buildSqlTestContext`

**Files (convert each `buildTestContext()` → `await buildSqlTestContext()`, `beforeEach` async, `afterEach` `await context.sql.end()`):**

- `services/api/test/crm/cases.test.ts`
- `services/api/test/crm/caseStore.test.ts`
- `services/api/test/crm/ledger.test.ts`
- `services/api/test/crm/partners.test.ts`
- `services/api/test/crm/travellers.test.ts`
- `services/api/test/crm/caseTravellers.test.ts`
- `services/api/test/crm/caseRefIndex.test.ts`
- `services/api/test/crm/crmEvents.test.ts`
- `services/api/test/crm/applicantEdits.test.ts`
- `services/api/test/crm/updateCaseDetails.test.ts`
- `services/api/test/crm/lineItems.test.ts`
- `services/api/test/crm/caseInvoice.test.ts`
- `services/api/test/crm/caseExport.test.ts`
- `services/api/test/crm/crmApi.test.ts`
- `services/api/test/crm/statusNotify.test.ts`
- `services/api/test/crm/caseDocumentChecklist.test.ts`
- `services/api/test/crm/destinationRequiredDocuments.test.ts`
- `services/api/test/crm/destinationCountries.test.ts`
- `services/api/test/crm/countryDocumentsCatalog.test.ts`
- `services/api/test/crm/refClaims.test.ts`

**Merge / delete Postgres twins** (keep unique SQL assertions by moving them into the converted file, then delete the twin):

- `casesPostgres.test.ts`, `casesListPostgres.test.ts`, `caseStorePostgres.test.ts`, `ledgerPostgres.test.ts`, `caseRefIndexPostgres.test.ts`, `crmEventsPostgres.test.ts`, `crmSorPostgres.test.ts`

**Conversion recipe (every file):**

1. Replace `const context = buildTestContext()` with `const context = await buildSqlTestContext()`.
2. Delete `context.table.put({ PK, SK, ... })` seeds. Seed with domain functions already used in `*Postgres.test.ts` (`createPartner`, `upsertTraveller`, `createCase`, …).
3. Delete tests whose only job is Dynamo GSI / consistent-read / InMemory key order / projection lists (`LEDGER_PROJECTED_ATTRIBUTES` DocumentClient guard in `ledger.test.ts`).
4. Delete `trackTableAccess` / “must not touch Dynamo PK” tests in Postgres twins once domain still has Dynamo elses — **keep** them until Task 7 if they still compile; after Task 7 they cannot compile (`table` gone) so they must be gone by Task 8.
5. Call `await context.sql.end()` in `afterEach` (or at end of each test if no shared context).

- [ ] **Step 1: Convert the list; run**

`pnpm --filter @rgs/api exec vitest run test/crm/cases.test.ts test/crm/partners.test.ts test/crm/ledger.test.ts` then widen to the whole `test/crm/` folder.

Expected: PASS for converted files. Unconverted files still use `buildTestContext`.

- [ ] **Step 2: Commit**

```bash
git add services/api/test/crm
git commit -m "$(cat <<'EOF'
test(crm): run case/ledger suites on PGlite

Product assertions now hit the same SQL adapters as production.
EOF
)"
```

---

### Task 5: Convert remaining CRM + templates + reminders + review/memory

**Files:**

- `services/api/test/crm/reviewQueue.test.ts`
- `services/api/test/crm/reviewGroups.test.ts`
- `services/api/test/crm/statusEmailTemplates.test.ts`
- `services/api/test/crm/appointmentReminders.test.ts`
- `services/api/test/crm/memory` — `services/api/test/agent/memory.test.ts` wait until Task 6 if it is agent-only
- Postgres twins: `reviewQueuePostgres.test.ts`, `reviewGroupsPostgres.test.ts`, `statusEmailTemplatesPostgres.test.ts`, `appointmentRemindersPostgres.test.ts`, `memoryPostgres.test.ts`, `prefsPostgres.test.ts`, `proposalsPostgres.test.ts`

Same recipe as Task 4. `statusEmailTemplates.test.ts` must not use `table.put` for templates; helper already seeds via Postgres.

- [ ] **Step 1: Convert + delete twins; run `vitest run test/crm/reviewQueue.test.ts test/crm/statusEmailTemplates.test.ts test/crm/appointmentReminders.test.ts`**

- [ ] **Step 2: Commit**

```bash
git add services/api/test/crm services/api/test/agent/memory.test.ts
git commit -m "$(cat <<'EOF'
test(crm): move review, templates, and reminders tests to PGlite
EOF
)"
```

If `memory.test.ts` is not converted here, do not stage it.

---

### Task 6: Convert agent, portal, HTTP, admin, config tests

**Files using `buildTestContext` (from repo grep):**

- `services/api/test/agent/approval.test.ts`, `writeTools.test.ts`, `readTools.test.ts`, `intake.test.ts`, `prefs.test.ts`, `loop.test.ts`, `aggregate.test.ts`, `toolCallPairing.test.ts`, `memory.test.ts` (if leftover)
- `services/api/test/applications.test.ts`, `users.test.ts`, `documents.test.ts`, `admin.test.ts`, `notices.test.ts`, `config.test.ts`, `router.test.ts`
- `services/api/test/http/agentApi.test.ts`, `staffApi.test.ts`, `routeAccessMatrix.test.ts`
- Postgres twins: `applicationsPostgres.test.ts`, `applicationDocumentsPostgres.test.ts`, `userProfilesPostgres.test.ts`, `activityPostgres.test.ts`, `leadsPostgres.test.ts`, `noticesPostgres.test.ts`, `configCountryProductsPostgres.test.ts`

`createSubmittableUaeDraft` in helpers.ts: change to take `SqlTestContext` / `AppContext` with sql. Keep working for both helpers until Task 8 by typing `AppContext`.

Eval: `services/api/eval/runIntakeEval.ts` — change `buildEvalContext` to async PGlite + `applyMigrations` + `crmStore: "postgres"` (same as helper). If eval is too heavy for this task, do it in Task 11; then Task 8 cannot delete `InMemoryTableClient` until eval is done. **Do eval in this task** so Task 8 is unblocked.

- [ ] **Step 1: Convert listed tests + eval; run**

`pnpm --filter @rgs/api exec vitest run test/applications.test.ts test/agent/approval.test.ts test/http/agentApi.test.ts test/notices.test.ts`

Then `pnpm --filter @rgs/api test`

- [ ] **Step 2: Commit**

```bash
git add services/api/test services/api/eval/runIntakeEval.ts
git commit -m "$(cat <<'EOF'
test(api): run agent, portal, and HTTP suites on PGlite

Eval intake seeding uses the postgres domain path.
EOF
)"
```

---

### Task 7: Domain SQL-only — drop Dynamo `else` and `crmPostgresOf`

**Files:** every `services/api/src/domain/**/*.ts` and `services/api/src/agent/approval.ts`, `prefs.ts`, `intake.ts` that call `crmPostgresOf` or `context.table`. Also `services/api/src/lib/context.ts` `logActivity`.

**Recipe for each function:**

```ts
// before
const sql = crmPostgresOf(context);
if (sql) return fooPostgres(sql, ...);
await context.table.get(...);

// after
return fooPostgres(requireSql(context), ...);
```

Add in `postgresClient.ts`:

```ts
export function requireSql(context: AppContext): SqlClient {
  if (context.sql === undefined) {
    throw new Error("AppContext.sql is required");
  }
  return context.sql;
}
```

Delete `crmPostgresOf`. Keep `postgresClientFor` as an alias of `requireSql` or delete and use `requireSql` only.

Strip Dynamo-only comments that document DocumentClient quirks when the code they describe is gone.

Do **not** delete `db.ts` yet if `AppContext.table` still exists — keep the field so leftover tests compile. After this task, production and SQL tests never call `table`. Grep `context.table` in `src/` must be empty.

- [ ] **Step 1: `rg 'crmPostgresOf|context\\.table' services/api/src` — fix until no domain hits**

- [ ] **Step 2: `pnpm --filter @rgs/api exec tsc --noEmit` and `pnpm --filter @rgs/api test`**

Expected: PASS. Dynamo helper tests still compile via `buildTestContext` but domain ignores `table` when `crmStore` unset — **wait**: after deleting `else`, domain **always** uses sql. Remaining `buildTestContext()` tests **will fail or throw** `AppContext.sql is required`.

Therefore Task 7 is only allowed when Task 4–6 converted **all** `buildTestContext` call sites in `services/api/test`. Grep before implementing:

```
rg 'buildTestContext\(' services/api/test services/api/eval services/migration
```

If any remain, convert them in this task first (same recipe). `services/migration` tests that still use InMemory stay until Tasks 9–10.

- [ ] **Step 3: Commit**

```bash
git add services/api/src
git commit -m "$(cat <<'EOF'
refactor(api): drop Dynamo domain branches

CRM and portal writes go only through Postgres adapters.
EOF
)"
```

---

### Task 8: Remove `table` from `AppContext`; delete Dynamo client

**Files:**
- Modify: `services/api/src/lib/context.ts` — required `sql: SqlClient`; remove `table`, `crmStore`, `ledgerStore`
- Delete: `services/api/src/lib/db.ts`, `tableRetry.ts`, `unavailableTableClient.ts`
- Delete: `services/api/test/db.test.ts`, `tableRetry.test.ts`
- Modify: `handler.ts` — drop table stub; context has no table/store fields
- Modify: `helpers.ts` — delete `buildTestContext` + `InMemoryTableClient`; rename `buildSqlTestContext` → `buildTestContext`; `TestContext` = former `SqlTestContext`; `sql` required
- Replace all `buildSqlTestContext` call sites with `buildTestContext`
- Delete `helpersSql.test.ts` import rename
- `services/api/package.json` — remove `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` if nothing imports them
- `apps/admin` comments that mention InMemoryTableClient — edit comments only, no behavior

- [ ] **Step 1: `rg 'InMemoryTableClient|DynamoTableClient|from \"./db\"|from \"../lib/db\"|tableRetry' services apps`** and fix until empty in product+tests (migration package next tasks may still import — **if they still import, Task 8 cannot delete `db.ts`**).

Order: if migration still imports `db.ts`, either (a) do Task 9–10 **before** deleting `db.ts`, or (b) keep `db.ts` until Task 10.

**Locked order change:** complete Task 9 and Task 10 **before** deleting `db.ts` if grep still shows migration imports. Prefer doing 9 then 10 then the deletes in this task. If you already converted migration tests in 9–10, delete `db.ts` here.

- [ ] **Step 2: typecheck + `pnpm --filter @rgs/api test`**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(api): remove TableClient and Dynamo SDK from the API package

AppContext is SQL-only; tests share the renamed PGlite helper.
EOF
)"
```

Do not `git add` secrets. If this commit is too large, split: (8a) context type + helper rename, (8b) delete db.ts after migration greps clean.

---

### Task 9: Delete Dynamo backfill CLIs and tests

**Delete sources + tests:**

Dynamo → Postgres (tables gone; do not re-run):

- `backfillLeadsNoticesToPostgres.ts` + `Cli.ts` + test
- `backfillPortalSoRToPostgres.ts` + `Cli.ts` + test
- `backfillCountryCatalogToPostgres.ts` + `Cli.ts` + test
- `backfillCrmRemainingToPostgres.ts` + `Cli.ts` + test
- `backfillCrmCaseSorToPostgres.ts` + `Cli.ts` + test
- `backfillCrmLedgerToPostgres.ts` + `Cli.ts` + test

Dynamo-era in-table:

- `backfillApplicantSummary.ts`, `backfillCli.ts`, `runBackfillCli.ts` + tests `backfillApplicantSummary.test.ts`, `runBackfillCli.test.ts`
- `backfillLedgerSearchText.ts`, `backfillSearchTextCli.ts`, `runBackfillSearchTextCli.ts` + `backfillLedgerSearchText.test.ts`
- `backfillRefClaims.ts`, `backfillRefClaimsCli.ts`, `runBackfillRefClaimsCli.ts` + `backfillRefClaims.test.ts`
- `backfillCaseStatusRename.ts`, `backfillCaseStatusRenameCli.ts`, `runBackfillCaseStatusRenameCli.ts` + `backfillCaseStatusRename.test.ts`

Keep: `seedStatusEmailTemplates*`, `migrateCountryDocumentsToProducts*`, Excel `import*` / workbook helpers, `mapRow` / `groupCases` / etc.

Update `services/migration/package.json` scripts: remove deleted `backfill:*` entries.

- [ ] **Step 1: Delete files; `pnpm --filter @rgs/migration test` and typecheck**

- [ ] **Step 2: Commit**

```bash
git add services/migration
git commit -m "$(cat <<'EOF'
chore(migration): remove Dynamo backfill CLIs

Source tables are gone; keeping the jobs invites a destructive re-run.
EOF
)"
```

---

### Task 10: Excel import + seed CLIs without `TableClient`

**Files:**
- Modify: `services/migration/src/importCli.ts` — remove `tableRecordingWrites` / `TableClient`. Dry-run and abort messaging stay. Count writes via `ImportSummary` (already returned) instead of wrapping `put`.
- Modify: `services/migration/test/importCli.test.ts` — delete tests that wrap `TableClient` for throttle/read-only/fail-after-N. Keep argv/usage/dry-run/summary tests using `buildSqlTestContext` (or API `buildTestContext` after rename) as `buildContext`.
- Modify: `services/migration/test/importRun.test.ts` — replace `InMemoryTableClient` with PGlite context; delete GSI-lag / counting-table spies. Seed and assert through domain + SQL. **Keep** skip-already-imported, sentinel partner, residue, unreadable-row behavior tests.
- Modify: `services/migration/test/fullWorkbook.test.ts` if it uses a table.
- Modify: `services/migration/test/seedStatusEmailTemplates.test.ts` — PGlite + `seedStatusEmailTemplates`.
- `services/migration/src/cli.ts` — still `buildProductionContext`; now needs `DATABASE_URL` not `TABLE_NAME`.
- README: `services/migration/README.md` — `DATABASE_URL`, no `TABLE_NAME`.

- [ ] **Step 1: Convert `importRun.test.ts` enough that one test creates a case:**

```ts
const context = await buildTestContext(); // PGlite helper from @rgs/api/test/helpers
// runImport with one mapped row (copy an existing fixture from the file)
const got = await readCase(context, TENANT_ID, createdId);
expect(got).toBeDefined();
await context.sql.end();
```

If helpers are not exported from the api package, duplicate the PGlite+migrate wiring in the migration test file (same as current `pgliteAsSqlClient` imports from `@rgs/api/test/pgliteSqlClient`).

- [ ] **Step 2: `pnpm --filter @rgs/migration test`**

- [ ] **Step 3: Commit**

```bash
git add services/migration
git commit -m "$(cat <<'EOF'
feat(migration): write Excel import into Postgres

Workbook mapping is unchanged; persistence uses the API domain SQL path.
EOF
)"
```

---

### Task 11: Docs, grep gate, leftover comments

**Files:**
- `README.md` — architecture diagram and “single DynamoDB table” → Postgres (Supabase). Lambda env: `DATABASE_URL`, `CRM_STORE`, `LEDGER_STORE` (admin), no `TABLE_NAME`.
- Spec D.3 status already approved; add **Plan:** this file path at the top of the spec if missing.
- Admin comment in `apps/admin/src/crm/api/mutations.ts` about InMemory consistency — rewrite to “server is Postgres; no client cache of mutations”.

- [ ] **Step 1: Grep gate (must be empty outside docs/superpowers and this plan/spec):**

```
rg -n 'InMemoryTableClient|DynamoTableClient|unavailableTableClient|@aws-sdk/client-dynamodb|@aws-sdk/lib-dynamodb|aws_dynamodb|TABLE_NAME' \
  --glob '!docs/superpowers/**' --glob '!**/node_modules/**'
```

Allowed leftovers: none in `services/`, `infra/`, `apps/`. If `TABLE_NAME` appears in README you forgot to edit, fix it.

Also:

```
rg -n 'crmPostgresOf|CRM_STORE=dynamo|ownPlatformTable' --glob '!docs/superpowers/**'
```

- [ ] **Step 2: `pnpm --filter @rgs/api test` && `pnpm --filter @rgs/migration test` && infra tests && `pnpm --filter @rgs/api typecheck`**

- [ ] **Step 3: Commit**

```bash
git add README.md services/migration/README.md apps/admin/src/crm/api/mutations.ts docs/superpowers/specs/2026-10-03-supabase-postgres-phase-d3-dynamo-code-cleanup-design.md
git commit -m "$(cat <<'EOF'
docs: describe Postgres as the platform store

README no longer tells operators to set TABLE_NAME.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Unset store = postgres; dynamo throws | 1 |
| No CDK table any stage; no TABLE_NAME | 2 |
| AppContext.sql required; table/store fields gone | 7–8 |
| PGlite helper; merge duplicate tests | 3–6 |
| Delete Dynamo tests (db/tableRetry) | 8 |
| Delete Dynamo→PG and in-table backfills | 9 |
| Excel import via domain SQL | 10 |
| Seed templates SQL | 3 + 10 |
| Eval PGlite | 6 |
| Docs | 11 |
| Keep CRM_STORE/LEDGER_STORE env as postgres | 1–2 |
| User API no LEDGER_STORE | 2 |
| Fix-forward only | no rollback runbook task |

If Task 8 still sees migration imports of `db.ts`, finish Task 9–10 first (stated in Task 8).
