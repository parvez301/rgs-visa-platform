# Supabase Postgres Phase D.2 — Orphan Staging Dynamo Table

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop CDK from owning `rgs-platform-staging` so staging Lambdas have no `TABLE_NAME` and no Dynamo IAM, while CloudFormation **retains** the existing table until an operator deletes it by hand.

**Architecture:** Two staging deploys, never one. Wave A sets `PlatformTable` `RemovalPolicy.RETAIN` and lets `buildProductionContext` boot without `TABLE_NAME` when Dynamo is not required. Wave B removes the table construct, env, grants, and `TableName` output for `stage === "staging"` only. Prod still creates the table. Domain Dynamo branches stay in the codebase.

**Tech Stack:** AWS CDK (`aws-cdk-lib`), Node.js `node:test` infra tests, Vitest API tests, existing `RgsPlatformStack` / `buildProductionContext`.

**Spec:** `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md`

## Global Constraints

- Spec decisions 1–7 closed (two ships; D.2 removes staging `platformTable` and retains/orphans; prod stack/table untouched; no Dynamo domain-branch deletion; backfill CLIs may still read Dynamo).
- Parent migration design decisions 1–8 still apply.
- **CloudFormation DeletionPolicy comes from the previous template.** Removing `PlatformTable` while staging still has `DeletionPolicy: Delete` **destroys** `rgs-platform-staging`. Wave A **must** be live on staging (confirm `DeletionPolicy: Retain`) **before** Wave B is deployed.
- Do **not** merge Wave A and Wave B into a single staging deploy.
- Do **not** change prod / `test` table ownership (prod still has table + `TABLE_NAME` + grants).
- Do **not** delete Dynamo domain `else` branches; do not rewrite backfill CLIs; do not `delete-table` in this ship.
- Do **not** set `LEDGER_STORE` on the user API.
- `CRM_STORE=postgres` / `LEDGER_STORE=postgres` still require `DATABASE_URL`.
- Descriptive names; conventional commits; one commit per task after tests pass.
- Prefer worktree `.worktrees/supabase-phase-d2-orphan-staging-table` off `main`.
- Do not deploy prod; do not re-run A–C.2.2 backfills.

## Review Focus

1. **One-shot Wave B deploy without Retain live** — CFN would destroy the staging table; pinned runbook Wave A verify + Global Constraints (no unit test can see AWS).
2. **Staging Lambdas without `TABLE_NAME` while CRM is postgres** — cold start must succeed (user API omits `LEDGER_STORE`, which still parses as ledger `dynamo`); pinned Task 2.
3. **`CRM_STORE=dynamo` or explicit `LEDGER_STORE=dynamo` without `TABLE_NAME`** — still throw missing `TABLE_NAME`; pinned Task 2.
4. **Prod synth still has `AWS::DynamoDB::Table` + `TABLE_NAME=rgs-platform-prod`** — pinned Task 3.
5. **Accidental Dynamo write after orphan** — `context.table.*` rejects loudly (no silent no-op); pinned Task 2.

## Decisions locked in this plan

| # | Choice |
|---|---|
| D1 | Two staging deploys: **Retain** then **orphan**. Never one changeset that both retains and deletes the resource. |
| D2 | `RemovalPolicy.RETAIN` applies **only** to `PlatformTable` when `stage === "staging"` (prod already RETAIN). Documents/Cognito keep today’s destroy-on-non-prod policy. |
| D3 | After orphan, `stage === "staging"` creates **no** `dynamodb.Table`, sets **no** `TABLE_NAME`, grants **no** Dynamo IAM, emits **no** `TableName` output. |
| D4 | `TABLE_NAME` required iff `crmStore === "dynamo"` **or** env `LEDGER_STORE` trims to `"dynamo"`. Unset `LEDGER_STORE` on the user API does **not** require a table. |
| D5 | When Dynamo is not required and `TABLE_NAME` is unset, `context.table` is an **unavailable** client that rejects every method (keep `AppContext.table` required). |
| D6 | Rollback = redeploy git SHA that still defines `PlatformTable` (Wave A or pre-D.2). Do not re-run backfills. Flag-flip `RGS_*=dynamo` is **not** enough after Wave B. |
| D7 | Tests: extend `infra/test/admin-rbac.test.ts` + `services/api/test/handlerContextSql.test.ts`. |
| D8 | Runbook: `docs/superpowers/specs/2026-10-03-supabase-phase-d2-staging-runbook.md`. |

