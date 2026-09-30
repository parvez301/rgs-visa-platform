# Unified country documents — Design

**Status:** approved  
**Date:** 2026-09-30  
**Repo:** `rgs`

## 1. Intent

Today two admin surfaces describe “documents this country needs”:

- **Config** — `CountryProduct.docsRequired: DocType[]` (portal upload slots, seed/fallback)
- **Doc checklists** — CRM `CountryChecklist.requiredDocuments: string[]` (New case stamp, marketing merge)

They drift. Desk edits one; marketing/portal read the other.

**Goal:** one list on the country product, edited in Config, read by New case, marketing, and portal.

## 2. Decisions (closed)

| ID | Decision |
|----|----------|
| D1 | Editor lives in **Config → country** drawer. Remove top-level **Doc checklists** nav and route. |
| D2 | Storage is **on `CountryProduct`**. CRM checklist is not the live source after cutover. |
| D3 | Each row is `{ label, portalDocType? }` — free-text label first; optional DocType only for portal uploads. |
| D4 | New case stamps **labels**. Marketing shows **labels**. Portal slots = rows with **`portalDocType`**. |
| D5 | Editing docs requires **Config** write (not CRM-only). |
| D6 | Staging migrate + deploy first; prod only on owner go. |

## 3. Data model

Replace `docsRequired: DocType[]` on `CountryProduct` with:

```ts
requiredDocuments: Array<{
  label: string;           // required; unique per country (trim, case-insensitive)
  portalDocType?: DocType; // optional; applicant upload slot key
}>
```

Rules:

- Fulfilled countries need `requiredDocuments.length > 0`.
- Reject empty/whitespace labels; reject duplicate labels; reject the same `portalDocType` on two rows.
- Drop read-time `requiredDocumentLabels` merge from CRM checklists in `listActiveCountryConfig`.
- Do not persist a parallel `docsRequired` after cutover (migrate then remove from schema / writes).

Shared seed `COUNTRY_PRODUCTS` uses the new shape (each former DocType becomes `{ label: DOC_TYPE_LABELS[t], portalDocType: t }`).

## 4. Admin UI

**Config country drawer**

- Replace DocType checkbox grid with a document list editor:
  - Add: text field + Add
  - Row: label, optional Portal upload dropdown (`—` or DocType), remove, reorder (up/down is enough)
- One Save = existing country product upsert (includes `requiredDocuments`)

**Chrome**

- Remove sidebar **Doc checklists** and `/crm/country-checklists`
- New case empty-state copy points at **Config**

**Permissions**

- Config write owns the list. CRM-only roles no longer edit country docs.

## 5. Runtime consumers

| Consumer | Behavior |
|----------|----------|
| Create case (API) | Resolve destination `CountryProduct`; stamp checklist from `requiredDocuments[].label`. No `findCountryChecklist`. |
| New case drawer | Preview those labels; empty → “Set documents under Config.” |
| Marketing `LiveDocsList` | Render labels via helper on `requiredDocuments` (no CRM merge). |
| Portal Docs step | Slots = `portalDocType` present; same traveller × DocType upload behavior as today. |
| CRM checklist HTTP | Stop serving as live source after cutover (`GET/PUT .../country-checklists` removed or hard-deprecated). |

## 6. Migration

Idempotent one-shot (staging first):

For each country product in Config:

1. Build baseline from current `docsRequired`:  
   `{ label: DOC_TYPE_LABELS[t], portalDocType: t }`
2. If a CRM `CountryChecklist` exists with non-empty labels:
   - Use **checklist order** as the merged list
   - For each label: if it matches a `DOC_TYPE_LABELS` value (case-insensitive), set that `portalDocType`; else label-only
   - Dedupe by normalized label
3. Write `requiredDocuments` onto the product
4. After all products updated and code cut over, checklist rows are orphaned (optional later delete job; not required for correctness)

**CSV Config import/export**

- New format encodes label + optional DocType (exact column syntax chosen in the implementation plan)
- Prefer one-release backward compatibility for old `docsRequired` pipe-of-enums on import if cheap

## 7. Errors & tests

**Validation:** empty label, duplicate label, duplicate `portalDocType`, fulfilled with empty list.

**Must pin:**

- Schema + upsert persist `requiredDocuments`; legacy `docsRequired` not written
- Migrate: docsRequired-only; checklist-only; both (checklist order wins; DocType mapped by label)
- Create case stamps product labels
- Public catalog / marketing helper returns labels
- Portal slots only from `portalDocType`
- Config editor save; Doc checklists route gone
- CSV round-trip for new shape

## 8. Out of scope

- Changing portal upload storage keys beyond reading `portalDocType` from the new field
- Prod deploy / DNS / Cognito
- Rewriting case document checklist *after* stamp (case-local checklist stays as today)
- Deleting Dynamo checklist rows in the same change set (optional follow-up)

## 9. Success

- One Config screen edits country docs
- New case, marketing, and portal agree for a given country
- No Doc checklists page; no live CRM checklist merge
- Staging smoke: Config edit → New case preview/stamp → marketing visa page → portal Docs slots
