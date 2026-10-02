# Supabase Phase C.2.2 — staging cutover runbook

**Date:** 2026-10-02  
**Scope:** Portal leads and public notices on Postgres under existing **`CRM_STORE=postgres`**: public `POST /api/v1/leads` (`createLead` + admin email + `LEAD_CREATED` activity), admin `GET /api/v1/admin/leads` (`listNewLeads`), public `GET /api/v1/notices` (`listPublicNotices`), admin notices list / upsert (`PUT /api/v1/admin/notices`) / delete (`DELETE /api/v1/admin/notices/{noticeId}`), `NOTICE_PUBLISHED` activity.  
**Design:** `2026-10-02-supabase-postgres-phase-c2-2-leads-notices-design.md` · **Plan:** `docs/superpowers/plans/2026-10-02-supabase-postgres-phase-c2-2-leads-notices.md`  
**Prerequisite runbooks:** `2026-10-02-supabase-phase-c2-1-staging-runbook.md` (C.2.1 portal + activity) → `2026-10-02-supabase-phase-c1-staging-runbook.md` (C.1 catalog) → `2026-10-01-supabase-phase-b2-staging-runbook.md` (B.2 remaining CRM SoR)

**Out of scope:** Phase D (deleting the Dynamo table / client / GSI helpers); lead lifecycle (status transitions, archive); dual-write; a new store flag; Cognito / S3 / SES changes; prod cutover (separate runbook after staging soak).

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** (match staging API Lambdas) |

> **Freshness contract (read first).** Phase C.2.2 has **no dual-write** to Dynamo for leads or notices. After C.2.2 code is live, these flows go to Postgres only (`portal_leads`, `portal_notices`). `createLead` under postgres inserts into `portal_leads` only — no Dynamo `LEAD#` item and no `STATUS#LEAD_NEW` GSI entry. Notice upsert/delete under postgres is SQL only — no `NOTICE` partition put or delete. `LEAD_CREATED` / `NOTICE_PUBLISHED` go to `activity_events` only (no Dynamo `EVENT#` day-bucket put).  
> **`backfill:leads-notices-postgres` is a pre-deploy copy only.** Run it **before** deploying C.2.2 application code (migrate → backfill → deploy). **Never re-run it after C.2.2 is live** — it reads staging Dynamo and **overwrites** Postgres lead and notice rows with stale Dynamo copies, destroying leads captured and notices edited on PG since deploy (and resurrecting notices deleted on PG).  
> **Do not re-run Phase C.2.1 `backfill:portal-sor-postgres`, Phase C.1 `backfill:country-catalog-postgres`, Phase B.2 `backfill:crm-remaining-postgres`, Phase B.1 `backfill:crm-case-sor-postgres`, or Phase A `backfill:crm-ledger-postgres` either** — same clobber risk on portal, catalog, CRM, and ledger SoR.  
> **No Dynamo fallback after cutover.** With `CRM_STORE=postgres`, leads and notices fail if `DATABASE_URL` is missing; they never silently read Dynamo. Empty `portal_leads` / `portal_notices` on a staging that had real Dynamo data is a failed backfill or misconfiguration — do not deploy against it (the public ticker would go blank and the admin lead queue would look empty).

> **Unreadable notices stay named.** A corrupt `portal_notices` row does not 500 the public ticker or the admin list: the response still returns readable notices plus `unreadableNoticeIds`. In the backfill, a lead or notice that will not parse (or that Postgres rejects) is named in `unreadableLeadIds` / `unreadableNoticeIds` and fails the run — never silently dropped.

> **Security note (unchanged from Phase A/B/C.1/C.2.1).** `RGS_DATABASE_URL` (password included) is a plaintext Lambda env var on the admin API, user API, and appointment reminders; the pg client does not pin the Supabase CA. Staging-only until secrets and TLS are hardened for prod.

> **No env flag flip.** Staging should already have **`RGS_CRM_STORE=postgres`** and **`RGS_LEDGER_STORE=postgres`** from B.1/B.2/C.1/C.2.1. This cutover is **migrate → backfill → deploy C.2.2 code** with the same `RGS_*` deploy inputs. No new leads/notices flag and **no new Lambda wiring**: the user API (which serves public lead + notices routes) already carries **`DATABASE_URL`** + **`CRM_STORE`** from C.2.1.

---

## Checklist

### 0. Preconditions (Phase C.2.1 live)

