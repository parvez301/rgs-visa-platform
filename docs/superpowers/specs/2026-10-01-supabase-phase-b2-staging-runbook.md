# Supabase Phase B.2 — staging cutover runbook

**Date:** 2026-10-01  
**Scope:** Remaining CRM surfaces on Postgres under existing **`CRM_STORE=postgres`**: agent list/count, case-ref reservations, review queue, agent proposals, CRM memory, user prefs, status-email templates.  
**Design:** `2026-10-01-supabase-postgres-phase-b2-design.md` · **Plan:** `2026-10-01-supabase-postgres-phase-b2.md`  
**Prerequisite runbook:** `2026-10-01-supabase-phase-b-staging-runbook.md` (Phase B.1 case SoR)

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** (match staging API Lambdas) |

> **Freshness contract (read first).** Phase B.2 has **no dual-write** to Dynamo for these domains. After B.2 code is live, reads and writes for review, proposals, memory, prefs, templates, reservations, and agent list/count go to Postgres only.  
> **`backfill:crm-remaining-postgres` is a pre-deploy copy only.** Run it **before** deploying B.2 application code (while staging still runs the B.1 build for these paths, or immediately before deploy in the migrate → backfill → deploy order). **Never re-run it after B.2 is live** — it reads staging Dynamo and **overwrites** Postgres rows with stale Dynamo copies, destroying desk edits made on PG since deploy.  
> **Do not re-run Phase B.1 `backfill:crm-case-sor-postgres` or Phase A `backfill:crm-ledger-postgres` either** — same clobber risk on case/partner/ledger SoR (see B.1 runbook).

> **Discovery limits (prefs, USER memories, reservations).** The remaining backfill discovers data the same way today’s Dynamo list/get paths do:
> - **User prefs** and **`USER#` memories** are copied only for **known emails**: `CRM_BACKFILL_EXTRA_EMAILS`, plus emails seen on cases/partners, proposals, review items, and memory authors from ORG/PARTNER scopes already copied.
> - **Case-ref reservations** are fetched only for **caseRefs** appearing on a case (any status) or a review item. A reservation whose ref never landed on a case or review row (e.g. import died before writing) has **no Dynamo access path** and **will not be copied**.
>
> **Operator action:** Before cutover, set **`CRM_BACKFILL_EXTRA_EMAILS`** to a comma-separated list of **real desk/agent user emails** who use prefs or personal memories but might not appear in the automatic set. Re-run the backfill after adding emails if needed.  
> **A clean gate (all `unreadable*` = 0) does not prove full prefs or USER-memory coverage** — it only means every record the job *could* reach was copied. Missing emails in the known set still mean missing prefs/memories in Postgres with no failed exit code.

> **Security note (unchanged from Phase A/B.1).** `RGS_DATABASE_URL` (password included) is a plaintext admin Lambda env var; the pg client does not pin the Supabase CA. Staging-only until secrets and TLS are hardened for prod.

> **No env flag flip.** Staging should already have **`RGS_CRM_STORE=postgres`** and **`RGS_LEDGER_STORE=postgres`** from B.1. This cutover is **migrate → backfill → deploy B.2 code** with the same `RGS_*` deploy inputs.

---

## Checklist

### 0. Preconditions (Phase B.1 live)

- [ ] **`CRM_STORE=postgres`** and **`LEDGER_STORE=postgres`** on staging admin API (and appointment reminders **`CRM_STORE=postgres`** + **`DATABASE_URL`** per B.1).
- [ ] B.1 migrations **`001`–`003`** applied; case/partner/traveller/event/ref-claim SoR already on Postgres.
- [ ] **`RGS_DATABASE_URL`** → admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`**, `?pgbouncer=true` if required).
- [ ] Admin build: **`VITE_LEDGER_COMBINED_FILTERS=true`** iff **`LEDGER_STORE=postgres`** (unchanged from B.1).

### 1. Schema (migration 004)

Apply through **`004_crm_remaining_sor`** using the Supabase **session** connection (direct **`:5432`** or session pooler — **not** the transaction pooler used for Lambdas).

`backfill:crm-remaining-postgres` (step 2) also calls `applyMigrations`; use this step only if you want schema verified before the backfill.

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

- [ ] Confirm `schema_migrations` includes **`004_crm_remaining_sor.sql`**.

### 2. Remaining CRM backfill (Dynamo → Postgres) — **before B.2 deploy only**

- [ ] Point at **staging Dynamo** via **`TABLE_NAME`** (same table the staging admin API uses).
- [ ] Set **`DATABASE_URL`** to **`rgs_staging`** (session URL for the CLI is fine).
- [ ] Set **`CRM_BACKFILL_EXTRA_EMAILS`** to desk/agent emails that need prefs or **`USER#`** memories (see discovery limits above). Omit only if you accept possible gaps.
- [ ] **Do not** deploy B.2 postgres readers for these tables until this step succeeds — empty new tables break agent/review/memory flows.
- [ ] Run (idempotent **only before B.2 deploy**):

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
CRM_BACKFILL_EXTRA_EMAILS='agent1@example.com,agent2@example.com' \
DATABASE_URL='postgresql://…/rgs_staging' \
  pnpm --filter @rgs/migration backfill:crm-remaining-postgres
