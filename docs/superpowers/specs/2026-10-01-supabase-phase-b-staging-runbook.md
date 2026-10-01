# Supabase Phase B.1 — staging cutover runbook

**Date:** 2026-10-01  
**Scope:** CRM case **reads and writes** on Postgres (`CRM_STORE=postgres`). Ledger reads stay on Postgres (`LEDGER_STORE=postgres`, Phase A).  
**Design:** `2026-10-01-supabase-postgres-migration-design.md` · **Plan:** `2026-10-01-supabase-postgres-phase-b.md`

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** (match staging API Lambdas) |

> **Freshness contract (read first).** Phase B.1 has **no dual-write** to Dynamo for case SoR. After cutover, case create/update/status and ledger projection columns on `crm_cases` update in the **same Postgres transaction** — the Ledger Live queue reflects new work **without** re-running a backfill.  
> **`backfill:crm-case-sor-postgres` is a pre-cutover copy only.** Run it **before** flipping `RGS_CRM_STORE=postgres`. **Never re-run it after cutover** — it reads staging Dynamo and **overwrites** Postgres partner/traveller/case/applicant/event rows with stale Dynamo copies, destroying desk edits made on PG.  
> **Do not re-run Phase A `backfill:crm-ledger-postgres` after `CRM_STORE=postgres` either** — that job also copies from Dynamo and would clobber full partner rows and case ledger columns with stale Dynamo projections.

> **Security note (unchanged from Phase A).** `RGS_DATABASE_URL` (password included) is a plaintext admin Lambda env var; the pg client does not pin the Supabase CA. Staging-only until secrets and TLS are hardened for prod.

> **Known B.1 gaps (agent / ops tooling).** With `CRM_STORE=postgres`, these paths still hit **Dynamo** only: `listCasesByStatus`, `listCasesByPartner`, `countCasesByField`, and **`caseRefIndex`** (ref reservation). Admin **Ledger Live** is OK when `LEDGER_STORE=postgres` (SQL ledger). Agent list/count tools and anything driven off GSI1/GSI2 or the ref index may be **stale or empty** relative to Postgres until Phase B.2+ migrates those reads.

> **Appointment reminders follow `CRM_STORE`.** The nightly EventBridge job (`rgs-appointment-reminders-<stage>`, 03:00 UTC) reads live cases with an appointment 1–2 days out, emails the partner, and stamps `appointmentReminderSentFor`. CDK now sets **`DATABASE_URL`** and **`CRM_STORE`** on that Lambda from the same `RGS_DATABASE_URL` / `RGS_CRM_STORE` as the admin API (it does not need `LEDGER_STORE`: under Postgres it queries `crm_cases` directly by `appointment_date`). **Both Lambdas must be redeployed together** — a reminders Lambda left on `dynamo` after the flip would email partners from a frozen copy and stamp rows nobody reads. This puts the DB credential on a second Lambda (same staging-only caveat as the security note above); the portal-facing user API still carries none.

---

## Checklist

### 0. Preconditions (Phase A)

- [ ] Phase A already done on this project: `001` applied, `RGS_LEDGER_STORE=postgres`, `RGS_DATABASE_URL` → admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`**, `?pgbouncer=true` if required).
- [ ] Staging admin build: **`VITE_LEDGER_COMBINED_FILTERS=true`** iff API runs **`LEDGER_STORE=postgres`** (rebuild on every ledger flip/rollback — see Phase A runbook).

### 1. Schema (migrations 001–003)

Apply through **`003_crm_partners_sor`** using the Supabase **session** connection (direct **`:5432`** or session pooler — **not** the transaction pooler used for Lambdas). DDL and migration bookkeeping need a session-capable URL.

`backfill:crm-case-sor-postgres` (step 2) also calls `applyMigrations`; use this step only if you want schema verified before the SoR backfill.

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

- [ ] Confirm `schema_migrations` includes **`002_crm_case_sor.sql`** and **`003_crm_partners_sor.sql`**.

### 2. SoR backfill (Dynamo → Postgres) — **before cutover only**

- [ ] Point at **staging Dynamo** via **`TABLE_NAME`** (same table the staging admin API uses).
- [ ] Set **`DATABASE_URL`** to **`rgs_staging`** (session URL for the CLI is fine; pooler often works for DML but session is safer for long runs).
- [ ] **Do not** set `CRM_STORE=postgres` in the shell for this job — the CLI reads Dynamo regardless; pinning avoids operator confusion.
- [ ] Run (idempotent **only before cutover**):

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
DATABASE_URL='postgresql://…/rgs_staging' \
  pnpm --filter @rgs/migration backfill:crm-case-sor-postgres
```

**Cutover gate — exit code and logs**

- [ ] **All `unreadable*` counts must be zero** (`unreadablePartners`, `unreadableCases`, `unreadableTravellers`, `unreadableEvents`). The CLI exits **1** if any unreadable list is non-empty; **do not flip** until each id is fixed in Dynamo and the backfill is re-run, or the case is knowingly excluded (it will be absent from Postgres SoR).
- [ ] Inspect **`casesMissingRefClaims`**. These are cases whose REF has **no claim item in Dynamo** (not a failing exit code). **Run Dynamo ref-claims backfill first**, then re-run SoR backfill:

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
  pnpm --filter @rgs/migration backfill:ref-claims