- [ ] **C.2.1 is live** on staging (portal applications / profiles / documents / activity on Postgres; C.2.1 runbook complete).
- [ ] **`CRM_STORE=postgres`** on staging **admin API**, **user API** (`rgs-user-api-<stage>`), and **appointment reminders** Lambda, each with **`DATABASE_URL`**.
- [ ] **`LEDGER_STORE=postgres`** on admin API only (unchanged; user API must not have it).
- [ ] Migrations **`001`–`006`** applied on `rgs_staging` (through `006_portal_sor.sql`).
- [ ] **`RGS_DATABASE_URL`** → Lambda **`DATABASE_URL`** (transaction pooler **`:6543`**, `?pgbouncer=true` if required).
- [ ] Admin build: **`VITE_LEDGER_COMBINED_FILTERS=true`** iff **`LEDGER_STORE=postgres`** (unchanged).
- [ ] Note the staging Dynamo table name (expected **`rgs-platform-staging`**) — the same table the staging admin API uses.

### 1. Schema (migration 007)

Apply through **`007_portal_leads_notices.sql`** using the Supabase **session** connection (direct **`:5432`** or session pooler — **not** the transaction pooler used for Lambdas).

`backfill:leads-notices-postgres` (step 2) also calls `applyMigrations`; use this step only if you want the schema verified before the backfill.

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

- [ ] Confirm `schema_migrations` includes **`007_portal_leads_notices.sql`**.
- [ ] Confirm tables exist: `portal_leads`, `portal_notices`.
- [ ] Confirm both are empty before backfill (fresh migration): `select count(*)` on each is `0`.

### 2. Leads + notices backfill (Dynamo → Postgres) — **before C.2.2 deploy only**

- [ ] Point at **staging Dynamo** via **`TABLE_NAME=rgs-platform-staging`** (same table the staging admin API uses).
- [ ] Set **`DATABASE_URL`** to **`rgs_staging`** (session URL for the CLI is fine).
- [ ] **Do not** deploy C.2.2 postgres readers until this step succeeds — empty PG would hide every existing lead and blank the public notices ticker.
- [ ] Run (idempotent **only before C.2.2 deploy**):

```bash
TABLE_NAME='rgs-platform-staging' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
DATABASE_URL='postgresql://…/rgs_staging' \
  pnpm --filter @rgs/migration backfill:leads-notices-postgres
```

Discovery: leads via GSI1 partition **`STATUS#LEAD_NEW`** (as `listNewLeads` reads); notices via the **`NOTICE`** table partition (as `listNotices` reads). Both drain every page. Reads Dynamo regardless of `CRM_STORE`.

**Cutover gate — exit code and logs**

- [ ] CLI exit code is **0**. It exits **1** if any record could not be copied.
- [ ] **All `unreadable*` counts must be zero** in the summary table: `unreadableLeads`, `unreadableNotices`. Named ids are printed to stderr (`Leads not copied (leadId)`; `Notices not copied (noticeId)`). **Do not deploy C.2.2** until each is fixed in Dynamo and the backfill is re-run (still pre-deploy).
- [ ] Record `leadsUpserted` and `noticesUpserted` for step 3.

### 3. Count parity

**Postgres (`rgs_staging`):**

```sql
select
  (select count(*) from portal_leads)   as leads,
  (select count(*) from portal_notices) as notices;
```

**Compare to the backfill summary and to Dynamo (approximate check, consistent reads):**

- [ ] **Leads:** PG `leads` equals `leadsUpserted`; compare to the Dynamo GSI1 **`STATUS#LEAD_NEW`** partition item count.
- [ ] **Notices:** PG `notices` equals `noticesUpserted`; compare to the Dynamo **`NOTICE`** partition item count (`PK = NOTICE`).
- [ ] Spot-check the newest lead id and a pinned/published notice id exist in PG with matching fields.
- [ ] PG should not be **materially below** Dynamo after a clean backfill. Investigate any gap before deploying C.2.2.

