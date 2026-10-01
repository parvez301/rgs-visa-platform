# Supabase Postgres Phase B.2 — Remaining CRM SoR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under existing `CRM_STORE=postgres`, move remaining CRM surfaces (case lists/counts, caseRef reservations, review queue, proposals, memory, prefs, status-email templates) onto Postgres so desk and agent no longer need Dynamo for CRM correctness.

**Architecture:** One migration (`004_crm_remaining_sor`) adds the new tables. Domain entry points branch via `crmPostgresOf(context)` the same way B.1 case/partner paths do. No new env flags. Staging already has `CRM_STORE=postgres` — ship order is migrate → backfill new tables → deploy B.2 code. No dual-write. Country checklist Dynamo leftovers stay dead (live path is `CountryProduct.requiredDocuments`; Phase C owns catalog).

**Tech Stack:** TypeScript, pnpm, Vitest, Zod, `pg`, PGlite, existing Lambda/CDK, Cognito/SES/S3 unchanged.

**Spec:** `docs/superpowers/specs/2026-10-01-supabase-postgres-phase-b2-design.md`

## Global Constraints

- Spec decisions 1–7 closed (gate on `CRM_STORE`; no dual-write; staging `rgs_staging` first; reservations ≠ `crm_ref_claims`; status-email R+W on PG; checklist not a new SoR table).
- Parent migration design decisions 1–8 still apply (Supabase pooler; Cognito/S3/SES stay; phased).
- Lambdas: transaction pooler `:6543`; DDL / long backfill: session `:5432` (retry on `EADDRNOTAVAIL` as in B.1).
- Descriptive names; CRM comment density; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-crm-remaining`.
- Do not deploy prod / delete Dynamo / re-run B.1 SoR or ledger backfills after B.2 readers are live.
- When `CRM_STORE=postgres`, never fall back to Dynamo for a B.2 surface — fail if `sql` missing (`crmPostgresOf` / `postgresClientFor`).
- Rollback: `RGS_CRM_STORE=dynamo` + redeploy admin (+ reminders). PG-only writes disappear from desk view.

## Review Focus

1. **`CRM_STORE` unset / `dynamo`** — every B.2 surface still uses Dynamo exactly as today; pinned Tasks 2–8.
2. **`CRM_STORE=postgres` without `sql`** — loud fail, never silent Dynamo; pinned Tasks 2–8.
3. **Agent list after PG-only create** — `listCasesByStatus` / `ByPartner` / `countCasesByField` see the new case without Dynamo META; pinned Task 2.
4. **Reservation vs ref claim** — `crm_case_ref_reservations` does not collide with `crm_ref_claims`; import reserve/complete still works; pinned Task 3.
5. **Corrupt row naming** — unreadable review/proposal/memory rows named, not dropped; pinned Tasks 4–6.
6. **Empty new tables before backfill** — do not deploy B.2 postgres readers against empty tables on staging; pinned Tasks 9–10 (runbook).

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Reuse **`CRM_STORE`**; no per-domain flags. |
| D2 | Migration filename **`004_crm_remaining_sor.sql`**. |
| D3 | Lists/counts query **`crm_cases`** (and join `crm_partners` only if a caller needs canonical name — default return shape stays `CrmCase` via `readCase` / `readCasesPostgres` as appropriate). |
| D4 | `listCasesByStatus` / `ByPartner` under PG: SQL filter on `case_status` / `partner_id`, then assemble full cases (reuse `readCasesPostgres` batch read where possible). |
| D5 | `countCasesByField` under PG: `GROUP BY` on the column; uncounted = rows with null/empty group key. |
| D6 | `listCaseRefsByStatus` under PG: select `case_id, case_ref` from `crm_cases` where status matches (importer needs this without full reassembly). |
| D7 | Proposals store `input` + `summary` as **jsonb**; status column for list-by-status. |
| D8 | Backfill CLI name: `backfill:crm-remaining-postgres`. |

## File map

| File | Responsibility |
|------|----------------|
| `services/api/src/db/migrations/004_crm_remaining_sor.ts` | New tables |
| `services/api/src/db/migrate.ts` | Register 004 |
| `services/api/src/domain/crm/cases.ts` | Dispatch lists/counts/refs-by-status |
| `services/api/src/domain/crm/casesListPostgres.ts` | SQL for A |
| `services/api/src/domain/crm/caseRefIndex.ts` | Dispatch reservation |
| `services/api/src/domain/crm/caseRefIndexPostgres.ts` | SQL for B |
| `services/api/src/domain/crm/reviewQueue.ts` | Dispatch |
| `services/api/src/domain/crm/reviewQueuePostgres.ts` | SQL for C review |
| `services/api/src/agent/approval.ts` | Dispatch proposals |
| `services/api/src/domain/crm/proposalsPostgres.ts` | SQL for C proposals |
| `services/api/src/domain/crm/memory.ts` | Dispatch |
| `services/api/src/domain/crm/memoryPostgres.ts` | SQL for D memory |
| `services/api/src/agent/prefs.ts` | Dispatch |
| `services/api/src/domain/crm/prefsPostgres.ts` | SQL for D prefs |
| `services/api/src/domain/crm/statusEmailTemplates.ts` | Dispatch |
| `services/api/src/domain/crm/statusEmailTemplatesPostgres.ts` | SQL for E |
| `services/migration/src/backfillCrmRemainingToPostgres.ts` | Backfill |
| `services/migration/src/backfillCrmRemainingToPostgresCli.ts` | CLI |
| `docs/superpowers/specs/2026-10-01-supabase-phase-b2-staging-runbook.md` | Cutover |

---

### Task 1: Migration `004_crm_remaining_sor`

**Files:**
- Create: `services/api/src/db/migrations/004_crm_remaining_sor.ts`
- Modify: `services/api/src/db/migrate.ts` — register after 003
- Test: `services/api/test/migrateCrmRemainingSor.test.ts`

**Interfaces:**
- Produces (implement exactly in `MIGRATION_SQL`; no semicolons inside comments — `applyMigrations` splits on `;`):

```sql
-- crm_case_ref_reservations (tenant_id, case_ref PK, case_id, reserved_at, completed_at nullable)
-- crm_review_items (tenant_id, review_item_id PK, review_status, reason, case_ref, field_name,
--   raw_value, proposed_value, confidence, detail, source_sheet, source_row, created_at, ...)
-- crm_proposals (tenant_id, proposal_id PK, status, tool_name, input jsonb, summary jsonb,
--   case_id, proposed_by, proposed_at, decided_by, decided_at, discard_reason)
-- crm_memories (tenant_id, scope, memory_key PK(tenant,scope,memory_key), text, source_case_id,
--   created_by, created_at, created_by_email)
-- crm_user_prefs (tenant_id, email PK, trust_level, auto_apply_opt_in, default_filters jsonb,
--   confirmed_without_edit_count)
-- crm_status_email_templates (tenant_id, case_status PK, subject, body, enabled, updated_at, updated_by)
-- indexes: review_items (tenant_id, review_status); proposals (tenant_id, status);
--   memories (tenant_id, scope)
```

- [ ] **Step 1: Failing PGlite test** — apply 001–004; assert each new table exists; assert PK on `crm_case_ref_reservations (tenant_id, case_ref)`.

```ts
it("creates remaining CRM SoR tables", async () => {
  const sql = pgliteAsSqlClient(new PGlite());
  await applyMigrations(sql);
  const tables = await sql.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname='public' and tablename like 'crm_%' order by 1`,
  );
  expect(tables.rows.map((r) => r.tablename)).toEqual(
    expect.arrayContaining([
      "crm_case_ref_reservations",
      "crm_review_items",
      "crm_proposals",
      "crm_memories",
      "crm_user_prefs",
      "crm_status_email_templates",
    ]),
  );
});
```

- [ ] **Step 2: Run test — expect FAIL** (004 not registered).

Run: `pnpm --filter @rgs/api exec vitest run test/migrateCrmRemainingSor.test.ts`

- [ ] **Step 3: Implement migration + register in `MIGRATIONS`.**

- [ ] **Step 4: Tests pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): add CRM remaining SoR Postgres migration 004

EOF
)"
```

---

### Task 2: Case lists / counts / refs-by-status on Postgres

**Files:**
- Create: `services/api/src/domain/crm/casesListPostgres.ts`
- Modify: `services/api/src/domain/crm/cases.ts` — branch `listCasesByStatus`, `listCasesByPartner`, `countCasesByField`, `listCaseRefsByStatus`
- Test: `services/api/test/crm/casesListPostgres.test.ts`

**Interfaces:**
- Consumes: `crmPostgresOf`, `readCasesPostgres` (from B.1 `caseStorePostgres.ts`), `CrmCase` / `CaseListing` / `CaseCountByField` / `CaseRefListing`
- Produces:

```ts
export async function listCaseIdsByStatusPostgres(
  sql: SqlClient, tenantId: string, caseStatus: crm.CaseStatus, limit: number,
): Promise<string[]>;

