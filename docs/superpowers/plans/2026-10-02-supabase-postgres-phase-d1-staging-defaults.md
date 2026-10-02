# Supabase Postgres Phase D.1 — Staging Defaults → Postgres

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `stage === "staging"` and `RGS_CRM_STORE` / `RGS_LEDGER_STORE` are unset, CDK defaults Lambda env to `postgres` so a bare staging deploy cannot silently fall back to Dynamo; prod / non-staging defaults stay `dynamo`; explicit `RGS_*=dynamo` still wins for rollback.

**Architecture:** Small pure helper `resolveStoreEnv(envValue, stage)` in `rgs-platform-stack.ts`. Admin + user API always get `CRM_STORE` from that helper (`DATABASE_URL` wiring unchanged). Admin gets `LEDGER_STORE` from the same helper. Appointment reminders get `CRM_STORE` when `RGS_CRM_STORE` is set **or** when `stage === "staging"` (so staging unset → `postgres` on reminders too). Dynamo table, domain Dynamo branches, and prod defaults are untouched (D.2 / later).

**Tech Stack:** AWS CDK (`aws-cdk-lib`), Node.js `node:test` infra tests, existing `RgsPlatformStack`.

**Spec:** `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md`

## Global Constraints

- Spec decisions 1–7 closed (two ships; D.1 keeps Dynamo branches + table; staging CDK defaults → postgres; prod defaults stay dynamo; D.2 out of this plan; backfill CLIs may still read Dynamo).
- Parent migration design decisions 1–8 still apply.
- Do **not** remove `platformTable`, `TABLE_NAME`, Dynamo IAM grants, or domain Dynamo `else` branches in D.1.
- Do **not** change prod / non-staging unset defaults away from `dynamo`.
- Explicit non-empty `RGS_CRM_STORE` / `RGS_LEDGER_STORE` always wins over stage defaults.
- `buildProductionContext` unchanged: `CRM_STORE=postgres` / `LEDGER_STORE=postgres` still require `DATABASE_URL` (fail loud).
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-phase-d1-staging-defaults` off `main`.
- Do not deploy prod; do not delete Dynamo table; do not re-run A–C.2.2 backfills.

## Review Focus

1. **Staging + unset `RGS_CRM_STORE` / `RGS_LEDGER_STORE`** — admin/user `CRM_STORE=postgres`, admin `LEDGER_STORE=postgres`, reminders `CRM_STORE=postgres`; pinned Task 1.
2. **Staging + explicit `RGS_*=dynamo`** — all relevant Lambdas get `dynamo` (rollback path); pinned Task 1.
3. **Non-staging (`test` / `prod`) + unset** — admin/user still default `CRM_STORE=dynamo`, admin `LEDGER_STORE=dynamo`; reminders still omit `CRM_STORE` when unset (today’s behavior); pinned Task 1.
4. **User API never gets `LEDGER_STORE`** — still admin-only after defaults change; pinned Task 1 (existing assertion kept).
5. **Staging defaults without `RGS_DATABASE_URL`** — CDK still emits `CRM_STORE=postgres` with empty/missing `DATABASE_URL`; cold start fails loud (operator must set pooler URL) — documented Task 2 runbook, not a silent Dynamo fallback.

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Default helper: unset/`""` → `stage === "staging" ? "postgres" : "dynamo"`; any other non-empty string passes through unchanged. |
| D2 | Reminders: set `CRM_STORE` when `RGS_CRM_STORE` non-empty **or** `stage === "staging"` (staging unset → postgres). Non-staging unset still omits `CRM_STORE` on reminders. |
| D3 | `DATABASE_URL` wiring unchanged (admin/user always `RGS_DATABASE_URL ?? ""`; reminders only when `RGS_DATABASE_URL` set). |
| D4 | Tests live in `infra/test/admin-rbac.test.ts` (extend; no new test file required). |
| D5 | Runbook path: `docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md`. |

## File map

| File | Responsibility |
|------|----------------|
| `infra/lib/rgs-platform-stack.ts` | `resolveStoreEnv`; wire admin/user/reminders defaults |
| `infra/test/admin-rbac.test.ts` | Staging / non-staging / explicit dynamo matrix |
| `docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md` | Staging deploy verify + rollback |
| `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` | Mark D.1 unlocked / status after plan lands |

---

### Task 1: CDK staging store defaults + infra tests

**Files:**
- Modify: `infra/lib/rgs-platform-stack.ts` — add `resolveStoreEnv`; replace `?? "dynamo"` and reminders CRM conditional
- Modify: `infra/test/admin-rbac.test.ts` — staging matrix + keep existing CRM wiring tests green

**Interfaces — `resolveStoreEnv` (module-local, not exported):**

```ts
/** When RGS_* unset/empty: staging → postgres, else dynamo. Non-empty env always wins. */
function resolveStoreEnv(envValue: string | undefined, stage: string): string {
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }
  return stage === "staging" ? "postgres" : "dynamo";
}
```

- [ ] **Step 1: Write the failing tests**

In `infra/test/admin-rbac.test.ts`, add a helper that synthesizes with a chosen stage (do not break existing `synthesizedResources` which hardcodes `stage: "test"`):

```ts
function synthesizedResourcesForStage(
  stage: string,
): Record<string, Record<string, unknown>> {
  const app = new cdk.App();
  const stack = new RgsPlatformStack(app, `AdminRbacTest-${stage}`, {
    stage,
    env: { account: "111111111111", region: "ap-south-1" },
  });
  return Template.fromStack(stack).toJSON().Resources;
}

