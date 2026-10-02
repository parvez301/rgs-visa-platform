# RGS — Supabase Postgres Phase D (Dynamo decommission)

**Date:** 2026-10-02  
**Status:** draft (awaiting written-spec review)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md`  
**Prior:** Phase C.2.2 (`CRM_STORE=postgres` leads + notices) + staging cutover  

**Ships:** **D.1** (staging defaults / runbook) then **D.2** (remove table from staging CDK, retain orphan). Separate plans after this spec is approved.

---

## 1. Why

Staging product data is already on Postgres through Phases A–C.2.2
(`CRM_STORE=postgres`, `LEDGER_STORE=postgres`). Dynamo remains in the CDK
stack and is still the **default** when `RGS_CRM_STORE` / `RGS_LEDGER_STORE`
are unset (`?? "dynamo"`), so a bare staging deploy can accidentally fall
back to Dynamo. Parent Phase D also calls for removing production Dynamo
wiring eventually.

**Goal:** Decommission Dynamo as the staging SoR path in two ships — first
make Postgres the safe default and document rollback; then stop owning the
staging table in CDK without destroying it until operators delete it by hand.

**Non-goal (this design):** Deleting Dynamo domain branches; destroying the
staging table in CloudFormation; prod table delete; rewriting backfill CLIs
off Dynamo; migrating the in-memory Dynamo test harness to PGlite-only
(follow-up / D.3).

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | Two ships: **D.1** then **D.2** | One mega-ship; skip D.1 |
| 2 | D.1 keeps Dynamo domain branches + table so **flag-flip rollback** still works | Delete Dynamo branches in D.1 |
| 3 | D.1 content = staging CDK **defaults → postgres** when `RGS_*` unset | Always require explicit env; hard-refuse `dynamo` on staging |
| 4 | Prod defaults stay **`dynamo`** until prod runbooks | Flip prod defaults in D.1 |
| 5 | D.2 removes `platformTable` from **staging** CDK; **retain** orphan table (no CFN destroy) | CFN destroys table; leave table resource in stack unused |
| 6 | Prod stack / prod table untouched in D.1–D.2 | Prod decommission in same ships |
| 7 | Backfill CLIs may still read Dynamo (prod / historical) | Rewrite all CLIs to PG-only in D.1 |

---

## 3. Scope

### D.1 — In

| Area | Change |
|---|---|
| CDK | When `stage === "staging"`, default `CRM_STORE` and admin `LEDGER_STORE` to `postgres` if `RGS_*` unset; explicit `RGS_*=dynamo` still wins |
| Tests | Synth/env matrix: staging unset → postgres; staging explicit dynamo → dynamo; non-staging unset → dynamo |
| Ops | Staging D.1 runbook: verify Lambda env, smoke, rollback via `RGS_CRM_STORE=dynamo` (+ ledger if needed) + redeploy |

### D.1 — Out

- Removing Dynamo `else` branches in domain code.
- Dropping `platformTable` / `TABLE_NAME`.
- Prod default changes.
- PGlite-only test migration.

### D.2 — In

| Area | Change |
|---|---|
| CDK (staging) | Stop creating/owning `platformTable`; remove `TABLE_NAME` and Dynamo IAM grants from staging Lambdas; configure so CloudFormation **does not delete** the existing table (retain / orphan) |
| Tests | Staging template has no PlatformTable (or equivalent); staging Lambdas lack `TABLE_NAME`; prod template still has table |
| Ops | D.2 runbook: deploy; confirm no `TABLE_NAME`; record orphan table name; manual `delete-table` only after soak; rollback = prior artifact that still owned the table |

### D.2 — Out

- Automatic table destroy.
- Prod CDK / prod table.
- Deleting Dynamo domain code (still needed for prod + rollback artifact until prod D).

---

## 4. Architecture

### D.1 defaults

```
stage=staging, RGS_* unset     → CRM_STORE=postgres, LEDGER_STORE=postgres (admin)
stage=staging, RGS_*=dynamo    → dynamo (rollback / deliberate)
stage≠staging, RGS_* unset     → dynamo (prod unchanged)
RGS_* explicitly set           → always wins over stage defaults
```

- User API continues to receive `DATABASE_URL` + `CRM_STORE` (not `LEDGER_STORE`) as in C.2.1.
- Reminders continue to receive `DATABASE_URL` + `CRM_STORE` when set.
- `buildProductionContext` rules unchanged: `CRM_STORE=postgres` / `LEDGER_STORE=postgres` still require `DATABASE_URL`.

### D.2 table ownership

```
Before D.2: CDK owns platformTable → TABLE_NAME on Lambdas → Dynamo IAM
After D.2 (staging): CDK does not own table; Lambdas have no TABLE_NAME;
                     table remains in AWS until manual delete
