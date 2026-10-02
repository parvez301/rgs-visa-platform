# Supabase Phase C.1 — staging cutover runbook

**Date:** 2026-10-02  
**Scope:** Country visa catalog on Postgres under existing **`CRM_STORE=postgres`**: `listCountryConfig`, `listActiveCountryConfig`, `resolveCountryProduct`, `upsertCountryProduct`. Migration-time seed from `@rgs/shared` `COUNTRY_PRODUCTS`; desk edits copied from Dynamo `CONFIG#COUNTRY`; leftover country checklists folded into products during backfill.  
**Design:** `2026-10-02-supabase-postgres-phase-c1-catalog-design.md` · **Plan:** `2026-10-02-supabase-postgres-phase-c1-catalog.md`  
**Prerequisite runbook:** `2026-10-01-supabase-phase-b2-staging-runbook.md` (Phase B.2 remaining CRM SoR)

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** (match staging API Lambdas) |

> **Freshness contract (read first).** Phase C.1 has **no dual-write** to Dynamo for the catalog. After C.1 code is live, catalog list/resolve/upsert go to Postgres only (`crm_country_products`).  
> **`backfill:country-catalog-postgres` is a pre-deploy copy only.** Run it **before** deploying C.1 application code (while staging still serves catalog from Dynamo on the pre-C.1 build, or immediately before deploy in the migrate → backfill → deploy order). **Never re-run it after C.1 is live** — it reads staging Dynamo and **overwrites** Postgres rows with stale Dynamo copies, destroying desk catalog edits made on PG since deploy.  
> **Portal applications, profiles, document metadata, and activity** are not part of C.1 (activity stays Dynamo here); they close via the Phase C.2.1 runbook: `2026-10-02-supabase-phase-c2-1-staging-runbook.md`.  
> **Do not re-run Phase B.2 `backfill:crm-remaining-postgres`, Phase B.1 `backfill:crm-case-sor-postgres`, or Phase A `backfill:crm-ledger-postgres` either** — same clobber risk on CRM/ledger SoR (see B.2 runbook).  
> **No in-memory seed SoR after cutover.** With `CRM_STORE=postgres`, an empty `crm_country_products` is a failed migrate or misconfiguration — runtime must **not** fall back to `COUNTRY_PRODUCTS` in memory as the catalog source.

> **Checklist fold during backfill.** The country-catalog backfill merges leftover Dynamo country checklists into products using the same rules as the retired checklist migration. Unreadable checklist countries are named in logs; they block cutover until fixed in Dynamo and the backfill is re-run **before** deploy.

> **Security note (unchanged from Phase A/B).** `RGS_DATABASE_URL` (password included) is a plaintext admin Lambda env var; the pg client does not pin the Supabase CA. Staging-only until secrets and TLS are hardened for prod.

> **No env flag flip.** Staging should already have **`RGS_CRM_STORE=postgres`** and **`RGS_LEDGER_STORE=postgres`** from B.1/B.2. This cutover is **migrate → backfill → deploy C.1 code** with the same `RGS_*` deploy inputs.

---

## Checklist

### 0. Preconditions (Phase B.2 live)

- [ ] **`CRM_STORE=postgres`** and **`LEDGER_STORE=postgres`** on staging admin API (and appointment reminders **`CRM_STORE=postgres`** + **`DATABASE_URL`** per B.1).
- [ ] B.1 + B.2 migrations **`001`–`004`** applied; case/partner and remaining CRM SoR already on Postgres.
- [ ] **`RGS_DATABASE_URL`** → admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`**, `?pgbouncer=true` if required).
- [ ] Admin build: **`VITE_LEDGER_COMBINED_FILTERS=true`** iff **`LEDGER_STORE=postgres`** (unchanged from B.2).

### 1. Schema (migration 005)

Apply through **`005_crm_country_products`** using the Supabase **session** connection (direct **`:5432`** or session pooler — **not** the transaction pooler used for Lambdas).

`backfill:country-catalog-postgres` (step 2) also calls `applyMigrations`; use this step only if you want schema and seed verified before the backfill.

```bash
DATABASE_URL='postgresql://…@db.kblgpjwqqixkcnbdfzsn.supabase.co:5432/rgs_staging' \
  pnpm --filter @rgs/api exec tsx -e "
import { createPgSqlClient, databaseUrlFromEnvironment } from './src/lib/sql.ts';
import { applyMigrations } from './src/db/migrate.ts';
const url = databaseUrlFromEnvironment(process.env);
if (!url) throw new Error('DATABASE_URL required');
const sql = createPgSqlClient(url);
try { await applyMigrations(sql); } finally { await sql.end(); }
"
```

- [ ] Confirm `schema_migrations` includes **`005_crm_country_products.sql`**.
- [ ] Confirm seed row count: `select count(*) from crm_country_products` equals **`COUNTRY_PRODUCTS.length`** from `@rgs/shared` (one row per seed entry when the table was empty before 005).

### 2. Country catalog backfill (Dynamo → Postgres) — **before C.1 deploy only**

- [ ] Point at **staging Dynamo** via **`TABLE_NAME`** (same table the staging admin API uses).
- [ ] Set **`DATABASE_URL`** to **`rgs_staging`** (session URL for the CLI is fine).
- [ ] **Do not** deploy C.1 postgres catalog readers until this step succeeds — empty or seed-only PG without Dynamo overlay may miss desk edits and break resolve/upsert expectations.
- [ ] Run (idempotent **only before C.1 deploy**):

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
DATABASE_URL='postgresql://…/rgs_staging' \
  pnpm --filter @rgs/migration backfill:country-catalog-postgres
```