function lambdaEnvByName(
  resources: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    resourcesOfType(resources, "AWS::Lambda::Function")
      .filter((fn) => typeof (fn.Properties as { FunctionName?: unknown }).FunctionName === "string")
      .map((fn) => {
        const props = fn.Properties as {
          FunctionName: string;
          Environment?: { Variables?: Record<string, unknown> };
        };
        return [props.FunctionName, props.Environment?.Variables ?? {}];
      }),
  );
}
```

Add these cases (each restores `process.env` in `finally` like the existing CRM test):

```ts
it("defaults CRM_STORE and LEDGER_STORE to postgres on staging when RGS_* unset", () => {
  const saved = {
    url: process.env["RGS_DATABASE_URL"],
    crm: process.env["RGS_CRM_STORE"],
    ledger: process.env["RGS_LEDGER_STORE"],
  };
  delete process.env["RGS_DATABASE_URL"];
  delete process.env["RGS_CRM_STORE"];
  delete process.env["RGS_LEDGER_STORE"];
  try {
    const env = lambdaEnvByName(synthesizedResourcesForStage("staging"));
    assert.equal(env["rgs-admin-api-staging"]?.["CRM_STORE"], "postgres");
    assert.equal(env["rgs-admin-api-staging"]?.["LEDGER_STORE"], "postgres");
    assert.equal(env["rgs-user-api-staging"]?.["CRM_STORE"], "postgres");
    assert.equal(env["rgs-user-api-staging"]?.["LEDGER_STORE"], undefined);
    assert.equal(env["rgs-appointment-reminders-staging"]?.["CRM_STORE"], "postgres");
  } finally {
    if (saved.url === undefined) delete process.env["RGS_DATABASE_URL"];
    else process.env["RGS_DATABASE_URL"] = saved.url;
    if (saved.crm === undefined) delete process.env["RGS_CRM_STORE"];
    else process.env["RGS_CRM_STORE"] = saved.crm;
    if (saved.ledger === undefined) delete process.env["RGS_LEDGER_STORE"];
    else process.env["RGS_LEDGER_STORE"] = saved.ledger;
  }
});

it("honors explicit RGS_*=dynamo on staging (rollback path)", () => {
  const saved = {
    crm: process.env["RGS_CRM_STORE"],
    ledger: process.env["RGS_LEDGER_STORE"],
  };
  process.env["RGS_CRM_STORE"] = "dynamo";
  process.env["RGS_LEDGER_STORE"] = "dynamo";
  try {
    const env = lambdaEnvByName(synthesizedResourcesForStage("staging"));
    assert.equal(env["rgs-admin-api-staging"]?.["CRM_STORE"], "dynamo");
    assert.equal(env["rgs-admin-api-staging"]?.["LEDGER_STORE"], "dynamo");
    assert.equal(env["rgs-user-api-staging"]?.["CRM_STORE"], "dynamo");
    assert.equal(env["rgs-appointment-reminders-staging"]?.["CRM_STORE"], "dynamo");
  } finally {
    if (saved.crm === undefined) delete process.env["RGS_CRM_STORE"];
    else process.env["RGS_CRM_STORE"] = saved.crm;
    if (saved.ledger === undefined) delete process.env["RGS_LEDGER_STORE"];
    else process.env["RGS_LEDGER_STORE"] = saved.ledger;
  }
});

