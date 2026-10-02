# RGS — Supabase Postgres Phase C.2.2 (leads + notices SoR)

**Date:** 2026-10-02  
**Status:** draft (awaiting written-spec review)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md`  
**Prior:** Phase C.2.1 (`CRM_STORE=postgres` portal + activity) + staging cutover  
**Runbook:** `2026-10-02-supabase-phase-c2-2-staging-runbook.md` (with plan)

---

## 1. Why

Under staging `CRM_STORE=postgres` + `LEDGER_STORE=postgres`, CRM cases,
partners, travellers, reviews, memory, templates, ref-claims, ledger, country
catalog, portal applications / documents / profiles, and activity already use
Postgres. The only **product** domains still Dynamo-only at runtime are:

- **Leads** — public `POST /api/v1/leads` (`createLead` + admin email +
  `LEAD_CREATED` activity); admin `GET /api/v1/admin/leads` (`listNewLeads`
  via GSI1 `STATUS#LEAD_NEW`).
- **Notices** — public `GET /api/v1/notices` (marketing ticker); admin list /
  upsert / delete on partition `NOTICE`.

**Goal:** Move leads and notices onto Postgres under the existing `CRM_STORE`
flag so no product SoR remains on Dynamo after this ship (Dynamo client paths
for other domains become dead under postgres until Phase D removes them).

**Non-goal:** Phase **D** (delete Dynamo table / client / GSI helpers);
lead status lifecycle beyond today’s “all new” queue; dual-write; a new
store flag; Cognito / S3 / SES changes; prod cutover day-one.

**Sequencing (owner):** C.2.2 then Phase D as separate ships.

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | Scope = **leads + notices only** (last product Dynamo SoR) | Fold Phase D into same ship; invent lead statuses |
| 2 | Gate on existing **`CRM_STORE`** | New `LEADS_STORE` / `NOTICES_STORE` |
| 3 | End state for these domains = **Postgres only** | Long-lived Dynamo fallback |
| 4 | Approach = **mirror C.2.1**: SQL adapters + migrate → backfill → deploy; no dual-write | Dual-write window; notices-first / leads-second mini-ships |
| 5 | Tables `portal_leads` + `portal_notices` (portal/marketing admin surfaces) | `crm_*` naming (these are not CRM case SoR) |
| 6 | Lead list = all rows ordered by `created_at DESC` (parity with `STATUS#LEAD_NEW` only) | Add lead status column / close-lead flows |
| 7 | Notice unreadable rows stay **named** on admin + public lists (no 500 on bad row) | Silent drop; fail-hard whole list |
| 8 | Staging first on `rgs_staging`; prod later after soak | Prod in same change |
| 9 | Phase D = **next ship after soak**, not this plan | Decommission Dynamo in C.2.2 |

---

## 3. Scope

### In

| Area | Surfaces |
|---|---|
| Leads | `createLead` (public); `listNewLeads` (admin); SES notify unchanged; `logActivity` `LEAD_CREATED` (already PG under postgres) |
| Notices | `listNotices` / `listPublicNotices`; `upsertNotice`; `deleteNotice`; `NOTICE_PUBLISHED` activity when published |
| Ops | Staging runbook; smoke marketing lead + public ticker + admin CRUD |

### Out

- Phase D (Dynamo decommission).
- Lead lifecycle / archive / status transitions.
- Changing Cognito / S3 / SES.
- Re-running Phase A–C.2.1 backfills after cutover (still forbidden).
- Prod cutover (separate runbook after soak).

---

## 4. Target schema (indicative)

Exact DDL in migration `007`; shapes must round-trip live lead fields and
`NoticeSchema` / `NoticeInputSchema`.

| Table | Role |
|---|---|
| `portal_leads` | PK `lead_id`; `full_name`, `phone`, `topic`, `message`, `created_at`; index `(created_at DESC)` |
| `portal_notices` | PK `notice_id`; `title`, `body`, `category`, `severity`; optional `country_code`; `pinned`; `status`; optional `published_at`, `expires_at`; `created_at`, `updated_at`; `created_by_email`; indexes for admin list (`created_at DESC`) and public ticker (`status`, `pinned`, `published_at` / `created_at`) |

Public notice filter stays in domain logic (or equivalent SQL): `status =
PUBLISHED`, not past `expires_at`, optional `countryCode` match (null country
= global), pinned first then published/created desc.

---

## 5. Architecture

```
CRM_STORE=dynamo     → existing TableClient paths (unchanged)
CRM_STORE=postgres   → SQL adapters; require DATABASE_URL
LEDGER_STORE         → unchanged
```

