# Supabase Postgres Phase C.1 — Country Catalog SoR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under existing `CRM_STORE=postgres`, move the live country-product catalog (`CONFIG#COUNTRY`) onto Postgres with migrate-time seed, Dynamo backfill over seed, checklist leftover fold, then delete checklist Dynamo production code.

**Architecture:** Migration `005_crm_country_products` creates `crm_country_products` and inserts `@rgs/shared` `COUNTRY_PRODUCTS` when the table is empty. `config.ts` dispatches via `crmPostgresOf` to `configCountryProductsPostgres.ts`. No new env flags. Staging ship order: migrate → backfill → deploy. No dual-write. Activity log (`CONFIG_CHANGED`) stays on Dynamo for this phase.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, PGlite, existing Lambda/CDK; Cognito/S3/SES unchanged.

**Spec:** `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c1-catalog-design.md`

## Global Constraints

- Spec decisions 1–8 closed (C.1 catalog-first; gate on `CRM_STORE`; Postgres-only end state for catalog; mirror B.2; migrate-time seed, no empty-read memory SoR under postgres; fold then delete checklist; staging first; activity stays Dynamo).
- Parent migration design decisions 1–8 still apply.
- Lambdas: transaction pooler `:6543`; DDL / backfill: session `:5432`.
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-catalog-c1` (or similar) off `main`.
- Do not deploy prod / delete whole Dynamo / re-run A/B/C catalog backfills after C.1 readers are live.
- When `CRM_STORE=postgres`, never fall back to Dynamo for catalog list/resolve/upsert — fail if `sql` missing.
- Rollback: `RGS_CRM_STORE=dynamo` + redeploy admin (+ reminders). PG-only catalog edits disappear from desk view.

## Review Focus

1. **`CRM_STORE` unset / `dynamo`** — catalog still uses Dynamo exactly as today; pinned Task 2.
2. **`CRM_STORE=postgres` without `sql`** — loud fail, never silent Dynamo; pinned Task 2.
3. **Empty PG after migrate** — seed rows present; list does not resurrect in-memory `COUNTRY_PRODUCTS` as SoR; pinned Task 1–2.
4. **Backfill over seed** — Dynamo desk row wins on `(country_code, product_code)`; pinned Task 3.
5. **Corrupt product naming** — unreadable ids as `countryCode#productCode`; pinned Task 2–3.
6. **Checklist gone** — no production `countryChecklist` module after Task 4; live docs still from product `requiredDocuments`; pinned Task 4.

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Reuse **`CRM_STORE`**; no `CATALOG_STORE`. |
| D2 | Migration filename **`005_crm_country_products.sql`**. |
| D3 | Table **`crm_country_products`**, PK `(country_code, product_code)` (global catalog — no `tenant_id`; matches today’s Dynamo `CONFIG#COUNTRY` partition which is not tenant-scoped). |
| D4 | `required_documents` column type **jsonb**, array of `{ label, portalDocType? }`. |
| D5 | Postgres helper file: **`services/api/src/domain/configCountryProductsPostgres.ts`**. |
| D6 | Backfill script: **`backfill:country-catalog-postgres`**. |
| D7 | Checklist fold runs **inside** the backfill (read leftover checklist partitions; merge labels into products that still need them); then delete `countryChecklist.ts`. |
| D8 | `seedCountryConfig` Dynamo helper remains for `CRM_STORE=dynamo` first-write path; under postgres, migration seed replaces empty-table first-write seeding (upsert still works without calling Dynamo seed). |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/db/migrations/005_crm_country_products.ts` | Table + seed SQL |
| `services/api/src/db/migrate.ts` | Register 005 |
| `services/api/src/domain/configCountryProductsPostgres.ts` | SQL list/get/upsert |
| `services/api/src/domain/config.ts` | Dispatch on `crmPostgresOf` |
| `services/migration/src/backfillCountryCatalogToPostgres.ts` | Dynamo → PG + checklist fold |
| `services/migration/src/backfillCountryCatalogToPostgresCli.ts` | CLI |
| `services/migration/package.json` | Script |
| `services/api/src/domain/crm/countryChecklist.ts` | **Delete** after fold (Task 4) |
| `services/migration/src/migrateCountryDocumentsToProducts.ts` | Stop importing deleted module; keep Dynamo-era CLI working via inline get or deprecate with clear error |
| `docs/superpowers/specs/2026-10-02-supabase-phase-c1-staging-runbook.md` | Cutover |
| Pointers in B.2 / parent docs | One-line “catalog → C.1 runbook” if useful |

---

### Task 1: Migration `005_crm_country_products`

**Files:**
- Create: `services/api/src/db/migrations/005_crm_country_products.ts`
- Modify: `services/api/src/db/migrate.ts` — register after 004
- Test: `services/api/test/migrateCrmCountryProducts.test.ts`

**Interfaces:**
- Produces (implement exactly in `MIGRATION_SQL`; **no semicolons inside comments** — `applyMigrations` splits on `;`):

```sql
create table if not exists crm_country_products (
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  product_code text not null,
  country_name text not null,
  visa_type text not null,
  region text not null,
  tier text not null,
  validity_days integer not null check (validity_days > 0),
  stay_days integer not null check (stay_days > 0),
  entry text not null check (entry in ('SINGLE', 'MULTIPLE')),
  government_fee_inr integer not null check (government_fee_inr >= 0),
  service_fee_inr integer not null check (service_fee_inr >= 0),
  processing_days integer not null check (processing_days > 0),
  required_documents jsonb not null default '[]'::jsonb,
  active boolean not null,
  official_url text,
  primary key (country_code, product_code)
);