export async function listCaseIdsByPartnerPostgres(
  sql: SqlClient, tenantId: string, partnerId: string, limit: number,
): Promise<string[]>;

export async function countCasesByFieldPostgres(
  sql: SqlClient, tenantId: string, groupByField: CaseCountGroupByField,
): Promise<CaseCountByField>;

export async function listCaseRefsByStatusPostgres(
  sql: SqlClient, tenantId: string, caseStatus: crm.CaseStatus, limit?: number,
): Promise<CaseRefListing>;
```

- Dispatch pattern in `cases.ts`:

```ts
const sql = crmPostgresOf(context);
if (sql !== undefined) {
  const caseIds = await listCaseIdsByStatusPostgres(sql, tenantId, caseStatus, limit);
  const { cases, unreadableCaseIds } = await readCasesPostgres(sql, tenantId, caseIds);
  // preserve request order of caseIds; missing → unreadable or absent per B.1 export rules
  return { cases: ordered, unreadableCaseIds };
}
// existing Dynamo path
```

- [ ] **Step 1: Failing tests** — seed PG cases via `writeCase` / createCase with `crmStore: "postgres"`; assert `listCasesByStatus` returns them with Dynamo table empty for those case PKs; assert `countCasesByField(..., "caseStatus")` totals match; assert dynamo-only context still uses GSI path.

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/casesListPostgres.test.ts`

