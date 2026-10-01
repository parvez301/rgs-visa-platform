# Supabase Postgres Phase B — CRM writes (case SoR)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Postgres (`rgs_staging` / later `rgs_prod`) the system of record for CRM **case reads and writes** (create, update, status/custody/outcome/billing, applicants, events) so the desk no longer depends on Dynamo or re-backfill for freshness; keep SES/S3/Cognito on AWS.

**Architecture:** Expand the Phase A schema with applicants + events (+ travellers/partners fields needed for case flows). Introduce a `CaseRepository` (Postgres + Dynamo adapters) behind `readCase` / `writeCase`. Gate with `CRM_STORE=postgres|dynamo` (default `dynamo`). When `CRM_STORE=postgres`, case mutators and `getCase` use SQL transactions; ledger stays on `LEDGER_STORE` (already `postgres` on staging). No long dual-write — staging cutover after backfill of new tables + smoke.

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, PGlite tests, existing Lambda/CDK, Cognito/SES/S3 unchanged.

**Spec:** `docs/superpowers/specs/2026-10-01-supabase-postgres-migration-design.md` (Phase B)

## Scope split (binding)

| This plan (B.1) | Deferred to Phase B.2 (separate plan) |
|---|---|
| `crm_cases` full body, `crm_applicants`, `crm_events` | Review queue / proposals |
| Partners + travellers needed for create/get/edit case | Agent memory / user prefs |
| Ref claims in Postgres | Status-email template admin writes (reads may stay Dynamo short-term) |
| `CRM_STORE` flag + staging cutover runbook | Country product / checklist CRM leftovers |
| Document checklist on case (if stamped on create) | Visa-platform (Phase C) |

If a task would require B.2 entities to compile, stub with “still Dynamo” behind an explicit `context.table` call and a code comment `// Phase B.2`.

## Global Constraints

- Spec decisions 1–8 closed (Supabase Postgres + pooler; Cognito/S3/SES stay; phased; no big-bang Dynamo drop).
- Staging first on project `private_ventures` database **`rgs_staging`**; do not touch `rgs_prod` until a later cutover.
- Lambdas use transaction pooler (`:6543`) for app traffic; migrations/DDL may use session pooler (`:5432`).
- Descriptive names; match CRM comment density; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-crm-writes`.
- Do not deploy prod / pause HireLoop projects / delete Supabase resources unless asked.
- When `CRM_STORE=postgres`, a case write must update ledger projection columns on `crm_cases` in the **same transaction** as applicants (no stale ledger after status change).
- Rollback: set `CRM_STORE=dynamo` (and keep `LEDGER_STORE=postgres` only if a fresh backfill ran — document that ledger will lag writes again).

## Review Focus

1. **`CRM_STORE` unset / `dynamo`** — all case paths unchanged (Dynamo `caseStore`); pinned Task 3+.
2. **`CRM_STORE=postgres` without `DATABASE_URL`** — loud fail at startup (same pattern as ledger); pinned Task 3.
3. **Create case then ledger list** — new case appears without re-backfill; pinned Task 5–6 + staging runbook.
4. **Status change** — META + event + ledger columns atomic; no half-written applicants; pinned Task 5.
5. **Shrinking applicants** — ghost rows deleted (parity with Dynamo `writeCase`); pinned Task 4–5.
6. **Ref claim conflict** — 409 when REF taken; pinned Task 7.

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Flag name: **`CRM_STORE`** (`dynamo` \| `postgres`), separate from `LEDGER_STORE` so ledger can stay on PG while writes cut over. |
| D2 | No dual-write. Staging: backfill new tables → flip `CRM_STORE=postgres` → smoke. |
| D3 | `readCase` / `writeCase` become the only storage seam for case body (callers already use them). |
| D4 | Applicants live in table `crm_applicants` (`tenant_id`, `case_id`, `applicant_index`, columns + jsonb for sparse fields). |
| D5 | Events in `crm_events`; `listCaseEvents` / `recordCrmEvent` branch on `CRM_STORE`. |
| D6 | Pooler: one connection (`max: 1`) + explicit `BEGIN`/`COMMIT` for multi-statement case writes. |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/db/migrations/002_crm_case_sor.ts` | Expand cases; applicants; events; travellers; ref_claims |
| `services/api/src/domain/crm/caseStorePostgres.ts` | `readCase` / `writeCase` SQL |
| `services/api/src/domain/crm/caseStore.ts` | Dispatch Dynamo vs Postgres |
| `services/api/src/domain/crm/crmEvents.ts` | Event SQL path |
| `services/api/src/domain/crm/partners.ts` / `travellers.ts` / `refClaims.ts` | Postgres paths when `CRM_STORE=postgres` |
| `services/api/src/lib/sql.ts` / `context.ts` / `handler.ts` | `crmStoreFromEnvironment` |
| `infra/lib/rgs-platform-stack.ts` | `CRM_STORE` on admin Lambda only |
| `services/migration/src/backfillCrmCaseSorToPostgres.ts` | Backfill applicants/events/travellers/ref claims |
| `docs/superpowers/specs/2026-10-01-supabase-phase-b-staging-runbook.md` | Cutover steps |

