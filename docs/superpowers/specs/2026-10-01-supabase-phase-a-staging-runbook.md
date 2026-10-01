# Supabase Phase A — staging runbook

**Date:** 2026-10-01  
**Scope:** CRM ledger **reads** on Postgres (`LEDGER_STORE=postgres`). Writes still Dynamo.  
**Design:** `2026-10-01-supabase-postgres-migration-design.md`

Use a **dedicated Supabase project for staging** (separate from prod). Prefer a region close to API Lambdas (`ap-south-1` today) when Supabase offers it.

---

## Checklist

### 1. Supabase project + deploy secret

- [ ] Create staging Supabase project; note region vs `ap-south-1`.
- [ ] Copy the **transaction pooler** connection URI (port `:6543`; add `?pgbouncer=true` if Supabase requires it for transaction mode).
- [ ] Store it for CDK deploy: set **`RGS_DATABASE_URL`** at synth/deploy time → Lambda receives **`DATABASE_URL`** (`infra/lib/rgs-platform-stack.ts`).
- [ ] Do **not** flip ledger reads until URL is wired. Leave **`RGS_LEDGER_STORE`** unset or `dynamo` until steps 2–4 pass.

### 2. Schema (migrations)

- [ ] From a trusted machine with network access to staging Postgres, run `applyMigrations` once.

`backfill:crm-ledger-postgres` (step 3) also calls `applyMigrations`; use this step only if you want schema applied before backfill.

```bash
DATABASE_URL='postgresql://…:6543/postgres?pgbouncer=true' \
  pnpm --filter @rgs/api exec tsx -e "
import { createPgSqlClient, databaseUrlFromEnvironment } from './src/lib/sql.ts';
import { applyMigrations } from './src/db/migrate.ts';
const url = databaseUrlFromEnvironment(process.env);
if (!url) throw new Error('DATABASE_URL required');
const sql = createPgSqlClient(url);
try { await applyMigrations(sql); } finally { await sql.end(); }
"
```

### 3. Backfill (Dynamo → Postgres)

- [ ] Point at **staging Dynamo** via **`TABLE_NAME`** (same table the staging API uses).
- [ ] Set **`DATABASE_URL`** to the staging pooler URI.
- [ ] Run (idempotent — safe to re-run):

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
DATABASE_URL='postgresql://…:6543/postgres?pgbouncer=true' \
  pnpm --filter @rgs/migration backfill:crm-ledger-postgres
```

- [ ] If the CLI exits non-zero, read **`unreadableCaseIds` / `unreadablePartnerIds`** in the log — same discipline as other backfills; fix or accept before cutover.

### 4. Count parity

- [ ] Compare Dynamo ledger totals vs Postgres row count (default tenant `rgs` unless you backfilled another).

Dynamo (via existing domain helper / agent tooling): **`countCasesByField`** on case META / GSI paths — e.g. sum status buckets or compare field totals you trust for staging volume.

Postgres:

```sql
select count(*) from crm_cases where tenant_id = 'rgs';
```

- [ ] Investigate any large gap before enabling Postgres reads.

### 5. Deploy API with Postgres ledger

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`** set (→ Lambda **`DATABASE_URL`**).
- [ ] Set **`RGS_LEDGER_STORE=postgres`** (→ Lambda **`LEDGER_STORE=postgres`**).
- [ ] Confirm cold start succeeds. If `LEDGER_STORE=postgres` without `DATABASE_URL`, the admin handler **fails at startup** (by design).
- [ ] Staging admin build: set **`VITE_LEDGER_COMBINED_FILTERS=true`** when this API runs `LEDGER_STORE=postgres` so partner + status filters can be sent together.

### 6. Smoke (desk)

- [ ] Open **Ledger Live** work queue; paging and totals look sane.
- [ ] Search (text / ref).
- [ ] **Partner + status** together (requires combined flag + Postgres ledger).
- [ ] Export.

### 7. Rollback

- [ ] Set **`RGS_LEDGER_STORE=dynamo`** (or unset → default `dynamo`); redeploy.
- [ ] Ledger reads return to Dynamo GSI path. **Postgres data is kept** for a later retry — no drop required for Phase A rollback.

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Becomes Lambda `DATABASE_URL` |
| CDK / deploy | `RGS_LEDGER_STORE` | Becomes Lambda `LEDGER_STORE` (`dynamo` default) |
| Lambda runtime | `DATABASE_URL` | Supabase pooler; required when `LEDGER_STORE=postgres` |
| Lambda runtime | `LEDGER_STORE` | `dynamo` \| `postgres` |
| Lambda runtime | `TABLE_NAME` | Staging Dynamo table (still required) |
| Backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` when API uses Postgres ledger |
