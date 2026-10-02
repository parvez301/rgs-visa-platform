# Supabase Phase C.2.1 — staging cutover runbook

**Date:** 2026-10-02  
**Scope:** Portal applications, application document metadata, user profiles, and activity events on Postgres under existing **`CRM_STORE=postgres`**: `createDraft` / `patchDraft` / `submitApplication` / `getOwnedApplication` / `listMyApplications`, admin `listApplicationsByStatus`, `ensureUserProfile` / `getUserProfile` / `listUserProfiles`, document metadata (`recordDocumentUpload`; S3 bytes unchanged), `logActivity` / `listRecentActivity` / `listUserActivity`.  
**Design:** `2026-10-02-supabase-postgres-phase-c2-1-portal-design.md` · **Plan:** `docs/superpowers/plans/2026-10-02-supabase-postgres-phase-c2-1-portal.md`  
**Prerequisite runbooks:** `2026-10-02-supabase-phase-c1-staging-runbook.md` (C.1 catalog) → `2026-10-01-supabase-phase-b2-staging-runbook.md` (B.2 remaining CRM SoR)

**Out of scope:** leads and notices (Phase C.2.2); deleting the Dynamo table (Phase D); Cognito / S3 / SES changes.

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** (match staging API Lambdas) |

> **Freshness contract (read first).** Phase C.2.1 has **no dual-write** to Dynamo for portal applications, profiles, document metadata, or activity. After C.2.1 code is live, these flows go to Postgres only (`portal_applications`, `portal_application_documents`, `portal_user_profiles`, `activity_events`). `logActivity` under postgres inserts into `activity_events` only — no Dynamo `EVENT#` day-bucket put (CRM callers such as config upserts inherit this).  
> **`backfill:portal-sor-postgres` is a pre-deploy copy only.** Run it **before** deploying C.2.1 application code (migrate → backfill → deploy). **Never re-run it after C.2.1 is live** — it reads staging Dynamo and **overwrites** Postgres application, document, and profile rows with stale Dynamo copies, destroying portal and admin changes made on PG since deploy.  
> **Do not re-run Phase C.1 `backfill:country-catalog-postgres`, Phase B.2 `backfill:crm-remaining-postgres`, Phase B.1 `backfill:crm-case-sor-postgres`, or Phase A `backfill:crm-ledger-postgres` either** — same clobber risk on catalog, CRM, and ledger SoR.  
> **No Dynamo fallback after cutover.** With `CRM_STORE=postgres`, C.2.1 surfaces fail if `DATABASE_URL` is missing; they never silently read Dynamo. Empty `portal_applications` / `activity_events` on a staging that had real Dynamo data is a failed backfill or misconfiguration — do not deploy against it.

> **`ACTIVITY_START_DATE` caveat (Task 6).** Dynamo activity lives in `EVENT#YYYY-MM-DD` day buckets that cannot be listed. The backfill walks every UTC day from the **earliest valid `createdAt` among profiles and applications** through tomorrow. Events **older than that earliest profile/application are not found** unless you set **`ACTIVITY_START_DATE=YYYY-MM-DD`** (earlier than your oldest expected event; it widens the walk, one Dynamo query per day). Pick the date before the first run — a later widened run is a re-run and is forbidden after deploy. Activity-only history (e.g. early `CONFIG_CHANGED` events from before any user or application existed) is the case this affects.

> **Other backfill limitations.** An application with **no profile and an unknown status** is unreachable by discovery (and unreadable by the live API); documents belonging to undiscovered applications are not copied.

> **Security note (unchanged from Phase A/B/C.1).** `RGS_DATABASE_URL` (password included) is a plaintext admin Lambda env var; the pg client does not pin the Supabase CA. Staging-only until secrets and TLS are hardened for prod.

> **No env flag flip.** Staging should already have **`RGS_CRM_STORE=postgres`** and **`RGS_LEDGER_STORE=postgres`** from B.1/B.2/C.1. This cutover is **migrate → backfill → deploy C.2.1 code** with the same `RGS_*` deploy inputs. No new portal-only flag.

---

## Checklist

### 0. Preconditions (Phase B.2 / C.1 live)