---

### Task 1: Migration `002_crm_case_sor`

**Files:**
- Create: `services/api/src/db/migrations/002_crm_case_sor.ts` (export `MIGRATION_FILENAME`, `MIGRATION_SQL`)
- Modify: `services/api/src/db/migrate.ts` — register 002 after 001
- Test: `services/api/test/migrateCrmCaseSor.test.ts` (PGlite)

**Interfaces:**
- Produces tables (indicative DDL — implement exactly in the migration file):

```sql
-- widen crm_cases with nullable columns for full META (line_items jsonb, remarks, client_email,
-- submission_date, entry_type, processing, created_at, created_by_email, etc.)
-- crm_applicants (tenant_id, case_id, applicant_index, applicant_ref, traveller_id, ... PK)
-- crm_events (tenant_id, event_id, case_id, event_type, actor_email, meta jsonb, created_at)
-- crm_travellers (tenant_id, traveller_id, ... unique passport per tenant)
-- crm_ref_claims (tenant_id, ref_key, ref_value, case_id, claimed_at) PK (tenant_id, ref_key)
```

- [ ] **Step 1: Failing PGlite test** — apply 001+002; assert new tables exist; `crm_cases` has `client_email` (or chosen column) and `line_items`.

- [ ] **Step 2: Implement migration + register in `applyMigrations` list.**

- [ ] **Step 3: Tests pass.**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): add CRM case SoR Postgres migration 002

EOF
)"
```

---

### Task 2: `crmStoreFromEnvironment` + context

**Files:**
- Modify: `services/api/src/lib/sql.ts` (or `crmStore.ts`) — `CrmStore`, `crmStoreFromEnvironment`
- Modify: `services/api/src/lib/context.ts` — `crmStore?: CrmStore`
- Modify: `services/api/src/http/handler.ts` — set from env; if `CRM_STORE=postgres` require `DATABASE_URL`
- Modify: `infra/lib/rgs-platform-stack.ts` — `adminApiFunction.addEnvironment("CRM_STORE", process.env.RGS_CRM_STORE ?? "dynamo")`
- Test: `services/api/test/crmStore.test.ts`

**Interfaces:**
```ts
export type CrmStore = "dynamo" | "postgres";
export function crmStoreFromEnvironment(env: NodeJS.ProcessEnv): CrmStore;
```

- [ ] **Step 1: Failing tests** — default dynamo; accept postgres; reject garbage; handler throws if postgres without URL.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Tests pass + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): add CRM_STORE flag for Postgres case SoR

EOF
)"
```

---

### Task 3: Postgres `readCase` / `writeCase`

**Files:**
- Create: `services/api/src/domain/crm/caseStorePostgres.ts`
- Modify: `services/api/src/domain/crm/caseStore.ts` — branch on `context.crmStore === "postgres"` (require `context.sql`)
- Test: `services/api/test/crm/caseStorePostgres.test.ts` (PGlite: write → read round-trip; shrink applicants; searchText/applicantSummary recomputed)

**Interfaces:**
```ts
export async function writeCasePostgres(sql: SqlClient, crmCase: crm.CrmCase): Promise<void>;
export async function readCasePostgres(sql: SqlClient, tenantId: string, caseId: string): Promise<crm.CrmCase | undefined>;
```

- [ ] **Step 1: Failing tests** for round-trip and ghost-applicant cleanup.

- [ ] **Step 2: Implement transactional write** (BEGIN; upsert case; delete applicants with index >= n; upsert applicants 0..n-1; COMMIT). Map snake_case ↔ `CrmCase` / applicants via Zod parse.