## File map

| File | Responsibility |
|------|----------------|
| `infra/lib/rgs-platform-stack.ts` | Staging table RETAIN; later skip table / `TABLE_NAME` / grants / output |
| `infra/test/admin-rbac.test.ts` | Synth matrix: retain, then orphan vs prod |
| `services/api/src/lib/unavailableTableClient.ts` | Rejecting `TableClient` |
| `services/api/src/http/handler.ts` | Optional `TABLE_NAME` per D4–D5 |
| `services/api/test/handlerContextSql.test.ts` | Cold-start matrix |
| `docs/superpowers/specs/2026-10-03-supabase-phase-d2-staging-runbook.md` | Two-deploy cutover |
| `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` | Status: D.2 unlocked |

---

## Wave A — land + **staging deploy** before Wave B

### Task 1: Retain staging `PlatformTable`

**Files:**
- Modify: `infra/lib/rgs-platform-stack.ts` — `PlatformTable` removal policy only
- Modify: `infra/test/admin-rbac.test.ts` — DeletionPolicy assertions

**Interfaces:**
- Consumes: existing `synthesizedResourcesForStage(stage: string)`
- Produces: staging `AWS::DynamoDB::Table` with `DeletionPolicy: "Retain"` (and `UpdateReplacePolicy: "Retain"` if CDK emits it)

- [ ] **Step 1: Write the failing tests**

Add helpers next to `resourcesOfType`:

```ts
function dynamoTables(
  resources: Record<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return resourcesOfType(resources, "AWS::DynamoDB::Table");
}
```

Add:

```ts
it("retains the staging platform Dynamo table on stack delete/orphan", () => {
  const tables = dynamoTables(synthesizedResourcesForStage("staging"));
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.DeletionPolicy, "Retain");
});

it("still destroys the non-prod test platform table by default", () => {
  const tables = dynamoTables(synthesizedResources());
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.DeletionPolicy, "Delete");
});
```

Keep existing CRM/RBAC tests green.

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="$(pwd)/infra/node_modules/.bin:$PATH"
cd infra && CDK_CONTEXT_JSON='{"aws:cdk:bundling-stacks":[]}' \
  node --import tsx --test test/admin-rbac.test.ts
```

Expected: FAIL — staging table `DeletionPolicy` is `Delete` (today `removalPolicy` is DESTROY when `stage !== "prod"`).

- [ ] **Step 3: Minimal implementation**

In `RgsPlatformStack`, **do not** change the shared `removalPolicy` used by S3/Cognito/SPAs.

Set table policy separately:

```ts
const platformTableRemovalPolicy =
  stage === "staging" || isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

const platformTable = new dynamodb.Table(this, "PlatformTable", {
  tableName: `rgs-platform-${stage}`,
  partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: platformTableRemovalPolicy,
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProduction },
});
```

Comment: staging RETAIN so a later template that drops this resource orphans `rgs-platform-staging` instead of deleting it.

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: PASS (including new DeletionPolicy cases).

- [ ] **Step 5: Commit**

```bash
git add infra/lib/rgs-platform-stack.ts infra/test/admin-rbac.test.ts
git commit -m "$(cat <<'EOF'
fix(infra): retain staging Dynamo table so D.2 can orphan it