- [ ] **`CRM_STORE=postgres`** and **`LEDGER_STORE=postgres`** on staging admin API (and appointment reminders **`CRM_STORE=postgres`** + **`DATABASE_URL`** per B.1).
- [ ] B.1 + B.2 + C.1 migrations **`001`–`005`** applied; case/partner, remaining CRM, and country catalog SoR already on Postgres (C.1 runbook complete).
- [ ] **`RGS_DATABASE_URL`** → admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`**, `?pgbouncer=true` if required).
- [ ] Admin build: **`VITE_LEDGER_COMBINED_FILTERS=true`** iff **`LEDGER_STORE=postgres`** (unchanged).
- [ ] Decide **`ACTIVITY_START_DATE`** (see caveat above): earliest date any activity event could exist in staging Dynamo. If unsure, choose conservatively early.

### 1. Schema (migration 006)

Apply through **`006_portal_sor.sql`** using the Supabase **session** connection (direct **`:5432`** or session pooler — **not** the transaction pooler used for Lambdas).

`backfill:portal-sor-postgres` (step 2) also calls `applyMigrations`; use this step only if you want the schema verified before the backfill.

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

- [ ] Confirm `schema_migrations` includes **`006_portal_sor.sql`**.
- [ ] Confirm tables exist: `portal_applications`, `portal_application_documents`, `portal_user_profiles`, `activity_events`.
- [ ] Confirm all four are empty before backfill (fresh migration): `select count(*)` on each is `0`.

### 2. Portal SoR backfill (Dynamo → Postgres) — **before C.2.1 deploy only**

- [ ] Point at **staging Dynamo** via **`TABLE_NAME`** (same table the staging admin API uses).
- [ ] Set **`DATABASE_URL`** to **`rgs_staging`** (session URL for the CLI is fine).
- [ ] Set **`ACTIVITY_START_DATE`** per step 0.
- [ ] **Do not** deploy C.2.1 postgres readers until this step succeeds — empty PG would hide every existing portal application, profile, and activity event.
- [ ] Run (idempotent **only before C.2.1 deploy**):

```bash
TABLE_NAME='<staging-table>' \
AWS_PROFILE='<profile>' AWS_REGION='ap-south-1' \
DATABASE_URL='postgresql://…/rgs_staging' \
ACTIVITY_START_DATE='YYYY-MM-DD' \
  pnpm --filter @rgs/migration backfill:portal-sor-postgres
```

**Cutover gate — exit code and logs**

- [ ] CLI exit code is **0**. It exits **1** if any record could not be copied.
- [ ] **All `unreadable*` counts must be zero** in the summary table: `unreadableApplications`, `unreadableDocuments`, `unreadableUsers`, `unreadableEvents`. Named ids are printed to stderr (applicationId; `applicationId / DOC#type#idx`; userId; eventId). **Do not deploy C.2.1** until each is fixed in Dynamo and the backfill is re-run (still pre-deploy).
- [ ] Record `applicationsUpserted`, `documentsUpserted`, `profilesUpserted`, `activityEventsUpserted` for step 3.

### 3. Count parity

**Postgres (`rgs_staging`):**

```sql
select
  (select count(*) from portal_applications)          as applications,
  (select count(*) from portal_application_documents) as documents,
  (select count(*) from portal_user_profiles)         as profiles,
  (select count(*) from activity_events)              as activity_events;
```

**Compare to the backfill summary and to Dynamo (approximate check, consistent reads):**

- [ ] **Applications:** PG `applications` equals `applicationsUpserted`; compare to Dynamo `APP#` items (GSI1 `STATUS#<status>` partitions, summed across statuses).
- [ ] **Documents:** PG `documents` equals `documentsUpserted`; compare to `DOC#` items under each `APP#<id>` partition.
- [ ] **Profiles:** PG `profiles` equals `profilesUpserted`; compare to Dynamo GSI1 `USERPROFILE` partition.
- [ ] **Activity:** PG `activity_events` equals `activityEventsUpserted`; spot-check oldest and newest event ids against Dynamo `EVENT#<day>` buckets. If the oldest Dynamo bucket you know of is **before** the oldest PG `created_at`, the `ACTIVITY_START_DATE` was too late — fix and re-run **before deploy**.
- [ ] PG should not be **materially below** Dynamo after a clean backfill. Investigate any gap before deploying C.2.1.

### 4. Deploy API with C.2.1 code (no flag change)

- [ ] Deploy staging stack with **`RGS_DATABASE_URL`**, **`RGS_LEDGER_STORE=postgres`**, **`RGS_CRM_STORE=postgres`** unchanged from C.1.
- [ ] Confirm cold start: **`CRM_STORE=postgres`** still requires **`DATABASE_URL`** (unchanged).
- [ ] Appointment reminders Lambda: still **`CRM_STORE=postgres`** + **`DATABASE_URL`**; no C.2.1-specific env additions expected.
- [ ] **Do not** run `backfill:portal-sor-postgres`, `backfill:country-catalog-postgres`, `backfill:crm-remaining-postgres`, `backfill:crm-case-sor-postgres`, or `backfill:crm-ledger-postgres` after this deploy except during a deliberate rollback/re-cutover procedure.