- [ ] **Step 3: Wire `caseStore.ts` dispatch.** Dynamo path untouched when store=dynamo.

- [ ] **Step 4: Tests pass + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): read/write CRM cases in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 4: Events on Postgres

**Files:**
- Modify: `services/api/src/domain/crm/crmEvents.ts`
- Test: `services/api/test/crm/crmEventsPostgres.test.ts`

**Interfaces:** `recordCrmEvent` / `listCaseEvents` branch on `crmStore`.

- [ ] **Step 1: Failing test** — record + list ordered by created_at.

- [ ] **Step 2: Implement insert/select.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store CRM case events in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 5: Domain mutators smoke under `CRM_STORE=postgres`

**Files:**
- Modify tests only unless gaps found: `services/api/test/crm/cases.test.ts` (or new `casesPostgres.test.ts`) using PGlite + `crmStore: "postgres"`
- Cover: `createCase`, `changeCaseStatus`, `updateCaseDetails`, `changeBillingStatus`, applicant add/update/remove if they call `writeCase`

- [ ] **Step 1: Failing integration tests** with in-memory/PGlite sql + empty Dynamo (prove no Dynamo dependency).

- [ ] **Step 2: Fix any caller that bypasses `writeCase` / `readCase`.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(api): cover CRM case mutators against Postgres case store

EOF
)"
```

---

### Task 6: Partners, travellers, ref claims (Postgres)

**Files:**
- Modify: `partners.ts`, `travellers.ts`, `refClaims.ts`
- Test: PGlite tests for upsert partner, upsert traveller, claim/release ref

- [ ] **Step 1: Failing tests** — passport uniqueness; ref claim 409.

- [ ] **Step 2: Implement SQL paths when `crmStore=postgres`.**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): partners, travellers, and ref claims on Postgres CRM store

EOF
)"
```

---

### Task 7: Backfill SoR tables from Dynamo

**Files:**
- Create: `services/migration/src/backfillCrmCaseSorToPostgres.ts` + CLI
- Script in `services/migration/package.json`: `backfill:crm-case-sor-postgres`
- Test: InMemoryTableClient + PGlite — one case with 2 applicants + 1 event round-trips; idempotent re-run

- [ ] **Step 1: Failing test.**

- [ ] **Step 2: Implement** — for each case META: `readCase` from Dynamo → `writeCasePostgres`; copy events; upsert travellers/partners/ref claims as found. Name unreadable ids. Apply migrations first.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): backfill CRM case SoR tables into Postgres

EOF
)"
```

---

### Task 8: Staging runbook + cutover notes

**Files:**
- Create: `docs/superpowers/specs/2026-10-01-supabase-phase-b-staging-runbook.md`

Checklist must include:
1. Apply 002 on `rgs_staging` (session URL).
2. Run `backfill:crm-case-sor-postgres` against staging Dynamo + `rgs_staging`.
3. Count parity: cases, applicants, events vs Dynamo.
4. Deploy with `RGS_CRM_STORE=postgres` (keep `RGS_LEDGER_STORE=postgres`, `RGS_DATABASE_URL` unchanged).
5. Smoke: create case → appears on ledger **without** re-backfill; status walk; export; notify emails optional.
6. Rollback: `RGS_CRM_STORE=dynamo`; warn ledger stale until backfill if writes happened on PG-only.

- [ ] **Step 1: Write runbook.**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase B staging cutover runbook

EOF
)"
```

---

## Out of this plan

- Review queue, proposals, agent memory (Phase B.2)
- `rgs_prod` cutover
- Dropping Dynamo / Phase C–D
- Changing admin UI beyond what already works with live data

## Spec coverage

| Spec Phase B ask | Task |
|---|---|
| Case create/update/status in Postgres | 3, 5 |
| Partners / travellers | 6 |
| Events / audit | 4 |
| Staging then smoke | 8 |
| Rollback story | 8 |
| Pooler / admin-only env | 2 |

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-01-supabase-postgres-phase-b.md`.

Please review. Which execution approach?

- **Subagent-driven** (recommended) — fresh agent per task + review; safer for `caseStore` seam
- **Native** — implement in this session end-to-end

**Recommend Subagent-driven** — write path touches storage + many mutators; interface mistakes are expensive. Does the plan capture what you want (B.1 only; B.2 deferred), and which approach?