Staging PlatformTable used DESTROY; removing it next would have CloudFormation delete rgs-platform-staging. Prod already retained.
EOF
)"
```

---

### Task 2: Boot without `TABLE_NAME` when Dynamo is unused

**Files:**
- Create: `services/api/src/lib/unavailableTableClient.ts`
- Modify: `services/api/src/http/handler.ts` — `buildProductionContext` required-env + table wiring
- Test: `services/api/test/handlerContextSql.test.ts`

**Interfaces:**

```ts
export function unavailableTableClient(): TableClient
```

Every method returns `Promise.reject(new Error("DynamoDB is not configured (TABLE_NAME unset)"))`.

```ts
export function dynamoTableRequired(environment: NodeJS.ProcessEnv): boolean {
  const crmStore = crmStoreFromEnvironment(environment);
  if (crmStore === "dynamo") return true;
  const ledgerRaw = environment["LEDGER_STORE"]?.trim();
  return ledgerRaw === "dynamo";
}
```

Put `dynamoTableRequired` in `handler.ts` (file-local) **or** next to the store helpers in `sql.ts` if that keeps handler thinner — prefer **file-local in `handler.ts`** so store parsing stays in one boot path. Do **not** export unless a test needs it; tests drive `buildProductionContext`.

- [ ] **Step 1: Write the failing tests**

In `handlerContextSql.test.ts`, reuse `requiredEnv`. Add:

```ts
it("boots without TABLE_NAME when CRM_STORE=postgres and LEDGER_STORE is unset", async () => {
  Object.assign(process.env, requiredEnv);
  delete process.env["TABLE_NAME"];
  process.env["CRM_STORE"] = "postgres";
  process.env["DATABASE_URL"] = "postgresql://user:pass@localhost:6543/postgres";
  delete process.env["LEDGER_STORE"];

  const { buildProductionContext } = await import("../src/http/handler");
  const context = buildProductionContext();
  await expect(context.table.get("PK", "SK")).rejects.toThrow(/TABLE_NAME unset/);
  await context.sql?.end();
});

it("still requires TABLE_NAME when CRM_STORE defaults to dynamo", async () => {
  Object.assign(process.env, requiredEnv);
  delete process.env["TABLE_NAME"];
  delete process.env["CRM_STORE"];
  delete process.env["LEDGER_STORE"];

  const { buildProductionContext } = await import("../src/http/handler");
  expect(() => buildProductionContext()).toThrow(/TABLE_NAME/);
});

it("requires TABLE_NAME when LEDGER_STORE=dynamo even if CRM is postgres", async () => {
  Object.assign(process.env, requiredEnv);
  delete process.env["TABLE_NAME"];
  process.env["CRM_STORE"] = "postgres";
  process.env["LEDGER_STORE"] = "dynamo";
  process.env["DATABASE_URL"] = "postgresql://user:pass@localhost:6543/postgres";

  const { buildProductionContext } = await import("../src/http/handler");
  expect(() => buildProductionContext()).toThrow(/TABLE_NAME/);
});
```

Existing `tableRetry.test.ts` cases that set `TABLE_NAME` must still pass.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @rgs/api exec vitest run test/handlerContextSql.test.ts
```

Expected: FAIL — missing `TABLE_NAME` still throws for the postgres/unset-ledger case.

- [ ] **Step 3: Minimal implementation**

`unavailableTableClient.ts`: implement `TableClient` with one shared reject (do not no-op).

`buildProductionContext`:

1. Parse `documentsBucket`, `senderAddress`, `adminNotificationAddress` as today.
2. Parse `crmStore` / `ledgerStore` / `databaseUrl` **before** the table-name check (postgres still requires `DATABASE_URL` as today).
3. `tableName = process.env["TABLE_NAME"]`.
4. If `dynamoTableRequired(process.env)`: require `tableName` (same error string as today if missing, still listing `TABLE_NAME` among required env).
5. If not required: `tableName` may be missing.
6. Still require documents/email env vars.
7. `table`: if `tableName` present → `withWriteRetries(new DynamoTableClient(tableName), …)` as today; else → `unavailableTableClient()` (no retry wrapper needed).

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @rgs/api exec vitest run test/handlerContextSql.test.ts test/tableRetry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/lib/unavailableTableClient.ts services/api/src/http/handler.ts services/api/test/handlerContextSql.test.ts
git commit -m "$(cat <<'EOF'
feat(api): allow Lambda boot without TABLE_NAME when stores are postgres