**Cutover gate — exit code and logs**

- [ ] **All `unreadable*` counts must be zero** (`unreadableProducts`, `unreadableChecklists` in the summary table; CLI exits **1** if any unreadable product id or checklist country code remains). **Do not deploy C.1** until each named id is fixed in Dynamo and the backfill is re-run.
- [ ] Compare **`productsUpserted`** and **`checklistCountriesMerged`** to expectations; Dynamo desk rows should win over seed on conflict.

### 3. Count parity (catalog)

**Postgres (`rgs_staging`):**

```sql
select count(*) as country_products from crm_country_products;
```

**Dynamo (approximate check):**

- **Country products:** query base table **`PK = CONFIG#COUNTRY`** (consistent read) and compare item count to `productsUpserted` and PG `count(*)`. PG count may exceed Dynamo when seed holds products Dynamo never stored; PG should not be **materially below** Dynamo after a clean backfill unless you intentionally accept gaps.

- [ ] Investigate material gaps before deploying C.1.

### 4. Deploy API with C.1 code (no flag change)

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`**, **`RGS_LEDGER_STORE=postgres`**, **`RGS_CRM_STORE=postgres`** unchanged from B.2.
- [ ] Confirm cold start: **`CRM_STORE=postgres`** still requires **`DATABASE_URL`** (unchanged).
- [ ] Appointment reminders Lambda: still **`CRM_STORE=postgres`** + **`DATABASE_URL`**; no C.1-specific env additions expected.
- [ ] **Do not** run `backfill:country-catalog-postgres`, `backfill:crm-remaining-postgres`, `backfill:crm-case-sor-postgres`, or `backfill:crm-ledger-postgres` after this deploy except during a deliberate rollback/re-cutover procedure.

### 5. Smoke (desk / catalog)

These checks validate **live Postgres** for the catalog, not backfill freshness alone.

- [ ] **List catalog** — admin or API: `listCountryConfig` / active list returns expected countries; fees and flags match a known product on PG (not stale Dynamo-only behaviour).
- [ ] **Upsert one product** — staging-safe edit (e.g. tweak processing days or a fee on a test product); read back via list/resolve; row persists on **`crm_country_products`**.
- [ ] **Resolve required docs** — `resolveCountryProduct` for a country/product pair returns `requiredDocuments` from PG (including any checklist fold from backfill); case/desk flows that depend on doc lists behave.
- [ ] **No memory-seed fallback** — with `CRM_STORE=postgres`, confirm behaviour does **not** silently match in-memory `COUNTRY_PRODUCTS` when PG holds desk edits (upsert change visible; empty-table misconfig would not resurrect seed at read time).

### 6. Rollback

- [ ] Set **`RGS_CRM_STORE=dynamo`** (or unset → default **`dynamo`**); redeploy **admin API and appointment reminders Lambda** (one stack deploy does both). Entire CRM SoR (B.1 + B.2 + C.1 catalog) returns to Dynamo reads/writes for CRM paths; catalog falls back to Dynamo **`CONFIG#COUNTRY`** in the **pre-C.1** build only — if you rolled forward on C.1 code, redeploy the **previous** artifact or keep `postgres` and repair data instead.
- [ ] **`LEDGER_STORE=postgres` may stay on** if you only revert **`CRM_STORE`**; ledger SQL reads still work but case-linked views may disagree until reconciled.
- [ ] **Warn operators:** any catalog (or other CRM) edits that happened only on Postgres **do not appear** in Dynamo-backed tooling until manually repaired or you re-cutover to PG.
- [ ] **Do not** re-run `backfill:country-catalog-postgres` while C.1 is live and Postgres holds newer catalog data — it overwrites PG from stale Dynamo. Re-cutover requires a documented procedure (flag + code version + optional fresh backfill only while old build is serving writes).

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`** at runtime) |
| CDK / deploy | `RGS_LEDGER_STORE` | **`LEDGER_STORE`** — stay **`postgres`** on staging |
| CDK / deploy | `RGS_CRM_STORE` | **`CRM_STORE`** — stay **`postgres`** on staging (no C.1 flip) |
| Country catalog backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required; reads Dynamo, writes **`rgs_staging`** |
| Migrations (one-off) | `DATABASE_URL` | **Session** URL through migration **005** |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` iff **`LEDGER_STORE=postgres`** |

---

## Related runbooks

- Phase C.2.1 (portal + activity): `2026-10-02-supabase-phase-c2-1-staging-runbook.md`
- Phase B.2 (remaining CRM): `2026-10-01-supabase-phase-b2-staging-runbook.md`
- Phase B.1 (case SoR): `2026-10-01-supabase-phase-b-staging-runbook.md`
- Phase A (ledger reads): `2026-10-01-supabase-phase-a-staging-runbook.md`
