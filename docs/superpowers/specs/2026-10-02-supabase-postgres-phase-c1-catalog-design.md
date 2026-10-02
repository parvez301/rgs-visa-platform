# RGS — Supabase Postgres Phase C.1 (country catalog SoR)

**Date:** 2026-10-02  
**Status:** approved (implementation plan landed)  
**Parent:** `2026-10-01-supabase-postgres-migration-design.md`  
**Prior:** Phase B.2 (`CRM_STORE=postgres` remaining CRM SoR) + staging runbook

---

## 1. Why

CRM case and desk surfaces are on Postgres under `CRM_STORE=postgres` (Phases
A–B.2). The **visa country catalog** still lives in Dynamo:

- `CONFIG#COUNTRY` rows via `domain/config.ts` (`listCountryConfig`,
  `resolveCountryProduct`, `upsertCountryProduct`).
- Legacy **country checklist** partitions (`countryChecklist.ts`) — not served
  over HTTP; live document lists come from `CountryProduct.requiredDocuments`
  (B.2 explicitly deferred full catalog + leftover cleanup to Phase C).

**Goal:** Move the live country-product catalog to Postgres under the existing
`CRM_STORE` flag, seed rows once at migrate time, backfill Dynamo desk edits
over that seed, fold leftover checklists into products, then delete checklist
Dynamo code.

**Non-goal:** Portal applications / users / leads / notices / documents
metadata (Phase **C.2**); deleting the Dynamo table (Phase **D**); dual-write;
a new catalog-only env flag.

---

## 2. Decisions

| # | Choice | Rejected |
|---|---|---|
| 1 | Scope = **C.1 catalog-first** (not full Phase C in one design) | Full C (apps + leads + notices + catalog) in one plan |
| 2 | Gate on existing **`CRM_STORE`** (`dynamo` \| `postgres`) | New `CATALOG_STORE` / `PLATFORM_STORE` |
| 3 | End state for catalog = **Postgres only**; no long-lived Dynamo catalog SoR | Keep Dynamo catalog as forever fallback |
| 4 | Approach = **mirror B.2**: SQL adapters + migrate → backfill → deploy; no dual-write | Always-Postgres with no Dynamo branch in same PR; dual-write window |
| 5 | Migration **inserts seed** from `@rgs/shared` `COUNTRY_PRODUCTS` when the table is empty; runtime does **not** fall back to in-memory seed on empty PG | Keep empty-Dynamo-style memory fallback after cutover; empty PG = empty catalog with no seed rows |
| 6 | Leftover checklists: **fold into products** (where still needed), then **delete** checklist Dynamo module | Leave dead checklist helpers on Dynamo until D; new checklist SoR table |
| 7 | Staging first on `rgs_staging`; prod later after soak | Prod in same change |
| 8 | Activity log (`CONFIG_CHANGED` via `activity.ts`) **stays Dynamo** for this slice | Move activity into C.1 |

---

## 3. Scope

### In

| Area | Surfaces |
|---|---|
| Live catalog | `listCountryConfig`, `listActiveCountryConfig`, `resolveCountryProduct`, `upsertCountryProduct` (+ first-write seed behaviour preserved via migration seed, not empty-read memory fallback) |
| Schema | One main table for country products; `requiredDocuments` as JSON matching shared schema |
| Seed | Versioned migration inserts `COUNTRY_PRODUCTS` when table empty |
| Backfill | Dynamo `CONFIG#COUNTRY` → Postgres upsert (desk beats seed) |
| Checklist cleanup | Fold leftover checklist rows into products if needed; remove `countryChecklist.ts` production paths |
| Ops | Staging runbook; smoke list / upsert / resolve required-docs |

### Out

- Applications, portal users, leads, notices, documents metadata, admin/activity SoR (C.2).
- Dynamo decommission (Phase D).
- Changing Cognito / S3 / SES.
- Re-running Phase A/B backfills after cutover (still forbidden).

---

## 4. Target schema (indicative)

Exact DDL in the migration file; shapes must round-trip `CountryProductSchema`.

| Table | Role |
|---|---|
| `crm_country_products` | PK `(country_code, product_code)`; columns for name, visa/region/tier, fees, days, entry, `required_documents` jsonb, `active`, optional `official_url`; optional audit columns if we already stamp them on write |

No separate checklist SoR table.

