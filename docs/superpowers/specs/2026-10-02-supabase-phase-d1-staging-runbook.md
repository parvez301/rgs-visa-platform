# Supabase Phase D.1 — staging defaults cutover runbook

**Date:** 2026-10-02  
**Scope:** CDK defaults: when `stage === "staging"` and `RGS_CRM_STORE` / `RGS_LEDGER_STORE` are unset, Lambdas get `CRM_STORE=postgres` (admin, user, reminders) and admin `LEDGER_STORE=postgres`. Explicit `RGS_*=dynamo` still works for rollback. Dynamo table and domain Dynamo branches remain.  
**Design:** `2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` · **Plan:** `docs/superpowers/plans/2026-10-02-supabase-postgres-phase-d1-staging-defaults.md`  
**Prerequisite:** Phase C.2.2 live on staging (`2026-10-02-supabase-phase-c2-2-staging-runbook.md`).

**Out of scope:** Removing `platformTable` / `TABLE_NAME` (D.2); deleting Dynamo domain code; prod default flip; prod cutover; re-running A–C.2.2 backfills.

**Staging target**

| Item | Value |
|---|---|
| Supabase org / project | `private_ventures` |
| Database | **`rgs_staging`** (not `rgs_prod`) |
| Project ref | `kblgpjwqqixkcnbdfzsn` |
| Region | **`ap-south-1`** |

> **No schema / backfill.** D.1 is CDK default + deploy only. Do **not** re-run any `backfill:*` script.  
> **`RGS_DATABASE_URL` still required.** Staging defaults set store flags to postgres; cold start still needs the transaction pooler URI (`:6543`). Unset URL + postgres store = loud fail, not Dynamo fallback.  
> **Rollback blast radius.** Flipping back to Dynamo shows only data that was on Dynamo; PG-only writes since A–C.2.2 cutovers are invisible. Prefer fix-forward.  
> **Supersedes prior runbooks:** on staging, "or unset → default dynamo" no longer holds — rollback must set `RGS_CRM_STORE=dynamo` (and ledger if needed) explicitly.

---

## Checklist

### 0. Preconditions

- [ ] C.2.2 live on staging (leads + notices on Postgres).
- [ ] D.1 code merged (staging defaults + infra tests green).
- [ ] `RGS_DATABASE_URL` ready (transaction pooler `:6543` for Lambda deploy env).

### 1. Deploy

Deploy `RgsPlatform-staging` with usual credentials. Optional: omit `RGS_CRM_STORE` / `RGS_LEDGER_STORE` to exercise defaults, **or** keep explicit `postgres` (redundant but fine).

```bash
# RGS_CRM_STORE / RGS_LEDGER_STORE intentionally unset to exercise D.1 defaults
RGS_DATABASE_URL='postgresql://…:6543/rgs_staging?pgbouncer=true' \
RGS_STAGE=staging \
  pnpm --filter @rgs/infra exec cdk deploy RgsPlatform-staging
```

- [ ] Deploy succeeded.

### 2. Verify Lambda env

Confirm on **admin API**, **user API**, and **appointment reminders**:

| Lambda | `DATABASE_URL` | `CRM_STORE` | `LEDGER_STORE` |
|---|---|---|---|
| `rgs-admin-api-staging` | pooler URI present | `postgres` | `postgres` |
| `rgs-user-api-staging` | pooler URI present | `postgres` | **absent** |
| `rgs-appointment-reminders-staging` | pooler URI present | `postgres` | **absent** |

```bash
aws lambda get-function-configuration \
  --function-name rgs-admin-api-staging \
  --query 'Environment.Variables.{CRM_STORE:CRM_STORE,LEDGER_STORE:LEDGER_STORE,DATABASE_URL:DATABASE_URL}'
# repeat for rgs-user-api-staging and rgs-appointment-reminders-staging
```

### 3. Smoke

- [ ] Admin API cold start (any authenticated admin GET that hits CRM).
- [ ] One CRM read/write (e.g. open a case / list cases).
- [ ] Portal: list applications or profile path that hit user API CRM.
- [ ] Public notices list + (optional) lead create still healthy.
- [ ] CloudWatch: no unexpected Dynamo-only errors on those paths.

### 4. Rollback (only if needed)

```bash
RGS_DATABASE_URL='…' \
RGS_CRM_STORE=dynamo \
RGS_LEDGER_STORE=dynamo \
  <redeploy admin + user + reminders / full RgsPlatform-staging>
```

- [ ] After rollback deploy: Lambda env shows `CRM_STORE=dynamo` (and ledger if set).
- [ ] Prefer fix-forward; Dynamo view will miss PG-only writes since prior cutovers.

### 5. Done → soak before D.2

- [ ] Record deploy time / git SHA.
- [ ] Leave Dynamo table in stack (D.2 removes CDK ownership later).
- [ ] Do not delete `rgs-platform-staging` table.