- [ ] **Step 3: Implement SQL + dispatch.**

- [ ] **Step 4: Tests pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): list and count CRM cases from Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 3: Case ref reservations on Postgres

**Files:**
- Create: `services/api/src/domain/crm/caseRefIndexPostgres.ts`
- Modify: `services/api/src/domain/crm/caseRefIndex.ts` — dispatch `readCaseRefReservation`, `reserveCaseRef`, `completeCaseRefReservation`
- Test: `services/api/test/crm/caseRefIndexPostgres.test.ts`

**Interfaces:**
- Consumes: `CaseRefReservation` type from `caseRefIndex.ts` (export if needed)
- Produces:

```ts
export async function readCaseRefReservationPostgres(
  sql: SqlClient, tenantId: string, caseRef: string,
): Promise<CaseRefReservation | undefined>;

export async function writeCaseRefReservationPostgres(
  sql: SqlClient, reservation: CaseRefReservation,
): Promise<void>;
```

- Upsert on `(tenant_id, case_ref)`. Preserve B.1/import semantics: reserve before case write; complete after.

- [ ] **Step 1: Failing tests** — reserve → read → complete on PG; Dynamo partition for that ref empty; dynamo context still puts to table.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement + dispatch.**

- [ ] **Step 4: Tests pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store case ref reservations in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 4: Review queue on Postgres

**Files:**
- Create: `services/api/src/domain/crm/reviewQueuePostgres.ts`
- Modify: `services/api/src/domain/crm/reviewQueue.ts` — dispatch record/list/get/resolve (every `context.table` path used for review items)
- Test: `services/api/test/crm/reviewQueuePostgres.test.ts`

**Interfaces:**
- Round-trip `crm.ReviewItem` / `crm.ReviewItemSchema` columns (see `packages/shared/src/crm/reviewItem.ts`).
- List by `review_status` with `hasMore` / limit parity to current GSI page behaviour.
- Corrupt rows → `unreadableReviewItemIds`.

```ts
export async function insertReviewItemPostgres(sql: SqlClient, item: crm.ReviewItem): Promise<void>;
export async function listReviewItemsPostgres(
  sql: SqlClient, tenantId: string, reviewStatus: crm.ReviewStatus, limit: number,
): Promise<{ reviewItems: crm.ReviewItem[]; unreadableReviewItemIds: string[]; hasMore: boolean }>;
```

