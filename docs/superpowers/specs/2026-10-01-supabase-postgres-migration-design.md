# RGS — Supabase Postgres as system of record

**Date:** 2026-10-01  
**Status:** approved 2026-10-01 — Phase A plan next  
**Related:** `2026-09-09-rgs-crm-design.md` (Dynamo single-table CRM), `2026-09-11-rgs-crm-ledger-design.md` (GSI ledger compromises)

---

## 1. Why

AWS RDS is too expensive for this stage of RGS. The product still needs
**relational** storage: the CRM Ledger already fights Dynamo (status XOR
partner server-side; country / type / billing / search / today-dates filtered
in the browser over thousands of projected META rows).

**Goal:** move **all durable application data** onto **Supabase-hosted
Postgres** (a dedicated RGS database / project), keep the existing AWS
compute and auth plane, and retire DynamoDB once nothing critical reads it.

**Non-goal:** rebuild the product on Supabase Auth, Edge Functions, or
Supabase Storage as a platform rewrite.

---

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Supabase = hosted Postgres (+ connection pooler). System of record for app data. | AWS RDS / Aurora (cost); Dynamo forever with more GSIs |
| 2 | Keep Cognito (admin + user pools), API Gateway, Lambda, CloudFront, S3 (docs/binaries), SES | Migrate auth to Supabase Auth; move file bytes to Supabase Storage in v1 |
| 3 | End state: **entire** product data in Postgres (CRM + visa platform: applications, config, leads, notices, users profile rows, etc.) | CRM-only forever; dual SoR forever |
| 4 | Migrate **phased**, CRM first (reads → writes), then visa-platform domains; Dynamo deleted last | Big-bang cutover of the single table in one release |
| 5 | Lambdas connect via **Supabase pooler in transaction mode** (or equivalent pooled URL), not a raw session connection per invoke | One RDS Proxy in front of Supabase; unpooled direct connects from hot Lambdas |
| 6 | Staging and prod = **separate** Supabase projects (or clearly isolated DBs + secrets) | One shared DB for both |
| 7 | Prefer region **close to API Lambdas** (`ap-south-1` today) when Supabase offers it; otherwise accept latency and measure | Force multi-region complexity in v1 |
| 8 | Introduce a thin `DbClient` / repository boundary for new Postgres access; stop growing `TableClient` call sites for migrated domains | Rewrite every domain behind a fake Dynamo adapter on Postgres |

**On decision 1** — cost is the primary driver; SQL access patterns for the
Ledger and agent “ask the ledger” tools are the secondary payoff.

**On decision 2** — auth and email already work. Switching them does not reduce
RDS spend and expands blast radius.

**On decision 4** — the Dynamo surface (`TableClient`, GSI1–3, META+applicants
partitions, import/backfill CLIs, InMemoryTable tests) is too large for a
single safe flip while the desk is live.

---

## 3. Target architecture

```
apps/admin, apps/portal, Cognito
            │
            ▼
   API Gateway + Lambda (AWS, ap-south-1)
            │
            ├── Postgres (Supabase)  ← system of record (phased cutover)
            ├── S3                  ← documents / binaries (unchanged)
            ├── SES                 ← transactional mail (unchanged)
            └── DynamoDB            ← retired after cutover
```

- **Secrets:** Supabase DB URL (pooled) + service role only where needed;
  never ship the service role to browsers. Admin/portal keep Cognito JWTs;
  API authorizes as today.
- **RLS:** optional later for direct client access. v1 access path is
  **server-side only** (Lambda with DB credentials), same trust model as
  today’s Dynamo IAM role.
- **Migrations:** versioned SQL (e.g. `drizzle` / `node-pg-migrate` /
  Supabase CLI migrations — pick one in the implementation plan and stick
  to it). No ad-hoc prod console schema edits.

---

## 4. Data domains (move order)

### Phase A — CRM read path (first value)

Backfill / sync into Postgres; switch **Ledger, search, export, counts** to
SQL. Dynamo remains authoritative for writes.

**Tables (indicative):** `partners`, `travellers`, `cases`, `applicants`,
`case_events`, `review_items`, `ref_claims`, plus projected columns needed
for ledger search (`search_text`, `applicant_summary` JSON/columns).

### Phase B — CRM write path

Case create/update, status/custody/billing transitions, partners,
travellers, review resolve, status-email templates, CRM memory/prefs,
proposals — all commit in Postgres (transactions replace META+applicant
multi-put fragility).

Stop dual-writing once reads and writes both trust PG for CRM.

