# RGS — Supabase Postgres Phase C.2.1 (portal + activity SoR)

**Date:** 2026-10-02  
**Status:** draft (awaiting owner review)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md`  
**Prior:** Phase C.1 (`CRM_STORE=postgres` country catalog) + staging runbook

---

## 1. Why

CRM + country catalog are on Postgres under `CRM_STORE=postgres` (Phases A–C.1).
Portal and shared audit surfaces still hit **Dynamo**:

- Portal **applications** (`USER#` / `APP#`, status GSI) — create/patch/submit,
  list mine, get owned.
- Admin **application queue** by status (`listApplicationsByStatus`).
- **User profiles** (`USER#` / `PROFILE`, profile GSI).
- **Document metadata** on the application row (bytes remain in S3).
- **Activity** — `logActivity` writes + `listRecentActivity` / `listUserActivity`
  (day-bucket partitions + GSI2).

**Goal:** Move applications, user profiles, document metadata (as part of the
application row), and activity onto Postgres under the existing `CRM_STORE`
flag so portal and admin no longer depend on Dynamo for those flows.

**Non-goal:** Leads and notices (Phase **C.2.2**); deleting the Dynamo table
(Phase **D**); dual-write; a new portal-only env flag; changing Cognito / S3 /
SES.

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | Scope = **C.2.1 portal core + activity** (not full C.2 / not leads+notices) | Full C.2 in one design; portal without admin queue; activity deferred |
| 2 | Gate on existing **`CRM_STORE`** (`dynamo` \| `postgres`) | New `PORTAL_STORE` |
| 3 | End state for these domains = **Postgres only** | Long-lived Dynamo fallback for apps/activity |
| 4 | Approach = **mirror B.2 / C.1**: SQL adapters + migrate → backfill → deploy; no dual-write | Dual-write window; apps first then activity as a separate ship without you choosing activity in |
| 5 | **Documents metadata** stays on the application row (JSON); S3 object keys / bytes unchanged | Separate `documents` SoR table in C.2.1 |
| 6 | **Admin status queue** included (same application SoR) | Portal-only writes with admin still on Dynamo |
| 7 | **Activity included** — `logActivity` + list feeds/trails on PG (CRM config changes also write PG activity under postgres) | Leave activity on Dynamo (C.1 style) |
| 8 | Staging first on `rgs_staging`; prod later after soak | Prod in same change |

---

## 3. Scope

### In

| Area | Surfaces |
|---|---|
| Applications | `createDraft`, `patchDraft`, `submitApplication`, `getOwnedApplication`, `listMyApplications`, `listApplicationDocuments` / missing-docs helpers as today |
| Admin queue | `listApplicationsByStatus` (+ any get-by-application-id admin path that reads the same SoR) |
| Users | `ensureUserProfile`, `getUserProfile`, `listUserProfiles` |
| Documents | Presign upload/download still S3; `recordDocumentUpload` updates application JSON in PG |
| Activity | `logActivity`; `listRecentActivity`; `listUserActivity` |
| Ops | Staging runbook; smoke portal + admin queue + activity |

### Out

- Leads, notices (C.2.2).
- Dynamo decommission (Phase D).
- Changing Cognito / S3 / SES.
- Re-running Phase A/B/C.1 backfills after cutover (still forbidden).

---

## 4. Target schema (indicative)

Exact DDL in the migration file(s); shapes must round-trip shared Zod schemas
(`Application`, `User`, `ActivityEvent`).

| Table | Role |
|---|---|
| `portal_applications` | PK `application_id`; `user_id`; `status`; traveller / document / wizard fields as columns and/or jsonb matching `ApplicationSchema`; `created_at` / `updated_at`; indexes `(user_id, updated_at DESC)`, `(status, updated_at DESC)` |
| `portal_user_profiles` | PK `user_id`; profile columns matching `UserSchema`; timestamps as needed |
| `activity_events` | PK `event_id`; `event_type`; `user_id`; optional `application_id`; `meta` jsonb; `created_at`; optional actor fields; indexes `(created_at DESC)`, `(user_id, created_at DESC)` |

No separate documents table in C.2.1.

---

## 5. Architecture