### 4. Deploy API with C.2.2 code (no flag change)

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`**, **`RGS_LEDGER_STORE=postgres`**, **`RGS_CRM_STORE=postgres`** unchanged from C.2.1.
- [ ] Confirm cold start: **`CRM_STORE=postgres`** still requires **`DATABASE_URL`** (unchanged).
- [ ] **User API env check** (blocking — no new wiring expected, confirm it is still present): `aws lambda get-function-configuration --function-name rgs-user-api-<stage> --query 'Environment.Variables.[CRM_STORE,DATABASE_URL!=`null`,LEDGER_STORE]'` → `postgres`, `true`, `null`. If the user API lacks `CRM_STORE`/`DATABASE_URL`, public leads and notices stay on Dynamo while admin reads Postgres — stop and fix the deploy inputs.
- [ ] Admin API and appointment reminders Lambda: still **`CRM_STORE=postgres`** + **`DATABASE_URL`**; no C.2.2-specific env additions expected.
- [ ] **Do not** run `backfill:leads-notices-postgres`, `backfill:portal-sor-postgres`, `backfill:country-catalog-postgres`, `backfill:crm-remaining-postgres`, `backfill:crm-case-sor-postgres`, or `backfill:crm-ledger-postgres` after this deploy except during a deliberate rollback/re-cutover procedure.

### 5. Smoke (leads / notices / activity)

These checks validate **live Postgres**, not backfill freshness alone.

**Leads**

- [ ] **Marketing lead** — submit the marketing-site contact form (public `POST /api/v1/leads`); expect success, the admin notification email (SES unchanged), and a new row in `portal_leads` (`select * from portal_leads order by created_at desc limit 1`).
- [ ] **Admin leads** — admin `GET /api/v1/admin/leads` lists the just-submitted lead (newest first) plus backfilled leads; list count matches `portal_leads`.

**Notices**

- [ ] **Public notices** — marketing ticker / `GET /api/v1/notices` returns backfilled published, unexpired notices (pinned first, then published/created descending; country filter honoured, null country = global); response is 200 with empty `unreadableNoticeIds`.
- [ ] **Admin upsert** — create a draft notice, then edit it; row appears/updates in `portal_notices`.
- [ ] **Publish** — publish the notice; it appears on the public ticker and a `NOTICE_PUBLISHED` event is recorded.
- [ ] **Admin delete** — delete the smoke notice; it disappears from admin list and public ticker and the `portal_notices` row is gone.

**Activity and Dynamo silence**

- [ ] **Activity events** — `LEAD_CREATED` (from the smoke lead) and `NOTICE_PUBLISHED` (from the smoke publish) appear in `listRecentActivity` and in `activity_events`.
- [ ] **Dynamo silent** — no new Dynamo `LEAD#` item or `STATUS#LEAD_NEW` GSI entry for the smoke lead, no new `NOTICE` partition item for the smoke notice, and no new Dynamo `EVENT#<today>` item for either activity event.

### 6. Rollback

- [ ] Set **`RGS_CRM_STORE=dynamo`** (or unset → default **`dynamo`**); redeploy **admin API, user API, and appointment reminders Lambda** (one stack deploy covers all three; the user API must flip too or public leads/notices diverge from admin). **Entire** CRM SoR (B.1 + B.2 + C.1 catalog + C.2.1 portal/activity + C.2.2 leads/notices) returns to Dynamo reads/writes — same blast radius as C.2.1. If you rolled forward on C.2.2 code, redeploy the **previous** artifact or keep `postgres` and repair data instead.
- [ ] **`LEDGER_STORE=postgres` may stay on** if you only revert **`CRM_STORE`**; ledger SQL reads still work but case-linked views may disagree until reconciled.
- [ ] **Warn operators:** any leads captured, notices edited/published/deleted, or other CRM edits that happened only on Postgres **do not appear** in Dynamo-backed tooling until manually repaired or you re-cutover to PG.
- [ ] **Do not** re-run `backfill:leads-notices-postgres` while C.2.2 is live and Postgres holds newer data — it overwrites PG from stale Dynamo. Re-cutover requires a documented procedure (flag + code version + optional fresh backfill only while the old build is serving writes).
- [ ] Prefer **fix-forward** on staging once C.2.2 is live.

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | **`DATABASE_URL`** on admin API, user API, and reminders (transaction pooler **`:6543`** at runtime) |
| CDK / deploy | `RGS_LEDGER_STORE` | **`LEDGER_STORE`** on admin API only (**not** user API) — stay **`postgres`** on staging |
| CDK / deploy | `RGS_CRM_STORE` | **`CRM_STORE`** on admin API, user API, and reminders — stay **`postgres`** on staging (no C.2.2 flip; flipping to `dynamo` is the rollback) |
| Leads+notices backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required; `TABLE_NAME=rgs-platform-staging`; reads Dynamo, writes **`rgs_staging`** |
| Migrations (one-off) | `DATABASE_URL` | **Session** URL through migration **007** |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` iff **`LEDGER_STORE=postgres`** |

---

## Related runbooks

- Phase C.2.1 (portal + activity): `2026-10-02-supabase-phase-c2-1-staging-runbook.md`
- Phase C.1 (country catalog): `2026-10-02-supabase-phase-c1-staging-runbook.md`
- Phase B.2 (remaining CRM): `2026-10-01-supabase-phase-b2-staging-runbook.md`
- Phase B.1 (case SoR): `2026-10-01-supabase-phase-b-staging-runbook.md`
- Phase A (ledger reads): `2026-10-01-supabase-phase-a-staging-runbook.md`
