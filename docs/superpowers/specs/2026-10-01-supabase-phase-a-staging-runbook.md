# Supabase Phase A — staging runbook

**Date:** 2026-10-01  
**Scope:** CRM ledger **reads** on Postgres (`LEDGER_STORE=postgres`). Writes still Dynamo.  
**Design:** `2026-10-01-supabase-postgres-migration-design.md`

> **Staleness contract (read first).** Phase A has **no dual-write**. After the flip, the
> Ledger shows Dynamo data **as of the last backfill run** — nothing else updates Postgres.
> A case created or changed on the desk will **not** appear in the Ledger until the backfill
> is re-run, and cases deleted in Dynamo stay visible (the backfill never deletes). The UI
> shows no as-of timestamp, so "missing" and "stale" look the same to a desk agent.
>
> **Cadence (decision, until Phase B):** re-run the backfill **manually before each desk
> session / demo**, and **immediately before any smoke that involves a write**. Idempotent,
> safe to repeat. No scheduler exists yet. If that is too heavy, flip back to `dynamo`.
>
> **Security note (known Phase A tradeoff).** `RGS_DATABASE_URL` (password included) becomes a
> plaintext Lambda env var on the admin API, and the pg client does not verify the server
> certificate. Acceptable for **staging only**; move the secret out of plain env and pin the
> Supabase CA before any prod use.

Use a **dedicated Supabase project for staging** (separate from prod). Prefer a region close to API Lambdas (`ap-south-1` today) when Supabase offers it.

---

## Checklist

### 1. Supabase project + deploy secret

- [ ] Create staging Supabase project; note region vs `ap-south-1`.
- [ ] Copy the **transaction pooler** connection URI (port `:6543`; add `?pgbouncer=true` if Supabase requires it for transaction mode).
- [ ] Store it for CDK deploy: set **`RGS_DATABASE_URL`** at synth/deploy time → the **admin API Lambda only** receives **`DATABASE_URL`** (`infra/lib/rgs-platform-stack.ts`). The user API and reminders Lambdas deliberately get neither `DATABASE_URL` nor `LEDGER_STORE`.
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

- [ ] If the CLI exits non-zero, read **`unreadableCaseIds` / `unreadablePartnerIds`** in the log — same discipline as other backfills. `unreadableCaseIds` covers corrupt META **and** cases with impossible dates or a `totalInr` above 2,147,483,647 (a warning names the field). **Do not flip while `unreadableCaseIds` is non-empty** unless each is fixed in Dynamo (then re-run) or knowingly accepted: those cases will be **absent** from the Postgres Ledger and nothing there names them.

### 4. Count parity

- [ ] Compare Dynamo ledger totals vs Postgres row count (default tenant `rgs` unless you backfilled another).

Dynamo (via existing domain helper / agent tooling): **`countCasesByField`** on case META / GSI paths — e.g. sum status buckets or compare field totals you trust for staging volume.

Postgres:

```sql
select count(*) from crm_cases where tenant_id = 'rgs';
```

- [ ] Investigate any large gap before enabling Postgres reads.

### 5. Deploy API with Postgres ledger

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`** set (→ admin Lambda **`DATABASE_URL`**).
- [ ] Set **`RGS_LEDGER_STORE=postgres`** (→ admin Lambda **`LEDGER_STORE=postgres`**).
- [ ] **Re-run the backfill (step 3) right before/after the flip** — the Ledger is only as fresh as that run.
- [ ] Confirm cold start succeeds. If `LEDGER_STORE=postgres` without `DATABASE_URL`, the admin handler **fails at startup** (by design).
- [ ] Staging admin build: **`VITE_LEDGER_COMBINED_FILTERS=true` must match the API store** — `true` iff the API runs `LEDGER_STORE=postgres`. It is a build-time flag; nothing reconciles it with the Lambda. A deploy that loses `RGS_DATABASE_URL` reverts the API to `dynamo`, and an admin build still on `true` will show status chips the server did not apply. Rebuild/redeploy admin on every flip **and** every rollback.

### 6. Smoke (desk)

Smoke checks **backfilled** data. A brand-new or just-edited case will **not** show up without a re-backfill (see staleness contract). To test a write, create/transition the case, **re-run the backfill**, then look for it.

- [ ] Open **Ledger Live** work queue; paging and totals look sane.
- [ ] Search (text / ref).
- [ ] **Partner + status** together (requires combined flag + Postgres ledger).
- [ ] Export.

### 7. Rollback

- [ ] Set **`RGS_LEDGER_STORE=dynamo`** (or unset → default `dynamo`); redeploy.
- [ ] Rebuild admin with **`VITE_LEDGER_COMBINED_FILTERS`** unset/`false`.
- [ ] Ledger reads return to Dynamo GSI path. **Postgres data is kept** for a later retry — no drop required for Phase A rollback. It will be stale on the next flip; re-run the backfill first.

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Becomes Lambda `DATABASE_URL` |
| CDK / deploy | `RGS_LEDGER_STORE` | Becomes Lambda `LEDGER_STORE` (`dynamo` default) |
| Admin API Lambda only | `DATABASE_URL` | Supabase pooler; required when `LEDGER_STORE=postgres` |
| Admin API Lambda only | `LEDGER_STORE` | `dynamo` \| `postgres` |
| Lambda runtime | `TABLE_NAME` | Staging Dynamo table (still required) |
| Backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` **iff** API uses Postgres ledger; rebuild on flip and rollback |