it("keeps non-staging unset defaults on dynamo", () => {
  const saved = {
    crm: process.env["RGS_CRM_STORE"],
    ledger: process.env["RGS_LEDGER_STORE"],
  };
  delete process.env["RGS_CRM_STORE"];
  delete process.env["RGS_LEDGER_STORE"];
  try {
    const env = lambdaEnvByName(synthesizedResourcesForStage("prod"));
    assert.equal(env["rgs-admin-api-prod"]?.["CRM_STORE"], "dynamo");
    assert.equal(env["rgs-admin-api-prod"]?.["LEDGER_STORE"], "dynamo");
    assert.equal(env["rgs-user-api-prod"]?.["CRM_STORE"], "dynamo");
    // Reminders still omit CRM_STORE when unset on non-staging (pre-D.1 behavior).
    assert.equal(env["rgs-appointment-reminders-prod"]?.["CRM_STORE"], undefined);
  } finally {
    if (saved.crm === undefined) delete process.env["RGS_CRM_STORE"];
    else process.env["RGS_CRM_STORE"] = saved.crm;
    if (saved.ledger === undefined) delete process.env["RGS_LEDGER_STORE"];
    else process.env["RGS_LEDGER_STORE"] = saved.ledger;
  }
});
```

Keep the existing tests:
- `"gives CRM database config to admin, user API, and reminders Lambdas…"` (explicit postgres + URL)
- `"leaves appointment reminders on Dynamo when no CRM Postgres config is set"` (`stage: "test"`, unset → reminders omit `CRM_STORE` / `DATABASE_URL`)

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd infra && node --import tsx --test test/admin-rbac.test.ts
```

Expected: FAIL — staging unset still yields `CRM_STORE=dynamo` (or reminders omit `CRM_STORE` on staging) because `?? "dynamo"` / reminders conditional not updated yet.

- [ ] **Step 3: Implement `resolveStoreEnv` and wire it**

Near the top of `RgsPlatformStack` constructor (after `const { stage } = props;`), or immediately before the CRM env loop, add `resolveStoreEnv` as a file-level function (outside the class is fine and preferred).

Replace the admin/user CRM block and ledger line. **Before (today):**

```ts
for (const crmFunction of [adminApiFunction, userApiFunction]) {
  crmFunction.addEnvironment("DATABASE_URL", process.env.RGS_DATABASE_URL ?? "");
  crmFunction.addEnvironment("CRM_STORE", process.env.RGS_CRM_STORE ?? "dynamo");
}
adminApiFunction.addEnvironment("LEDGER_STORE", process.env.RGS_LEDGER_STORE ?? "dynamo");
```

**After:**

```ts
const crmStore = resolveStoreEnv(process.env.RGS_CRM_STORE, stage);
const ledgerStore = resolveStoreEnv(process.env.RGS_LEDGER_STORE, stage);

for (const crmFunction of [adminApiFunction, userApiFunction]) {
  crmFunction.addEnvironment("DATABASE_URL", process.env.RGS_DATABASE_URL ?? "");
  crmFunction.addEnvironment("CRM_STORE", crmStore);
}
adminApiFunction.addEnvironment("LEDGER_STORE", ledgerStore);
```

Replace reminders CRM wiring. **Before:**

```ts
if (process.env.RGS_DATABASE_URL !== undefined && process.env.RGS_DATABASE_URL !== "") {
  appointmentRemindersFunction.addEnvironment("DATABASE_URL", process.env.RGS_DATABASE_URL);
}
if (process.env.RGS_CRM_STORE !== undefined && process.env.RGS_CRM_STORE !== "") {
  appointmentRemindersFunction.addEnvironment("CRM_STORE", process.env.RGS_CRM_STORE);
}
```

**After:**