### 5. Smoke (portal / admin / documents / activity)

These checks validate **live Postgres**, not backfill freshness alone.

**Portal**

- [ ] **Existing user** — sign in as a user with a pre-cutover application: profile loads (`getUserProfile`), `listMyApplications` shows backfilled applications with correct status.
- [ ] **New draft** — create a draft, patch a traveller field, read back; row appears in `portal_applications` (not as a new Dynamo `APP#` item).
- [ ] **Submit** — submit the draft; status becomes submitted and the row in PG reflects it.
- [ ] **New user** — `ensureUserProfile` for a new sign-in creates a `portal_user_profiles` row.

**Admin**

- [ ] **Status queue** — `listApplicationsByStatus` for the submitted status includes the just-submitted application plus backfilled ones; counts match PG.
- [ ] **Application detail** — admin open of a backfilled application shows travellers and documents.
- [ ] **User profiles list** — admin `listUserProfiles` shows backfilled and newly created profiles.

**Documents**

- [ ] **Upload record** — presign upload (S3), upload a test file, record it; a row lands in `portal_application_documents` with the expected `s3_key` shape (unchanged from Dynamo-era keys).
- [ ] **Download** — presigned download of a backfilled document works (S3 key preserved by backfill).
- [ ] **Missing docs** — missing-docs helper reflects the new upload.

**Activity**

- [ ] **Feed** — `listRecentActivity` returns recent events, including backfilled ones and those created by the smoke steps above.
- [ ] **User trail** — `listUserActivity` for the smoke user shows draft/submit events.
- [ ] **CRM action on PG** — perform one CRM/config action (e.g. country product upsert) and confirm its event appears in the feed and in `activity_events`, and that **no** new Dynamo `EVENT#<today>` item was written.

### 6. Rollback

- [ ] Set **`RGS_CRM_STORE=dynamo`** (or unset → default **`dynamo`**); redeploy **admin API and appointment reminders Lambda** (one stack deploy does both). **Entire** CRM SoR (B.1 + B.2 + C.1 catalog + C.2.1 portal/activity) returns to Dynamo reads/writes — same blast radius as C.1. If you rolled forward on C.2.1 code, redeploy the **previous** artifact or keep `postgres` and repair data instead.
- [ ] **`LEDGER_STORE=postgres` may stay on** if you only revert **`CRM_STORE`**; ledger SQL reads still work but case-linked views may disagree until reconciled.
- [ ] **Warn operators:** any applications, profiles, document metadata, activity, or other CRM edits that happened only on Postgres **do not appear** in Dynamo-backed tooling until manually repaired or you re-cutover to PG.
- [ ] **Do not** re-run `backfill:portal-sor-postgres` while C.2.1 is live and Postgres holds newer data — it overwrites PG from stale Dynamo. Re-cutover requires a documented procedure (flag + code version + optional fresh backfill only while the old build is serving writes).
- [ ] Prefer **fix-forward** on staging once C.2.1 is live.

---

## Env reference

| Where | Variable | Role |
|---|---|---|
| CDK / deploy | `RGS_DATABASE_URL` | Admin Lambda **`DATABASE_URL`** (transaction pooler **`:6543`** at runtime) |
| CDK / deploy | `RGS_LEDGER_STORE` | **`LEDGER_STORE`** — stay **`postgres`** on staging |
| CDK / deploy | `RGS_CRM_STORE` | **`CRM_STORE`** — stay **`postgres`** on staging (no C.2.1 flip) |
| Portal backfill CLI | `TABLE_NAME`, `DATABASE_URL` | Required; reads Dynamo, writes **`rgs_staging`** |
| Portal backfill CLI | `ACTIVITY_START_DATE` | Optional `YYYY-MM-DD`; widens the activity day-bucket walk before the earliest profile/application |
| Migrations (one-off) | `DATABASE_URL` | **Session** URL through migration **006** |
| Admin build | `VITE_LEDGER_COMBINED_FILTERS` | `"true"` iff **`LEDGER_STORE=postgres`** |

---

## Related runbooks

- Phase C.1 (country catalog): `2026-10-02-supabase-phase-c1-staging-runbook.md`
- Phase B.2 (remaining CRM): `2026-10-01-supabase-phase-b2-staging-runbook.md`
- Phase B.1 (case SoR): `2026-10-01-supabase-phase-b-staging-runbook.md`
- Phase A (ledger reads): `2026-10-01-supabase-phase-a-staging-runbook.md`
