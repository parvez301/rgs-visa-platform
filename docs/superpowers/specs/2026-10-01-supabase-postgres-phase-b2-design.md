# RGS — Supabase Postgres Phase B.2 (remaining CRM SoR)

**Date:** 2026-10-01  
**Status:** approved (implementation plan landed)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md`  
**Prior:** Phase B.1 plan + staging runbook (`CRM_STORE=postgres` case/partner/traveller/event/ref-claim SoR)

---

## 1. Why

Phase B.1 moved CRM **case** system-of-record reads and writes to Postgres on
staging. Several CRM surfaces still hit **Dynamo only**:

- Agent / ops case lists and counts (`listCasesByStatus`, `listCasesByPartner`,
  `countCasesByField`) — stale or empty vs Postgres cases.
- Import **caseRef reservation** index (`caseRefIndex`) — separate from
  `crm_ref_claims`.
- Review queue, agent proposals, CRM memory, user prefs.
- Status-email template admin reads and writes.

**Goal:** Under the existing `CRM_STORE=postgres` flag, make those domains
Postgres-backed so the desk and agent no longer depend on Dynamo for CRM
correctness.

**Non-goal:** Visa platform / shared admin catalog (Phase C); deleting the
Dynamo table (Phase D); dual-write; new feature flags per domain.

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | Gate everything on existing **`CRM_STORE`** (`dynamo` \| `postgres`) | Per-domain store flags |
| 2 | No dual-write; migrate → backfill → deploy B.2 code | Soft dual-write window |
| 3 | Staging first on `rgs_staging`; prod later after soak | Prod in same change |
| 4 | One migration batch (e.g. `004_crm_remaining_sor`) + backfill CLI(s) | Ad-hoc console DDL |
| 5 | `caseRefIndex` → table **`crm_case_ref_reservations`**, distinct from **`crm_ref_claims`** | Merge reservation into ref_claims |
| 6 | Country checklist Dynamo leftovers: no new SoR; live path stays `CountryProduct.requiredDocuments` (Phase C for full catalog) | Re-platform checklist as its own B.2 table |
| 7 | Status-email **reads and writes** both use Postgres when `CRM_STORE=postgres` | Reads Dynamo, writes PG only |

---

## 3. Scope

### In (A–E)

| Bucket | Surfaces |
|---|---|
| A | `listCasesByStatus`, `listCasesByPartner`, `countCasesByField` → SQL on `crm_cases` (+ partner join if needed) |
| B | `caseRefIndex` reservation R/W → `crm_case_ref_reservations` |
| C | Review queue; agent proposals (stage / list / get / apply storage) |
| D | CRM memory; user prefs |
| E | Status-email templates (get / list / upsert) |

### Out

- Applications, portal users, leads, notices, full country-product catalog (Phase C).
- Dynamo decommission (Phase D).
- Changing Cognito / S3 / SES.
- Re-running Phase A ledger or B.1 case SoR backfills after cutover (still forbidden; they clobber PG from Dynamo).

---

## 4. Target schema (indicative)

Exact DDL lives in the migration file; shapes must round-trip existing Zod /
shared schemas.

| Table | Role |
|---|---|
| `crm_case_ref_reservations` | `(tenant_id, case_ref)` PK → `case_id`, `reserved_at`, `completed_at` |
| `crm_review_items` | Review queue rows; filter by `review_status` |
| `crm_proposals` | Agent proposals; filter by status; payload columns / jsonb matching `ProposedChange` |
| `crm_memories` | Scoped memories (`tenant_id`, `scope`, memory id, text/meta, …) |
| `crm_user_prefs` | `(tenant_id, email)` prefs / trust ladder |
| `crm_status_email_templates` | `(tenant_id, case_status)` template body |

Case list/count queries use existing **`crm_cases`** / **`crm_partners`** — no
new case body tables.

---

## 5. Architecture

```
CRM_STORE=dynamo     → existing TableClient paths (unchanged)
CRM_STORE=postgres   → SQL adapters; require DATABASE_URL (already enforced)
LEDGER_STORE         → unchanged (already postgres on staging)
```

- Dispatch at domain entry points (same pattern as `caseStore` / events /
  partners in B.1).
- Pooler: transaction mode `:6543` for Lambda; session `:5432` for DDL /
  long backfill (retry on transient `EADDRNOTAVAIL` as in B.1).
- Unreadable / corrupt rows: name ids; do not silent-drop (existing discipline).

---

## 6. Cutover (staging)

`RGS_CRM_STORE` is already `postgres` on staging after B.1.

1. Apply migration(s) on `rgs_staging` (session URL).
2. Backfill new tables from staging Dynamo; **all `unreadable*` counts = 0**.
3. Spot-check counts (OPEN reviews, pending proposals, memories, templates).
4. Deploy admin API with B.2 code (same env: `DATABASE_URL`, `LEDGER_STORE`,
   `CRM_STORE`). Reminders Lambda unchanged unless it gains a B.2 dependency
   (it should not).
5. Smoke: agent list/count; review list/resolve; proposal stage/list; memory
   recall; prefs read; status-email upsert; reservation semantics if import
   used on staging.
6. Do **not** re-run B.1 SoR or ledger backfills after this deploy.

**Ship order ruling:** backfill while new modules still read Dynamo in the
**previous** build if needed; preferred path is migrate → backfill → deploy
B.2 so first postgres readers see full data. Do not deploy B.2 postgres
readers against empty new tables.

### Rollback

- Set `RGS_CRM_STORE=dynamo` (or unset); redeploy admin + reminders.
- Entire CRM (including B.1 case SoR) returns to Dynamo.
- PG-only writes since cutover do not appear in Dynamo; warn operators.
- Do not backfill Dynamo→PG while flag is `postgres` except a deliberate
  re-cutover procedure.

### Prod

Separate runbook after staging soak. Not part of this design’s day-one
cutover.

---

## 7. Testing

- PGlite migration tests for new tables / constraints.
- Per-domain tests: `crmStore=dynamo` unchanged; postgres round-trip;
  corrupt-row naming.
- A: filters and empty Dynamo after PG-only case writes (from B.1 store).
- B: reserve → complete → conflict / repair semantics.
- C–E: list/write/resolve + unreadable ids.
- Backfill: idempotent; exit non-zero if any unreadable list non-empty.
- Keep existing Dynamo-default suites green.

---

## 8. File map (indicative)

| Area | Location |
|---|---|
| Migration | `services/api/src/db/migrations/004_…`, `migrate.ts` |
| Lists / counts | `domain/crm/cases.ts` (+ postgres helper as needed) |
| Ref reservation | `domain/crm/caseRefIndex.ts` + postgres |
| Review | `domain/crm/reviewQueue.ts` + postgres |
| Proposals | `agent/approval.ts` + postgres |
| Memory / prefs | `domain/crm/memory.ts`, `agent/prefs.ts` + postgres |
| Status email | `domain/crm/statusEmailTemplates.ts` + postgres |
| Backfill | `services/migration/src/backfillCrmRemainingToPostgres*.ts` |
| Runbook | [`2026-10-01-supabase-phase-b2-staging-runbook.md`](2026-10-01-supabase-phase-b2-staging-runbook.md) |
| Worktree | `.worktrees/supabase-crm-remaining` |

Implementation detail and task checkboxes live in the Phase B.2 **plan**
(writing-plans after this spec is approved).

---

## 9. Success criteria

1. Staging: with `CRM_STORE=postgres`, agent list/count tools reflect PG cases
   without Dynamo GSI dependence.
2. Review, proposals, memory, prefs, status-email R/W work on Postgres;
   Dynamo case partitions / review / proposal items not required for those
   flows.
3. Import reservation works on Postgres with B.1-equivalent semantics.
4. Backfill gate clean; rollback path documented and operable.
5. No Phase C/D scope creep in the B.2 plan.

---

## 10. Approval

Approve this design to unlock
`docs/superpowers/plans/2026-10-01-supabase-postgres-phase-b2.md`.

**Owner sign-off:** _pending_