- [ ] **Step 1: Failing tests** — record OPEN item on PG; list finds it; resolve updates status; Dynamo review PK empty; unreadable named.

- [ ] **Step 2–4: Implement, pass, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store CRM review queue in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 5: Proposals on Postgres

**Files:**
- Create: `services/api/src/domain/crm/proposalsPostgres.ts`
- Modify: `services/api/src/agent/approval.ts` — dispatch `stageProposal`, list/get/update status storage helpers (every proposal `context.table` put/get/queryGsi)
- Test: `services/api/test/crm/proposalsPostgres.test.ts`

**Interfaces:**
- Persist `ProposedChange` with `input`/`summary` as jsonb; PK `(tenant_id, proposal_id)`.

```ts
export async function upsertProposalPostgres(
  sql: SqlClient, tenantId: string, proposal: ProposedChange,
): Promise<void>;
export async function getProposalPostgres(
  sql: SqlClient, tenantId: string, proposalId: string,
): Promise<ProposedChange | undefined>;
export async function listProposalsByStatusPostgres(
  sql: SqlClient, tenantId: string, status: ProposedChange["status"], limit: number,
): Promise<{ proposals: ProposedChange[]; unreadableProposalIds: string[] }>;
```

- [ ] **Step 1: Failing tests** — stage PENDING; list pending; approve/discard persistence; Dynamo proposal PK empty under postgres context.

- [ ] **Step 2–4: Implement, pass, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store agent proposals in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 6: CRM memory on Postgres

**Files:**
- Create: `services/api/src/domain/crm/memoryPostgres.ts`
- Modify: `services/api/src/domain/crm/memory.ts` — dispatch remember/recall/forget
- Test: `services/api/test/crm/memoryPostgres.test.ts`

**Interfaces:**
- Match `crm.CrmMemorySchema` (`tenantId`, `scope`, `memoryKey`, `text`, …).
- PK `(tenant_id, scope, memory_key)`.

```ts
export async function upsertMemoryPostgres(sql: SqlClient, memory: crm.CrmMemory): Promise<void>;
export async function listMemoriesByScopePostgres(
  sql: SqlClient, tenantId: string, scope: string, limit: number,
): Promise<{ memories: crm.CrmMemory[]; unreadableMemoryKeys: string[] }>;
export async function deleteMemoryPostgres(
  sql: SqlClient, tenantId: string, scope: string, memoryKey: string,
): Promise<boolean>;
```

- [ ] **Step 1: Failing tests** — remember ORG memory; recall; forget; agent memory still requires `sourceCaseId`; Dynamo memory partition empty.

- [ ] **Step 2–4: Implement, pass, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store CRM agent memory in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 7: User prefs on Postgres

**Files:**
- Create: `services/api/src/domain/crm/prefsPostgres.ts`
- Modify: `services/api/src/agent/prefs.ts` — dispatch read/set/recordConfirmedWithoutEdit storage
- Test: `services/api/test/crm/prefsPostgres.test.ts`

**Interfaces:**
- Match `crm.CrmUserPrefsSchema`. PK `(tenant_id, email)`.
- `default_filters` jsonb.

```ts
export async function readUserPrefsPostgres(
  sql: SqlClient, tenantId: string, email: string,
): Promise<crm.CrmUserPrefs | undefined>;
export async function writeUserPrefsPostgres(sql: SqlClient, prefs: crm.CrmUserPrefs): Promise<void>;
```

- [ ] **Step 1: Failing tests** — write prefs; read back; confirmedWithoutEditCount increment path; Dynamo prefs item absent under postgres.

- [ ] **Step 2–4: Implement, pass, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store CRM user prefs in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 8: Status-email templates on Postgres

**Files:**
- Create: `services/api/src/domain/crm/statusEmailTemplatesPostgres.ts`
- Modify: `services/api/src/domain/crm/statusEmailTemplates.ts` — dispatch get/list/upsert (reads **and** writes)
- Test: `services/api/test/crm/statusEmailTemplatesPostgres.test.ts`

**Interfaces:**
- Match `crm.StatusEmailTemplateSchema`. PK `(tenant_id, case_status)`.
- List still merges missing statuses with in-memory defaults (`UNSAVED_TEMPLATE_UPDATED_AT`) — same behaviour as today.