```ts
if (process.env.RGS_DATABASE_URL !== undefined && process.env.RGS_DATABASE_URL !== "") {
  appointmentRemindersFunction.addEnvironment("DATABASE_URL", process.env.RGS_DATABASE_URL);
}
const remindersCrmExplicit =
  process.env.RGS_CRM_STORE !== undefined && process.env.RGS_CRM_STORE !== "";
if (remindersCrmExplicit || stage === "staging") {
  appointmentRemindersFunction.addEnvironment("CRM_STORE", crmStore);
}
```

Update the comment above the admin/user CRM loop to say: staging unset defaults to postgres; non-staging unset stays dynamo; explicit `RGS_*` wins.

Do **not** touch `platformTable`, grants, or `TABLE_NAME`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd infra && node --import tsx --test test/admin-rbac.test.ts
```

Expected: PASS (all cases including new staging matrix and existing CRM wiring tests).

Optional broader infra check if the package has a test script:

```bash
pnpm --filter @rgs/infra test
```

(or the repo’s equivalent infra test command — use whatever `infra/package.json` already defines).

- [ ] **Step 5: Commit**

```bash
git add infra/lib/rgs-platform-stack.ts infra/test/admin-rbac.test.ts
git commit -m "$(cat <<'EOF'
feat(infra): default staging CRM/ledger stores to postgres when RGS_* unset

Bare staging deploys no longer fall back to Dynamo; explicit dynamo still wins for rollback. Prod defaults unchanged.
EOF
)"
```

---

### Task 2: D.1 staging runbook + design status

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` — Status → approved for D.1; Owner sign-off note

**Interfaces:** Runbook is ops-only; no new code exports.

- [ ] **Step 1: Write the runbook**

Create `docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md` with this content (adjust only if staging project refs in sibling C.2.2 runbook differ — copy those values):

```markdown
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

---

## Checklist

### 0. Preconditions

- [ ] C.2.2 live on staging (leads + notices on Postgres).
- [ ] D.1 code merged (staging defaults + infra tests green).
- [ ] ``RGS_DATABASE_URL`` ready (transaction pooler `:6543` for Lambda deploy env).

### 1. Deploy

Deploy `RgsPlatform-staging` with usual credentials. Optional: omit `RGS_CRM_STORE` / `RGS_LEDGER_STORE` to exercise defaults, **or** keep explicit `postgres` (redundant but fine).

```bash
# Example — match your existing staging deploy entrypoint
RGS_DATABASE_URL='postgresql://…:6543/rgs_staging?pgbouncer=true' \
  # RGS_CRM_STORE / RGS_LEDGER_STORE intentionally unset to use D.1 defaults
  <your staging cdk deploy command for RgsPlatform-staging>
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
```

- [ ] **Step 2: Update design doc status**

In `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md`:

- Change `**Status:** draft (awaiting written-spec review)` → `**Status:** approved (D.1 plan unlocked; D.2 plan after D.1 soak)`
- Change `**Owner sign-off:** _pending_` → `**Owner sign-off:** approved 2026-10-02 (chat); D.1 plan follows`

- [ ] **Step 3: Commit**

```bash
git add \
  docs/superpowers/specs/2026-10-02-supabase-phase-d1-staging-runbook.md \
  docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md
git commit -m "$(cat <<'EOF'
docs: add Phase D.1 staging defaults runbook

Records verify/rollback for postgres CDK defaults; marks Phase D design approved for D.1.
EOF
)"
```

---

## Self-review (plan author)

| Spec requirement | Task |
|---|---|
| Staging unset → postgres CRM + ledger | Task 1 |
| Staging explicit dynamo → dynamo | Task 1 |
| Non-staging unset → dynamo | Task 1 |
| User API no LEDGER_STORE | Task 1 |
| Reminders get CRM_STORE=postgres on staging unset | Task 1 (D2 decision) |
| Ops runbook verify + rollback | Task 2 |
| No Dynamo branch / table removal | Global Constraints + Task 1 step 3 |
| Prod defaults unchanged | Task 1 prod unset test |
| D.2 out of scope | Global Constraints |

No placeholders. Types consistent (`resolveStoreEnv` → `crmStore` / `ledgerStore` strings). Review Focus items each pinned to Task 1 or Task 2.

**After both tasks:** implementation complete for D.1 code+docs. Staging **deploy cutover** is the runbook (operator / follow-up session), not a third plan task — same pattern as C.2.x “land then go ahead cutover.”