```

**Cutover gate — exit code and logs**

- [ ] **All `unreadable*` counts must be zero** (`unreadableReservations`, `unreadableReviewItems`, `unreadableProposals`, `unreadableMemories`, `unreadablePrefs`, `unreadableTemplates`). The CLI exits **1** if any unreadable list is non-empty; **do not deploy B.2** until each named id is fixed in Dynamo and the backfill is re-run.
- [ ] Compare **`…Upserted`** totals to expectations; remember prefs/memories may be **incomplete** even when unreadable lists are empty (missing emails in the known set).

### 3. Count parity (new B.2 tables)

Default tenant **`rgs`** unless you used another `tenantId`.

**Postgres (`rgs_staging`):**

```sql
select count(*) as review_items from crm_review_items where tenant_id = 'rgs';
select count(*) as proposals from crm_proposals where tenant_id = 'rgs';
select count(*) as memories from crm_memories where tenant_id = 'rgs';
select count(*) as user_prefs from crm_user_prefs where tenant_id = 'rgs';
select count(*) as status_email_templates from crm_status_email_templates where tenant_id = 'rgs';
select count(*) as ref_reservations from crm_case_ref_reservations where tenant_id = 'rgs';
```

**Dynamo (approximate checks):**

- **Review items:** sum GSI1 queries per `reviewStatus` (OPEN / APPLIED / DISMISSED) vs `reviewItemsUpserted`.
- **Proposals:** sum GSI1 per proposal status vs `proposalsUpserted`.
- **Memories:** not a single table walk — compare `memoriesUpserted` to ORG + PARTNER# + USER# partitions the job scanned; gaps may mean missing **`CRM_BACKFILL_EXTRA_EMAILS`**, not a failed gate.
- **Prefs:** one item per known email vs `prefsUpserted` (under-count vs desk headcount → add emails and re-run **before** deploy).
- **Templates:** one base-table row per case status that exists vs `templatesUpserted`.
- **Reservations:** only refs on cases/review items vs `reservationsUpserted`; orphan Dynamo reservations are **unreachable** by design.

- [ ] Investigate material gaps before deploying B.2.

### 4. Deploy API with B.2 code (no flag change)

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`**, **`RGS_LEDGER_STORE=postgres`**, **`RGS_CRM_STORE=postgres`** unchanged from B.1.
- [ ] Confirm cold start: **`CRM_STORE=postgres`** still requires **`DATABASE_URL`** (unchanged).
- [ ] Appointment reminders Lambda: still **`CRM_STORE=postgres`** + **`DATABASE_URL`**; no B.2-specific env additions expected.
- [ ] **Do not** run `backfill:crm-remaining-postgres`, `backfill:crm-case-sor-postgres`, or `backfill:crm-ledger-postgres` after this deploy except during a deliberate rollback/re-cutover procedure.

### 5. Smoke (desk / agent)

These checks validate **live Postgres** for B.2 domains, not backfill freshness alone.

- [ ] **Agent list/count** — Ledger Live or agent tools: list by status/partner and count-by-field match Postgres cases (no empty/stale GSI behavior from B.1).
- [ ] **Review queue** — list OPEN items; resolve or dismiss one; row updates on PG path.
- [ ] **Agent proposal** — stage a proposal; list pending; approve or reject; state persists.
- [ ] **CRM memory** — recall ORG/PARTNER/USER memory used on desk; add or edit if staging allows.
- [ ] **User prefs** — read prefs for a desk user (including one from **`CRM_BACKFILL_EXTRA_EMAILS`**); trust ladder / prefs fields round-trip.
- [ ] **Status-email templates** — get/list template for a status; upsert a staging-safe body; read back from PG.
- [ ] **Import reservation** (optional if staging uses import): reserve ref → complete or conflict behaves like B.1 semantics on **`crm_case_ref_reservations`**.

### 6. Rollback

- [ ] Set **`RGS_CRM_STORE=dynamo`** (or unset → default **`dynamo`**); redeploy **admin API and appointment reminders Lambda** (one stack deploy does both). Entire CRM SoR (B.1 + B.2) returns to Dynamo reads/writes for case paths; B.2 domains fall back to Dynamo in the **pre-B.2** build only — if you rolled forward on B.2 code, redeploy the **previous** artifact or keep `postgres` and repair data instead.
- [ ] **`LEDGER_STORE=postgres` may stay on** if you only revert **`CRM_STORE`**; ledger SQL reads still work but case-linked views may disagree until reconciled.
- [ ] **Warn operators:** any review/proposal/memory/prefs/template/reservation edits that happened only on Postgres **do not appear** in Dynamo-backed tooling until manually repaired or you re-cutover to PG.
- [ ] **Do not** re-run `backfill:crm-remaining-postgres` while B.2 is live and Postgres holds newer data — it overwrites PG from stale Dynamo. Re-cutover requires a documented procedure (flag + code version + optional fresh backfill only while old build is serving writes).

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`** at runtime) |
| CDK / deploy | `RGS_LEDGER_STORE` | **`LEDGER_STORE`** — stay **`postgres`** on staging |
| CDK / deploy | `RGS_CRM_STORE` | **`CRM_STORE`** — stay **`postgres`** on staging (no B.2 flip) |
| Remaining backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required; reads Dynamo, writes **`rgs_staging`** |
| Remaining backfill CLI | `CRM_BACKFILL_EXTRA_EMAILS` | Optional comma-separated emails for prefs + **`USER#`** memories |
| Migrations (one-off) | `DATABASE_URL` | **Session** URL through migration **004** |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` iff **`LEDGER_STORE=postgres`** |

---

## Related runbooks

- Phase C.1 (country catalog SoR): `2026-10-02-supabase-phase-c1-staging-runbook.md` — closes catalog gaps left when B.2 shipped (Dynamo `CONFIG#COUNTRY` until C.1 cutover).
- Phase B.1 (case SoR): `2026-10-01-supabase-phase-b-staging-runbook.md`
- Phase A (ledger reads): `2026-10-01-supabase-phase-a-staging-runbook.md`