Staging D.2 drops TABLE_NAME; user API omits LEDGER_STORE so ledger default dynamo must not force a table.
EOF
)"
```

---

**Wave A gate (humans, not a code task):** Merge Wave A to `main`. Deploy `RgsPlatform-staging`. Confirm CloudFormation resource `PlatformTable` (or equivalent) `DeletionPolicy=Retain`. **Do not start Task 3 deploy until that is true.**

---

## Wave B — only after Wave A is live on staging

### Task 3: Stop owning the staging table + runbook

**Files:**
- Modify: `infra/lib/rgs-platform-stack.ts` — gate table, env, grants, output
- Modify: `infra/test/admin-rbac.test.ts` — staging has no table; prod still does
- Create: `docs/superpowers/specs/2026-10-03-supabase-phase-d2-staging-runbook.md`
- Modify: `docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` — D.2 in progress / Wave A+B

**Interfaces:**
- Consumes: Task 1 retain (already deployed); Task 2 boot rules
- Produces: `ownPlatformTable = stage !== "staging"`; `platformTable: dynamodb.Table | undefined`

- [ ] **Step 1: Write the failing tests**

The Task 1 test `"retains the staging platform Dynamo table…"` **must be replaced** — after this task staging has **zero** Dynamo tables:

```ts
it("does not own a platform Dynamo table on staging", () => {
  const resources = synthesizedResourcesForStage("staging");
  assert.equal(dynamoTables(resources).length, 0);
  const env = lambdaEnvByName(resources);
  assert.equal(env["rgs-admin-api-staging"]?.["TABLE_NAME"], undefined);
  assert.equal(env["rgs-user-api-staging"]?.["TABLE_NAME"], undefined);
  assert.equal(env["rgs-appointment-reminders-staging"]?.["TABLE_NAME"], undefined);
});

it("still owns a platform Dynamo table on prod", () => {
  const resources = synthesizedResourcesForStage("prod");
  assert.equal(dynamoTables(resources).length, 1);
  const env = lambdaEnvByName(resources);
  assert.equal(env["rgs-admin-api-prod"]?.["TABLE_NAME"], "rgs-platform-prod");
  assert.equal(env["rgs-user-api-prod"]?.["TABLE_NAME"], "rgs-platform-prod");
});
```

Keep `"still destroys the non-prod test platform table by default"` (stage `test`).

Optional IAM check: stringify staging `AWS::IAM::Policy` / inline role policies and assert they do not contain `"dynamodb:"`. If a shared policy false-positives, drop this assert rather than weakening grants on prod.

- [ ] **Step 2: Run tests to verify they fail**

Same infra test command as Task 1. Expected: FAIL — staging still synthesizes a table and `TABLE_NAME`.

- [ ] **Step 3: Minimal implementation**

```ts
const ownPlatformTable = stage !== "staging";
const platformTableRemovalPolicy =
  stage === "staging" || isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
// platformTableRemovalPolicy is unused when !ownPlatformTable; omit the staging|| branch if the table is not constructed — keep RETAIN only on created tables (prod/test).

