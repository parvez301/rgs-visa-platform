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
- [ ] Confirm the current Dynamo logical ID with:
  `aws cloudformation list-stack-resources --stack-name RgsPlatform-staging --query "StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table']"`
- [ ] Confirm `PlatformTable5198EBA1` has `DeletionPolicy: Retain` in the deployed template. This is the currently observed logical ID; re-query it if the stack changes.
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