create index if not exists crm_country_products_active
  on crm_country_products (active);
```

- Seed: after `create table`, insert each `COUNTRY_PRODUCTS` row with
  `on conflict (country_code, product_code) do nothing` (or wrap inserts in
  `insert … select … where not exists (select 1 from crm_country_products limit 1)`
  so a non-empty desk table is never re-seeded). Prefer **seed only when table
  empty** (spec decision 5):

```sql
insert into crm_country_products (...columns...)
select ... from (values (...), (...)) as seed(...)
where not exists (select 1 from crm_country_products limit 1);
```

Build the `values` list in the `.ts` file by mapping `COUNTRY_PRODUCTS` to
SQL literals (escape strings; `required_documents` via `jsonb` cast of
`JSON.stringify`). Do not hand-copy product fields into the plan forever —
generate from the imported constant at module load when composing
`MIGRATION_SQL`.

- [ ] **Step 1: Failing test** — apply migrations on PGlite; assert table exists;
  assert `count(*)` equals `COUNTRY_PRODUCTS.length`; re-apply migrations;
  assert count unchanged; insert a fake desk row then re-run seed logic path
  (second apply) still leaves desk row + count ≥ seed.

- [ ] **Step 2: Run test — expect FAIL** (005 missing).

```bash
pnpm --filter @rgs/api exec vitest run test/migrateCrmCountryProducts.test.ts
```

- [ ] **Step 3: Implement migration + register in `migrate.ts`.**

- [ ] **Step 4: Tests pass; `tsc --noEmit` clean for api.**

- [ ] **Step 5: Commit**

```bash
git add services/api/src/db/migrations/005_crm_country_products.ts \
  services/api/src/db/migrate.ts \
  services/api/test/migrateCrmCountryProducts.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add country products Postgres migration 005 with seed

EOF
)"
```

---

### Task 2: Catalog R/W on Postgres when `CRM_STORE=postgres`

**Files:**
- Create: `services/api/src/domain/configCountryProductsPostgres.ts`
- Modify: `services/api/src/domain/config.ts` — dispatch list / resolve / upsert
- Test: `services/api/test/configCountryProductsPostgres.test.ts`

**Interfaces:**

```ts
export async function listCountryProductsPostgres(
  sql: SqlClient,
): Promise<{ countryProducts: CountryProduct[]; unreadableCountryProductIds: string[] }>;

export async function upsertCountryProductPostgres(
  sql: SqlClient,
  product: CountryProduct,
): Promise<void>;
```

- Parse rows through `CountryProductSchema` (reuse `coerceLegacyCountryProduct`
  only if reading legacy jsonb shapes — new writes are clean schema).
- Unreadable id format: `` `${countryCode}#${productCode}` `` (or PK string if
  codes missing).
- `listCountryConfig` under postgres: call `listCountryProductsPostgres`;
  **do not** return `[...COUNTRY_PRODUCTS]` when SQL returns zero rows.
- `upsertCountryProduct` under postgres: upsert SQL; **do not** call Dynamo
  `seedCountryConfig`; still call `logActivity` as today.
- `resolveCountryProduct` / `listActiveCountryConfig`: keep composing on
  `listCountryConfig` (no separate SQL unless clearer).

```ts
// dispatch sketch inside listCountryConfig
const sql = crmPostgresOf(context);
if (sql !== undefined) {
  return listCountryProductsPostgres(sql);
}
// existing Dynamo path including empty → COUNTRY_PRODUCTS seed
```

- [ ] **Step 1: Failing tests** — PGlite + `crmStore: "postgres"`:
  - after migrations, `listCountryConfig` returns seed-sized catalog, Dynamo
    `CONFIG#COUNTRY` query empty / unused;
  - `upsertCountryProduct` then list shows desk edit;
  - `resolveCountryProduct` finds upserted row;
  - corrupt row named in `unreadableCountryProductIds`;
  - with `crmStore: "dynamo"`, empty table still returns in-memory seed (unchanged).

- [ ] **Step 2: Run — expect FAIL.**

```bash
pnpm --filter @rgs/api exec vitest run test/configCountryProductsPostgres.test.ts
```

- [ ] **Step 3: Implement postgres helper + dispatch.**

- [ ] **Step 4: Tests pass; existing config/catalog tests still green.**