```ts
export async function getStatusEmailTemplatePostgres(
  sql: SqlClient, tenantId: string, caseStatus: crm.CaseStatus,
): Promise<crm.StatusEmailTemplate | undefined>;
export async function upsertStatusEmailTemplatePostgres(
  sql: SqlClient, template: crm.StatusEmailTemplate,
): Promise<void>;
```

- [ ] **Step 1: Failing tests** — upsert; get; list fills defaults for missing statuses; Dynamo template PK empty under postgres.

- [ ] **Step 2–4: Implement, pass, commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(api): store status email templates in Postgres when CRM_STORE=postgres

EOF
)"
```

---

### Task 9: Backfill remaining CRM → Postgres

**Files:**
- Create: `services/migration/src/backfillCrmRemainingToPostgres.ts`
- Create: `services/migration/src/backfillCrmRemainingToPostgresCli.ts`
- Modify: `services/migration/package.json` — script `backfill:crm-remaining-postgres`
- Test: `services/migration/test/backfillCrmRemainingToPostgres.test.ts`

**Interfaces:**
- Consumes: Dynamo `TableClient` + `SqlClient`; applies migrations first (like B.1 SoR backfill).
- Produces result counts + unreadable id lists; exit 1 if any unreadable non-empty.

```ts
export interface BackfillCrmRemainingResult {
  reservationsUpserted: number;
  reviewItemsUpserted: number;
  proposalsUpserted: number;
  memoriesUpserted: number;
  prefsUpserted: number;
  templatesUpserted: number;
  unreadableReservationIds: string[];
  unreadableReviewItemIds: string[];
  unreadableProposalIds: string[];
  unreadableMemoryKeys: string[];
  unreadablePrefsEmails: string[];
  unreadableTemplateStatuses: string[];
}

export async function backfillCrmRemainingToPostgres(args: {
  table: TableClient;
  sql: SqlClient;
  tenantId: string;
  onProgress?: (label: string, n: number) => void;
}): Promise<BackfillCrmRemainingResult>;
```

- Scan Dynamo partitions / GSIs the same way each domain lists today (review GSI1, proposal GSI1, memory per scope, prefs, templates, reservation items). Idempotent upserts.
- Do **not** set `CRM_STORE=postgres` in the CLI process for correctness messaging (reads Dynamo regardless).

- [ ] **Step 1: Failing tests** — seed Dynamo fixtures in PGlite+InMemory hybrid (same pattern as `backfillCrmCaseSorToPostgres.test.ts`); run backfill; assert row counts; second run idempotent; corrupt row named + exit gate.

- [ ] **Step 2–4: Implement CLI + package script; tests pass; commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): backfill remaining CRM tables into Postgres

EOF
)"
```

---

### Task 10: Staging runbook

**Files:**
- Create: `docs/superpowers/specs/2026-10-01-supabase-phase-b2-staging-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-01-supabase-postgres-phase-b2-design.md` — status → approved when plan lands (or leave status; update Related link)
- Modify: `docs/superpowers/specs/2026-10-01-supabase-phase-b-staging-runbook.md` — one-line pointer to B.2 runbook for remaining gaps

**Runbook must include:**
- Preconditions: B.1 live (`CRM_STORE=postgres`, `LEDGER_STORE=postgres`).
- Migrate 004 on session URL.
- `backfill:crm-remaining-postgres` gate (all unreadable = 0).
- Count parity checklist.
- Deploy (same `RGS_*` env; no flag flip).
- Smoke: agent list/count; review; proposal; memory; prefs; status-email; optional import reservation.
- Forbid re-running B.1 SoR/ledger backfills.
- Rollback = `RGS_CRM_STORE=dynamo` + redeploy.

- [ ] **Step 1: Write runbook.**
- [ ] **Step 2: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs: add Supabase Phase B.2 staging cutover runbook

EOF
)"
```

---

## Self-review (author)

| Spec requirement | Task |
|---|---|
| A lists/counts | 2 |
| B reservations | 3 |
| C review + proposals | 4, 5 |
| D memory + prefs | 6, 7 |
| E status-email R/W | 8 |
| Migration + backfill + runbook | 1, 9, 10 |
| Checklist not new SoR | Global / out of scope |
| Gate on CRM_STORE only | Global + Tasks 2–8 |
| Staging ship order | Task 10 + Review Focus 6 |