**Implementation split:** Phase **B.1** plan
(`docs/superpowers/plans/2026-10-01-supabase-postgres-phase-b.md`) covers
case SoR + applicants + events + partners/travellers/ref claims +
`CRM_STORE` cutover. Review queue, proposals, agent memory, and
status-email **writes** are **Phase B.2** (separate plan).

### Phase C — Visa platform / shared admin data

`applications`, `users` (app profile rows), `config` / country products,
`documents` metadata (bytes stay S3), `leads`, `notices`, activity/admin
queues as applicable.

### Phase D — Decommission Dynamo

Remove `DynamoTableClient` production wiring, table CDK, GSI-specific
domain helpers. Keep or rewrite import CLIs against Postgres. In-memory
tests become PG testcontainers or a transactional test DB.

---

## 5. Ledger behaviour after cutover

Once Phase A is live, the Ledger may:

- Filter **status AND partner AND country AND type AND billing AND dates**
  in one SQL query (remove the XOR compromise from
  `LedgerPage` / `listLedgerRows`).
- Push text search to Postgres (`ILIKE` / `tsvector` — choose in plan).
- Return honest totals without loading the full ledger into the browser.

UI may keep client-side polish filters for tiny result sets, but the
**server must be able to answer the combined query**.

---

## 6. Cutover and safety

| Rule | Detail |
|---|---|
| Staging first | Full Phase A→B on staging; desk smoke (create case, status walk, ledger filters, export). |
| Lambda deploy env | CDK synth reads `RGS_DATABASE_URL` → Lambda `DATABASE_URL`. Use the Supabase **transaction pooler** URI (`:6543`; add `?pgbouncer=true` when required). Set `RGS_LEDGER_STORE=postgres` only after the URL is wired; `LEDGER_STORE=postgres` without `DATABASE_URL` fails cold start. |
| Backfill idempotent | Re-runnable import from Dynamo (or export snapshot) keyed by existing ids (`case_…`, etc.). |
| Dual-write window (optional, short) | Only if needed for zero-downtime; must not become permanent (cost + drift). Prefer read-switch after verified backfill, then write-switch in a maintenance window if desk can pause briefly. |
| Unreadable / corrupt rows | Preserve today’s discipline: name bad rows; do not silently drop from queues. |
| Rollback | Phase A rollback = point Ledger API back at Dynamo GSI path. Phase B rollback needs a pre-cut Dynamo snapshot or freeze — document in the plan before write cutover. |

---

## 7. Cost and ops notes

- Prefer Supabase **Pro** (or current paid tier) for prod: backups, pause
  protection, adequate compute. Free tier is staging-only unless explicitly
  accepted.
- Watch: compute add-ons, egress, disk growth from events/audit.
- Connection errors under Lambda concurrency → pooler sizing and
  `max` clients in the Lambda data-access layer.
- Monitoring: API error rate, p95 ledger latency, Supabase disk/CPU,
  failed migration job alerts.

---

## 8. Out of scope (this design)

- Replacing Cognito with Supabase Auth
- Moving S3 object bytes to Supabase Storage (metadata may live in PG)
- Multi-tenant SaaS billing / tenant provisioning UI
- Realtime Supabase subscriptions for the Ledger (nice-to-have later)
- Rewriting the agent LLM stack

---

## 9. Success criteria

1. Staging CRM Ledger served from Supabase Postgres with combined filters
   and no Dynamo read on that path.
2. Staging CRM writes (create case → status transitions → events) commit
   only to Postgres; desk smoke green.
3. Prod cutover for CRM without silent case loss (row counts + spot checks
   vs pre-cut export).
4. Visa-platform domains on Postgres (Phase C) or an explicit follow-up
   spec if deferred after CRM.
5. DynamoDB table removed from prod CDK (or emptied and scheduled delete)
   after Phase D.
6. Monthly data-store cost materially below equivalent RDS; no surprise
   dual-running both for months.

---

## 10. Open points for the implementation plan

Resolve in the plan (not blockers for approving this design):

1. Migration tool (`drizzle` vs Supabase CLI SQL vs other).
2. Exact Supabase region vs `ap-south-1` Lambda latency budget.
3. Dual-write vs maintenance-window write cutover for Phase B.
4. Whether Phase C starts immediately after B or waits for a second spec.
5. Test strategy: Testcontainers Postgres vs shared staging DB for CI.

---

## 11. Approval

Approve this design to unlock an implementation plan under
`docs/superpowers/plans/` (Phase A first, separately executable).

**Owner sign-off:** _pending_