let platformTable: dynamodb.Table | undefined;
if (ownPlatformTable) {
  platformTable = new dynamodb.Table(this, "PlatformTable", {
    tableName: `rgs-platform-${stage}`,
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProduction },
  });
  for (const indexName of ["GSI1", "GSI2", "GSI3"] as const) {
    platformTable.addGlobalSecondaryIndex({
      indexName,
      partitionKey: { name: `${indexName}PK`, type: dynamodb.AttributeType.STRING },
      sortKey: { name: `${indexName}SK`, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
```

`sharedLambdaProps.environment`: **stop** putting `TABLE_NAME` in the shared object. Build `sharedEnvironment` without it; if `platformTable` exists, `TABLE_NAME: platformTable.tableName`.

Grants: wrap `platformTable.grantReadWriteData(...)` in `if (platformTable)`.

Output: `if (platformTable) { new cdk.CfnOutput(this, "TableName", { value: platformTable.tableName }); }`

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="$(pwd)/infra/node_modules/.bin:$PATH"
cd infra && CDK_CONTEXT_JSON='{"aws:cdk:bundling-stacks":[]}' \
  node --import tsx --test test/admin-rbac.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the runbook**

Create `docs/superpowers/specs/2026-10-03-supabase-phase-d2-staging-runbook.md`:

```markdown
# Supabase Phase D.2 — staging Dynamo orphan runbook

**Date:** 2026-10-03  
**Scope:** Two deploys. (A) Retain `rgs-platform-staging` in CloudFormation. (B) Remove the table from the staging stack; Lambdas lose `TABLE_NAME` and Dynamo IAM; table stays in AWS until manual delete.  
**Design:** `2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md` · **Plan:** `docs/superpowers/plans/2026-10-03-supabase-postgres-phase-d2-orphan-staging-table.md`  
**Prerequisite:** D.1 live (`2026-10-02-supabase-phase-d1-staging-runbook.md`). C.2.2 live.

**Out of scope:** `aws dynamodb delete-table` in this ship; prod table; deleting Dynamo domain code; re-running backfills.

**Staging target:** same as D.1 (`rgs_staging`, ref `kblgpjwqqixkcnbdfzsn`, `ap-south-1`).

> **Two deploys or the table dies.** Wave B removes the resource. CFN uses the **previous** DeletionPolicy. If that is still Delete, AWS destroys `rgs-platform-staging`.  
> **D.1 rollback `RGS_*=dynamo` does not restore Dynamo after Wave B** — Lambdas have no table name/IAM. Rollback = previous CDK artifact that still defines `PlatformTable`.  
> **No backfill.** Do not re-run `backfill:*`.

## Wave A — Retain

- [ ] Wave A git SHA merged (Retain on staging `PlatformTable` + optional TABLE_NAME-optional API).
- [ ] Deploy `RgsPlatform-staging` (unset store flags OK; `RGS_DATABASE_URL` required).
- [ ] `aws cloudformation describe-stack-resource --stack-name RgsPlatform-staging --logical-resource-id <PlatformTable logical id>` shows `DeletionPolicy` **Retain** (or template `DeletionPolicy: Retain` on the Dynamo table).
- [ ] Table still exists: `rgs-platform-staging`.
- [ ] Smoke: `GET /api/v1/notices` 200.

## Wave B — Orphan

- [ ] Wave A Retain confirmed live.
- [ ] Wave B git SHA merged (no staging table construct).
- [ ] Deploy `RgsPlatform-staging`.
- [ ] Lambdas `rgs-admin-api-staging`, `rgs-user-api-staging`, `rgs-appointment-reminders-staging`: **no** `TABLE_NAME`; admin still `CRM_STORE=postgres` + `LEDGER_STORE=postgres`; user `CRM_STORE=postgres` and no `LEDGER_STORE`.
- [ ] Stack output `TableName` absent.
- [ ] `aws dynamodb describe-table --table-name rgs-platform-staging` still succeeds (orphan).
- [ ] Smoke: notices 200; optional lead POST 200; admin CRM list still works.
- [ ] Record orphan name `rgs-platform-staging` and deploy SHA/time.
- [ ] Do **not** `delete-table` until a later soak decision.

## Rollback

Redeploy the SHA that still contains `PlatformTable` (Wave A or pre-D.2). Do not re-run A–C.2.2 backfills.
```

Fill the logical resource id during cutover (`aws cloudformation list-stack-resources --stack-name RgsPlatform-staging --query "StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table']"`).

Update design header Status to `approved (D.2 Wave A retain then Wave B orphan)` and §10 to say D.2 plan is `docs/superpowers/plans/2026-10-03-supabase-postgres-phase-d2-orphan-staging-table.md`.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/rgs-platform-stack.ts infra/test/admin-rbac.test.ts \
  docs/superpowers/specs/2026-10-03-supabase-phase-d2-staging-runbook.md \
  docs/superpowers/specs/2026-10-02-supabase-postgres-phase-d-dynamo-decommission-design.md
git commit -m "$(cat <<'EOF'
feat(infra): drop staging Dynamo table from CDK and keep the AWS orphan

Staging Lambdas no longer get TABLE_NAME or Dynamo IAM. Prod table wiring unchanged. Delete-table stays manual.
EOF
)"
```

---

## Self-review (plan author)

| Spec requirement | Task |
|---|---|
| Staging stop owning `platformTable` | Task 3 |
| No `TABLE_NAME` / Dynamo IAM on staging Lambdas | Task 3 |
| CFN does not delete table (retain / orphan) | Task 1 + two-deploy gate |
| Staging synth no table; prod still has table | Task 3 tests |
| Runbook: deploy, no TABLE_NAME, record orphan, manual delete later, rollback prior artifact | Task 3 |
| No domain-branch deletion; no prod table drop; no auto destroy | Global Constraints |
| API still boots on staging after TABLE_NAME removal | Task 2 (user API LEDGER unset) |

No placeholders. `unavailableTableClient` / `dynamoTableRequired` names consistent. Review Focus items pinned.

**Shipped software:** Wave A is deployable alone. Wave B is the D.2 end state. Staging **cutover** is the runbook, after each wave lands.