```

Re-run step 2 until `casesMissingRefClaims` is empty or every remaining id is accepted as a known data gap.

### 3. Count parity (cases, applicants, events)

Default tenant **`rgs`** unless you used another `tenantId` in the backfill.

**Postgres (`rgs_staging`):**

```sql
select count(*) as cases from crm_cases where tenant_id = 'rgs';
select count(*) as applicants from crm_applicants where tenant_id = 'rgs';
select count(*) as events from crm_events where tenant_id = 'rgs';
```

**Dynamo (approximate checks):**

- **Cases:** same status-partition walk as the backfill — e.g. **`countCasesByField`** with `groupByField: 'caseStatus'` (sum `total`) or compare to `backfill:crm-case-sor-postgres` `casesUpserted` in the last good run.
- **Applicants:** per-case applicant items in Dynamo vs `crm_applicants` row count (large gaps → re-run SoR backfill **before** flip, not after).
- **Events:** CRM event items vs `crm_events` count.

- [ ] Investigate material gaps before enabling Postgres writes.

### 4. Deploy API with Postgres CRM SoR

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`** unchanged (→ admin Lambda **`DATABASE_URL`**, pooler **`:6543`**).
- [ ] Keep **`RGS_LEDGER_STORE=postgres`** (→ **`LEDGER_STORE=postgres`**).
- [ ] Set **`RGS_CRM_STORE=postgres`** (→ admin Lambda **`CRM_STORE=postgres`**). Default when unset is **`dynamo`** (`infra/lib/rgs-platform-stack.ts`).
- [ ] Confirm cold start: **`CRM_STORE=postgres`** without **`DATABASE_URL`** fails at startup (by design, same as ledger).
- [ ] Confirm the **appointment reminders Lambda** (`rgs-appointment-reminders-<stage>`) shows **`CRM_STORE=postgres`** and **`DATABASE_URL`** in its environment (same deploy; see freshness note above). Invoke once manually and check the report: `{ scanned, reminded, skipped }` should count only cases that exist in Postgres.
- [ ] **Do not** run `backfill:crm-case-sor-postgres` or `backfill:crm-ledger-postgres` after this deploy except during a deliberate rollback/re-cutover procedure.

### 5. Smoke (desk)

These checks validate **live Postgres SoR**, not backfill freshness.

- [ ] **Create case** on the desk → case opens on PG path; row appears on **Ledger Live** **without** re-running any backfill.
- [ ] **Status walk** (or custody/outcome change) → ledger status chips / queue update without backfill.
- [ ] **Export** from ledger. Under `CRM_STORE=postgres` the export loads the whole selection in **4 queries total** (partner list, `crm_cases`, `crm_applicants`, `crm_travellers`, each `= any(...)`), however many cases are selected, so the 500-case cap (`MAX_EXPORT_CASE_IDS`, a compile-time constant) is safe against the 15 s Lambda timeout. Still **export the full Ledger Live set once** and note the duration; it should be well under 2 s. (Dynamo mode keeps the per-case reads, ~2–3 per case, 20 in parallel.)
- [ ] **Appointment reminder** (optional): set a staging case's appointment to tomorrow, invoke the reminders Lambda, confirm one partner email, an `APPOINTMENT_REMINDER_SENT` event, and `appointment_reminder_sent_for` set on the `crm_cases` row.
- [ ] Status notification emails — optional if SES/templates unchanged.

### 6. Rollback

- [ ] Set **`RGS_CRM_STORE=dynamo`** (or unset → default **`dynamo`**); redeploy **both the admin API and the appointment reminders Lambda** (one stack deploy does both). Reminders go back to the Dynamo copy, so anything scheduled only on Postgres gets no reminder until reconciled.
- [ ] **`LEDGER_STORE=postgres` may stay on** if you only revert case writes; ledger SQL reads still work but reflect **last PG writes** until you reconcile.
- [ ] **Warn operators:** any case/partner/traveller/event edits that happened only on Postgres **do not appear** in Dynamo-backed case screens (`getCase` / mutators on Dynamo). Desk view looks like those writes never happened unless manually repaired in Dynamo or you re-cutover to PG.
- [ ] If you rolled back after PG-only writes and need Dynamo ledger parity again, you must **repair Dynamo** or accept staleness — **do not** blindly re-run Phase A ledger backfill while `CRM_STORE=postgres`; with `CRM_STORE=dynamo`, Phase A backfill can refresh ledger projection from Dynamo but **will not** restore PG-only case body edits.

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Becomes admin Lambda **`DATABASE_URL`** (use **transaction pooler** `:6543` for runtime) |
| CDK / deploy | `RGS_LEDGER_STORE` | Becomes **`LEDGER_STORE`** (`dynamo` default) |
| CDK / deploy | `RGS_CRM_STORE` | Becomes **`CRM_STORE`** (`dynamo` default) |
| Admin API Lambda | `DATABASE_URL` | Required when **`LEDGER_STORE=postgres`** or **`CRM_STORE=postgres`** |
| Admin API Lambda | `LEDGER_STORE` | `dynamo` \| `postgres` |
| Admin API Lambda | `CRM_STORE` | `dynamo` \| `postgres` |
| Appointment reminders Lambda | `DATABASE_URL`, `CRM_STORE` | Set only when `RGS_DATABASE_URL` / `RGS_CRM_STORE` are set at deploy; no `LEDGER_STORE` |
| User (portal) API Lambda | — | Never receives CRM database config |
| Lambda runtime | `TABLE_NAME` | Staging Dynamo table (still required) |
| SoR backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required; reads Dynamo, writes **`rgs_staging`** |
| Ref-claims backfill CLI | `TABLE_NAME`, AWS creds | Dynamo-only repair before SoR backfill |
| Migrations (one-off) | `DATABASE_URL` | **Session** URL to **`rgs_staging`**, through migration **003** |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` iff API uses **`LEDGER_STORE=postgres`** |

---

## Related runbooks

- Phase A (ledger reads only): `2026-10-01-supabase-phase-a-staging-runbook.md`