```bash
pnpm --filter @rgs/api exec vitest run test/configCountryProductsPostgres.test.ts test/crm/countryDocumentsCatalog.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store country catalog in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 3: Backfill country catalog (+ checklist fold)

**Files:**
- Create: `services/migration/src/backfillCountryCatalogToPostgres.ts`
- Create: `services/migration/src/backfillCountryCatalogToPostgresCli.ts`
- Modify: `services/migration/package.json` — script `backfill:country-catalog-postgres`
- Test: `services/migration/test/backfillCountryCatalogToPostgres.test.ts`

**Interfaces:**

```ts
export interface BackfillCountryCatalogResult {
  productsUpserted: number;
  checklistCountriesMerged: number;
  unreadableProductIds: string[];
  unreadableChecklistCountryCodes: string[];
}

export async function backfillCountryCatalogToPostgres(args: {
  table: TableClient;
  sql: SqlClient;
  onProgress?: (label: string, n: number) => void;
}): Promise<BackfillCountryCatalogResult>;
```

- `applyMigrations(sql)` first.
- Read Dynamo `CONFIG#COUNTRY` partition (same as today’s list); coerce +
  upsert each product into `crm_country_products` (`on conflict do update`).
- For each distinct `countryCode` seen (and optionally scan known checklist
  keys if a helper exists): `findCountryChecklist` / raw get; if checklist has
  labels missing from that country’s products, merge into products using the
  same merge rules as `migrateCountryDocumentsToProducts` (prefer **calling
  shared pure merge helpers** extracted or duplicated carefully — do not invent
  a third semantics). If checklist corrupt → name country code, skip merge.
- CLI: `TABLE_NAME` + `DATABASE_URL`; exit 1 if any unreadable list non-empty.
- Do **not** set `CRM_STORE=postgres` for correctness of the read path (reads Dynamo).

- [ ] **Step 1: Failing tests** — seed Dynamo products + one checklist; run
  backfill; assert PG row matches Dynamo (desk beats seed); second run
  idempotent; corrupt product named; checklist labels appear on product after fold.

- [ ] **Step 2–4: Implement CLI + script; tests pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): backfill country catalog into Postgres

EOF
)"
```

---

### Task 4: Delete country checklist Dynamo production module

**Files:**
- Delete: `services/api/src/domain/crm/countryChecklist.ts` (and update imports)
- Modify: `services/api/test/crm/countryChecklist.test.ts` — delete or rewrite as
  “module gone” only if something still needs the behaviour (prefer **delete**)
- Modify: `services/migration/src/migrateCountryDocumentsToProducts.ts` — remove
  import of deleted module; either (a) inline Dynamo get for
  `countryChecklistPartitionKey` for historical CLI, or (b) make CLI print
  “use backfill:country-catalog-postgres” and exit 1
- Update any remaining production imports (grep `countryChecklist` /
  `putCountryChecklist` / `findCountryChecklist`)

**Ruling for implementer:** Prefer **(b)** if the old CLI is only for the
already-run Dynamo fold; prefer **(a)** if staging/prod might still need a
Dynamo-only repair. Default **(b)** with a one-line pointer to the new backfill
unless grep shows active runbooks still naming the old CLI.

- [ ] **Step 1: Grep** for callers; failing test or typecheck proves module
  removal breaks something → fix callers.

- [ ] **Step 2: Delete module + fix; full api + migration tests relevant suites green.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(api): remove dead country checklist Dynamo module

EOF
)"
```

---

### Task 5: Staging runbook

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-supabase-phase-c1-staging-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-c1-catalog-design.md` — status → approved when plan lands; Related link
- Modify: `docs/superpowers/specs/2026-10-01-supabase-phase-b2-staging-runbook.md` — one-line pointer that catalog gaps close via C.1 runbook

**Runbook must include:**
- Preconditions: B.2 live (`CRM_STORE=postgres`, `LEDGER_STORE=postgres`).
- Migrate 005 on session URL; confirm seed row count.
- `backfill:country-catalog-postgres` gate (all unreadable = 0).
- Count parity: PG `count(*)` vs Dynamo `CONFIG#COUNTRY` item count (approx).
- Deploy (same `RGS_*`; no flag flip).
- Smoke: list catalog; upsert one product; resolve required docs; confirm no
  memory-seed fallback dependence.
- Forbid re-running A/B/C catalog backfills after deploy.
- Rollback = `RGS_CRM_STORE=dynamo` + redeploy (whole CRM+catalog).

- [ ] **Step 1: Write runbook.**
- [ ] **Step 2: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase C.1 staging cutover runbook

EOF
)"
```

---

## Self-review (author)

| Spec requirement | Task |
|---|---|
| Gate on `CRM_STORE` | Global + Task 2 |
| Table + migrate-time seed | 1 |
| List/resolve/upsert on PG; no empty-read memory SoR | 2 |
| Backfill over seed; unreadable gate | 3 |
| Checklist fold + delete module | 3–4 |
| Staging runbook; no dual-write; rollback | 5 |
| Activity stays Dynamo | Task 2 (logActivity unchanged) |
| C.2/D out of scope | Global |

**Review Focus coverage:** each of the six lines is pinned to Tasks 1–4 as listed above.