- Dispatch at `createLead` / `listNewLeads` / notice entry points via
  `crmPostgresOf` (same pattern as C.2.1).
- When `CRM_STORE=postgres`, never silently fall back to Dynamo for leads or
  notices — fail if `sql` missing.
- Corrupt / unreadable notice rows: name ids (`unreadableNoticeIds`); do not
  silent-drop from listings; public ticker must not 500.
- Lead create under postgres: insert `portal_leads` only (no `LEAD#` /
  `STATUS#LEAD_NEW` Dynamo put); activity via existing PG `logActivity`.
- Notice upsert/delete under postgres: SQL only (no `NOTICE` partition put /
  delete); publish still calls `logActivity`.
- **Infra:** user API already carries `DATABASE_URL` + `CRM_STORE` (C.2.1);
  public lead + notices run there. No new Lambda env wiring expected.

---

## 6. Cutover (staging)

`RGS_CRM_STORE` is already `postgres` on staging after C.2.1.

1. Apply migration **007** on `rgs_staging` (session URL).
2. Backfill leads + notices from staging Dynamo; gate on all `unreadable*` = 0.
3. Deploy API with C.2.2 code (same `RGS_*` env; no flag flip).
4. Smoke: marketing lead → row in `portal_leads` (no new Dynamo `LEAD#`);
   admin leads list; public notices; admin upsert/publish/delete; activity
   `LEAD_CREATED` / `NOTICE_PUBLISHED` in `activity_events` only (no new
   Dynamo `EVENT#` for those).
5. Do **not** re-run C.2.2 (or A–C.2.1) backfills after deploy — they overwrite
   newer PG rows from stale Dynamo.

**Ship order:** migrate → backfill → deploy. Do not deploy postgres readers
against empty lead/notice tables if staging had real Dynamo data.

### Backfill discovery

- **Leads:** GSI1 partition `STATUS#LEAD_NEW` (same as `listNewLeads`).
- **Notices:** table partition `NOTICE` (full query; small).
- Idempotent upserts by `lead_id` / `notice_id`. CLI exits 1 if any
  `unreadable*` list non-empty.

### Rollback

- Set `RGS_CRM_STORE=dynamo` (or unset) and redeploy **admin API, user API,
  and appointment reminders** (one stack deploy) — **entire** CRM + catalog +
  portal + activity + leads + notices return to Dynamo.
- PG-only writes since cutover do not appear in Dynamo; warn operators.
- Prefer fix-forward on staging after C.2.2 is live.

### Prod

Separate runbook after staging soak. Not day-one of this design.

---

## 7. Testing

- PGlite migration for `portal_leads` / `portal_notices` + indexes.
- Per-domain: `CRM_STORE=dynamo` unchanged; postgres round-trip create/list
  (leads) and list/upsert/delete (notices).
- Public notices: published / expiry / country / pin ordering parity; unreadable
  ids named without failing the response.
- Backfill: idempotent; exit non-zero if any unreadable list non-empty.
- Under postgres, lead create and notice publish do not write Dynamo lead /
  notice / EVENT# items (activity already PG).

---

## 8. File map (indicative)

| Area | Location |
|---|---|
| Migration | `services/api/src/db/migrations/007_portal_leads_notices.ts`, `migrate.ts` |
| Leads SQL | `services/api/src/domain/leadsPostgres.ts` (+ dispatch in `leads.ts`) |
| Notices SQL | `services/api/src/domain/noticesPostgres.ts` (+ dispatch in `notices.ts`) |
| Backfill | `services/migration/src/backfillLeadsNoticesToPostgres.ts` (+ CLI + `backfill:leads-notices-postgres`) |
| Runbook | `docs/superpowers/specs/2026-10-02-supabase-phase-c2-2-staging-runbook.md` (with plan) |

Implementation detail and task checkboxes live in the Phase C.2.2 **plan**
(writing-plans after this written spec is approved).

---

## 9. Success criteria

1. Staging: with `CRM_STORE=postgres`, lead create/list and notice
   list/upsert/delete use Postgres; Dynamo `LEAD#` / `STATUS#LEAD_NEW` /
   `NOTICE` not required for those flows.
2. Public notices ticker stays up if one row is corrupt (named unreadable ids).
3. Backfill gate clean; rollback path documented (`CRM_STORE` flip includes
   user API).
4. No Phase D / lead-lifecycle scope creep in the C.2.2 plan.
5. After C.2.2 soak, Phase D can remove Dynamo production wiring.

---

## 10. Approval

Approve this design to unlock
`docs/superpowers/plans/2026-10-02-supabase-postgres-phase-c2-2-leads-notices.md`.

**Owner sign-off:** _pending_