---

## 5. Architecture

```
CRM_STORE=dynamo     → existing Dynamo CONFIG#COUNTRY paths
CRM_STORE=postgres   → configCountryProductsPostgres; require DATABASE_URL
LEDGER_STORE         → unchanged
```

- Dispatch at `config.ts` entry points via `crmPostgresOf` / same pattern as B.1–B.2.
- When `CRM_STORE=postgres`, never silently fall back to Dynamo for catalog reads/writes.
- Corrupt / unreadable rows: name `countryCode#productCode` in
  `unreadableCountryProductIds` (existing listing field).
- Portal, marketing, CRM case stamp, and agent continue to consume
  `resolveCountryProduct` / list helpers — only the store behind them changes.
- `destinationCountries` / `destinationRequiredDocuments` thin helpers keep
  calling config; no parallel catalog.

---

## 6. Cutover (staging)

`RGS_CRM_STORE` is already `postgres` on staging after B.1/B.2.

1. Apply migration on `rgs_staging` (session URL) — table + seed if empty.
2. Backfill Dynamo `CONFIG#COUNTRY` into Postgres; gate on unreadable = 0.
3. Fold leftover checklists into products if any remain; verify live path is
   product `requiredDocuments` only.
4. Deploy API with C.1 code (same `RGS_*` env; no flag flip).
5. Smoke: list catalog; upsert one product; resolve required docs on a known
   country/product; confirm Dynamo `CONFIG#COUNTRY` not required for those reads.
6. Do **not** re-run catalog (or A/B) backfills after deploy — they overwrite
   newer PG rows from stale Dynamo.

**Ship order:** migrate → backfill → deploy. Do not deploy postgres catalog
readers against an empty unseeded table.

### Rollback

- Set `RGS_CRM_STORE=dynamo` (or unset) and redeploy admin + reminders —
  **entire** CRM + catalog return to Dynamo (same blast radius as B.2).
- PG-only catalog edits since cutover do not appear in Dynamo; warn operators.
- Prefer fix-forward on staging after C.1 is live.

### Prod

Separate runbook after staging soak. Not day-one of this design.

---

## 7. Testing

- PGlite: migration creates table and seeds when empty; second apply is
  idempotent (no duplicate seed).
- Postgres path: list / resolve / upsert round-trip; unreadable naming.
- `CRM_STORE=dynamo`: existing Dynamo catalog behaviour unchanged.
- After cutover semantics: empty PG **without** seed rows is a failed migrate /
  misconfigured env — runtime must not resurrect in-memory `COUNTRY_PRODUCTS`
  as SoR when `CRM_STORE=postgres`.
- Backfill: idempotent; exit non-zero if any unreadable id list non-empty;
  Dynamo row wins over seed on conflict.
- Checklist: fold coverage in migration/backfill tests; production checklist
  module removed (tests updated or deleted with the dead path).

---

## 8. File map (indicative)

| Area | Location |
|---|---|
| Migration | `services/api/src/db/migrations/005_…`, `migrate.ts` |
| Catalog SQL | `services/api/src/domain/configCountryProductsPostgres.ts` (or sibling next to `config.ts`) |
| Dispatch | `services/api/src/domain/config.ts` |
| Checklist removal | `services/api/src/domain/crm/countryChecklist.ts` (+ callers/tests) |
| Backfill | `services/migration/src/backfillCountryCatalogToPostgres*.ts` |
| Runbook | `docs/superpowers/specs/2026-10-02-supabase-phase-c1-staging-runbook.md` (with plan) |

Implementation detail and task checkboxes live in the Phase C.1 **plan**
(writing-plans after this spec is approved).

---

## 9. Success criteria

1. Staging: with `CRM_STORE=postgres`, catalog list/resolve/upsert use Postgres;
   Dynamo `CONFIG#COUNTRY` not required for those flows.
2. Seed exists as real PG rows after migrate; no empty-read memory SoR fallback
   under postgres.
3. Leftover checklist Dynamo paths gone from the production API after fold.
4. Backfill gate clean; rollback path documented (CRM_STORE flip).
5. No C.2/D scope creep in the C.1 plan.

---

## 10. Approval

Approve this design to unlock
`docs/superpowers/plans/2026-10-02-supabase-postgres-phase-c1-catalog.md`.

**Owner sign-off:** _pending_