```

- Staging API must already be fully on Postgres (C.2.2 live) before D.2 deploy.
- Domain Dynamo branches may remain in the codebase for prod builds; staging
  Lambdas simply never point at a table.

---

## 5. Cutover

### D.1 staging

1. Land CDK default change + tests.
2. Deploy `RgsPlatform-staging` with usual `RGS_DATABASE_URL` (and optional
   explicit `RGS_CRM_STORE=postgres` / `RGS_LEDGER_STORE=postgres` — redundant
   after defaults but fine).
3. Confirm Lambda env: admin/user/reminders `CRM_STORE=postgres` +
   `DATABASE_URL`; admin `LEDGER_STORE=postgres`; user has no `LEDGER_STORE`.
4. Smoke: cold start; one CRM read/write; portal list; public notices/leads.
5. Document rollback: set `RGS_CRM_STORE=dynamo` (and ledger if reverting that
   too) → redeploy admin + user + reminders.

### D.2 staging (after D.1 soak)

1. Confirm C.2.2 (and D.1) live; no planned Dynamo reads on staging.
2. Land CDK: staging without owned `platformTable`; retain orphan.
3. Deploy; confirm no `TABLE_NAME` on Lambdas; API healthy on PG.
4. Record orphan table name (`rgs-platform-staging` or current name).
5. Manual delete only after soak (out of band; not automatic).

**Ship order:** D.1 → soak → D.2. Do not skip D.1 if operators still rely on
unset-env deploys.

---

## 6. Rollback

| Ship | Rollback |
|---|---|
| D.1 | `RGS_CRM_STORE=dynamo` (optional `RGS_LEDGER_STORE=dynamo`) + redeploy. Table still in stack. PG-only writes since cutover invisible on Dynamo — same blast radius warning as C.2.x. Prefer fix-forward. |
| D.2 | Redeploy previous CDK artifact that still defines `platformTable` (orphan table still present). Do not re-run A–C.2.2 backfills against live PG. |

---

## 7. Testing

**D.1**

- Infra tests: staging default matrix (unset / explicit postgres / explicit dynamo).
- Non-staging unset remains dynamo.
- Existing admin-rbac CRM env wiring tests still pass.

**D.2**

- Staging synth: no owned PlatformTable (or RemovalPolicy/retain as designed);
  Lambdas lack `TABLE_NAME` / Dynamo data grants.
- Prod synth: table still present.
- No requirement to run live Dynamo integration in D.2 unit tests.

---

## 8. File map (indicative)

| Ship | Location |
|---|---|
| D.1 defaults | `infra/lib/rgs-platform-stack.ts` |
| D.1 tests | `infra/test/…` (extend `admin-rbac.test.ts` or add defaults test) |
| D.1 runbook | `docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md` |
| D.2 stack | `infra/lib/rgs-platform-stack.ts` (stage-gated table) |
| D.2 tests | `infra/test/…` |
| D.2 runbook | `docs/superpowers/specs/2026-10-02-supabase-phase-d2-staging-runbook.md` |

Implementation checkboxes live in separate **D.1** and **D.2** plans
(writing-plans after this written spec is approved — start with D.1).

---

## 9. Success criteria

1. Staging deploy with unset `RGS_CRM_STORE` / `RGS_LEDGER_STORE` yields
   postgres on the relevant Lambdas (D.1).
2. Explicit `dynamo` still works for staging rollback (D.1).
3. Prod defaults unchanged after D.1.
4. After D.2: staging Lambdas have no `TABLE_NAME`; Dynamo table still exists
   until manual delete.
5. No Dynamo domain-branch deletion and no prod table drop in D.1/D.2.

---

## 10. Approval

Approve this design to unlock the Phase **D.1** implementation plan
(`docs/superpowers/plans/2026-10-02-supabase-postgres-phase-d1-staging-defaults.md`).
D.2 plan follows after D.1 lands / soaks.

**Owner sign-off:** _pending_