```
CRM_STORE=dynamo     → existing TableClient paths (unchanged)
CRM_STORE=postgres   → SQL adapters; require DATABASE_URL
LEDGER_STORE         → unchanged
```

- Dispatch at domain entry points via `crmPostgresOf` (same pattern as B.1–C.1).
- When `CRM_STORE=postgres`, never silently fall back to Dynamo for C.2.1
  surfaces — fail if `sql` missing.
- Corrupt / unreadable rows: name ids (`applicationId`, `userId`, `eventId`);
  do not silent-drop from listings.
- `documents.ts` keeps S3; ownership checks and metadata persistence go through
  application PG helpers.
- `logActivity` under postgres inserts into `activity_events` only (no Dynamo
  day-bucket put). CRM callers (e.g. config upsert) inherit that behaviour when
  the flag is postgres.

---

## 6. Cutover (staging)

`RGS_CRM_STORE` is already `postgres` on staging after B.1–C.1.

1. Apply migration(s) on `rgs_staging` (session URL).
2. Backfill applications, profiles, and activity from staging Dynamo; gate on
   all `unreadable*` = 0.
3. Deploy API with C.2.1 code (same `RGS_*` env; no flag flip).
4. Smoke: portal draft/list/submit; admin status queue; document upload record;
   activity feed + user trail; one CRM/config action still appears in activity
   on PG.
5. Do **not** re-run C.2.1 (or A/B/C.1) backfills after deploy — they overwrite
   newer PG rows from stale Dynamo.

**Ship order:** migrate → backfill → deploy. Do not deploy postgres readers
against empty application/activity tables.

### Rollback

- Set `RGS_CRM_STORE=dynamo` (or unset) and redeploy admin + reminders —
  **entire** CRM + catalog + portal + activity return to Dynamo (same blast
  radius pattern as C.1).
- PG-only writes since cutover do not appear in Dynamo; warn operators.
- Prefer fix-forward on staging after C.2.1 is live.

### Prod

Separate runbook after staging soak. Not day-one of this design.

---

## 7. Testing

- PGlite migrations for new tables / indexes / constraints.
- Per-domain: `CRM_STORE=dynamo` unchanged; postgres round-trip; unreadable
  naming on list paths.
- Applications: user list + admin status list see PG-only creates/updates.
- Documents: metadata update on PG app row; S3 key shape unchanged.
- Activity: recent window + user trail SQL; `logActivity` under postgres does
  not write Dynamo EVENT# partitions.
- Backfill: idempotent; exit non-zero if any unreadable list non-empty.

---

## 8. File map (indicative)

| Area | Location |
|---|---|
| Migration | `services/api/src/db/migrations/006_…` (one or more), `migrate.ts` |
| Applications SQL | `services/api/src/domain/applicationsPostgres.ts` (+ dispatch in `applications.ts`) |
| Admin queue | `services/api/src/domain/admin.ts` dispatch to SQL |
| Users SQL | `services/api/src/domain/userProfilesPostgres.ts` (+ `users.ts`) |
| Activity SQL | `services/api/src/domain/activityPostgres.ts`; `logActivity` in `lib/context.ts` |
| Documents | `documents.ts` — keep S3; route metadata writes through applications PG |
| Backfill | `services/migration/src/backfillPortalActivityToPostgres*.ts` (name TBD in plan) |
| Runbook | `docs/superpowers/specs/2026-10-02-supabase-phase-c2-1-staging-runbook.md` (with plan) |

Implementation detail and task checkboxes live in the Phase C.2.1 **plan**
(writing-plans after this spec is approved).

---

## 9. Success criteria

1. Staging: with `CRM_STORE=postgres`, portal app flows and admin status queue
   use Postgres; Dynamo `USER#`/`APP#` / status GSI not required for those flows.
2. User profiles list/get/ensure on Postgres.
3. Document metadata persists on PG application rows; S3 unchanged.
4. Activity writes and feeds/trails on Postgres; Dynamo EVENT# not required.
5. Backfill gate clean; rollback path documented (`CRM_STORE` flip).
6. No leads/notices/D scope creep in the C.2.1 plan.

---

## 10. Approval

Approve this design to unlock
`docs/superpowers/plans/2026-10-02-supabase-postgres-phase-c2-1-portal.md`.

**Owner sign-off:** _pending_
