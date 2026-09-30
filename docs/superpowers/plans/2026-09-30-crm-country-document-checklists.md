# CRM country document checklists + full country names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** New Case destination dropdown shows full country names; CRM owns per-country required documents (admin-editable); stamp cases from CRM checklists only; one-time migrate from Config `docsRequired`.

**Worktree:** `.worktrees/crm-country-checklists` · Branch: `feat/crm-country-checklists`

**Spec (approved design):** Config `docsRequired` is NOT the runtime source for CRM cases. CRM `CountryChecklist.requiredDocuments` is. Migrate once from Config. Portal Config unchanged for portal apps.

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/docTypeLabels.ts` | DocType → human label (shared for migrate + admin) |
| `packages/shared/src/crm/index.ts` | Re-export if needed |
| `services/api/src/domain/crm/countryChecklist.ts` | Existing get/put/find; add `listCountryChecklists` |
| `services/api/src/domain/crm/destinationCountries.ts` | List unique `{countryCode,countryName}` for CRM (from config catalog, crm-gated) |
| `services/api/src/http/crmApi.ts` | Routes: destinations, list/get/put checklists |
| `services/migration/src/seedCountryChecklistsFromConfig.ts` | Migrate docsRequired → CRM labels |
| `apps/admin/src/crm/api/crmClient.ts` | Client methods |
| `apps/admin/src/crm/countryChecklists/CountryChecklistsPage.tsx` | Admin UI |
| `apps/admin/src/crm/newCase/NewCaseDrawer.tsx` | Full names via CRM destinations; preview docs on country select |
| `apps/admin/src/main.tsx` | Route `/crm/country-checklists` |
| `apps/admin/src/crm/ledger/LedgerPage.tsx` | Nav link |

## Task 1: Shared DocType labels + list destinations + checklist list domain

- [ ] Add `DOC_TYPE_LABELS` + `labelForDocType` in shared
- [ ] `listDestinationCountries(context)` — unique active products by code, prefer longest/full `countryName`, sort by name
- [ ] `listCountryChecklists(context, tenantId)` — scan or iterate known codes
- [ ] Tests
- [ ] Commit

## Task 2: HTTP routes (CRM screen)

- [ ] `GET /api/v1/admin/crm/destination-countries` → `{ countries: {countryCode,countryName}[] }` requireScreen crm
- [ ] `GET /api/v1/admin/crm/country-checklists` → `{ checklists: CountryChecklist[] }`
- [ ] `GET /api/v1/admin/crm/country-checklists/{countryCode}`
- [ ] `PUT /api/v1/admin/crm/country-checklists/{countryCode}` requireWrite body `{ requiredDocuments: string[], notes?: string }`
- [ ] Tests + routeAccessMatrix
- [ ] Commit

## Task 3: Migration CLI Config → CRM

- [ ] For each config country product, union `docsRequired`, map via `DOC_TYPE_LABELS`, `putIfAbsent`-style seed (do not overwrite existing CRM checklist)
- [ ] Script `seed:country-checklists-from-config`
- [ ] Tests
- [ ] Commit

## Task 4: Admin UI + New Case

- [ ] crmClient methods
- [ ] CountryChecklistsPage: table of destinations + checklist editor
- [ ] NewCaseDrawer: load destinations from CRM endpoint (full names); on country change fetch checklist and show required docs preview
- [ ] EditCaseDrawer: same destination list
- [ ] Nav link; route
- [ ] Tests
- [ ] Commit

## Global constraints

- Descriptive names; PUT not PATCH; no undefined Dynamo attrs
- CRM Ops must load countries without config screen permission
- createCase already stamps from `findCountryChecklist` — keep that path
