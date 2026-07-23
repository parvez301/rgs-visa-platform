# CURSOR HANDOFF 2 — catalog scale-out, admin side (2026-07-23)

Read `docs/CURSOR-HANDOFF.md` §1–§2 first — same rules, same review flow.
Context: the shared catalog now has 34 products with new fields
(`region`, `tier`, `officialUrl`) and 26 research-batch countries seeded
`active:false` + `INFO_ONLY` (see `docs/research/2026-07-23-batch-1-countries.md`).
Claude already shipped: portal searchable tier-aware picker, marketing region
grouping + generated content fallback, API applyability guard.

## Task A — admin Config screen scale-out
`apps/admin/src/pages/ConfigPage.tsx`:
1. Search box filtering by country name/code; region filter chips; tier filter
   (All / Fulfilled / Info only / Inactive).
2. Table columns: country, region, tier badge, visaType, fees, processing,
   active dot. Sort: active first, then name.
3. Edit drawer: add selects for `region`, `tier`, `visaType` (all enum values
   from @rgs/shared), input for `officialUrl` (show as clickable link too).
   Guard rails: activating a FULFILLED row with empty docsRequired must be
   blocked client-side with a clear message (API refuses it anyway).
4. "Review queue" affordance: rows that are `active:false` get a subtle
   highlight + count in the tab bar ("26 awaiting review").

## Task B — CSV export/import in Config
- Export: client-side CSV of the full catalog (all fields; docsRequired as
  `|`-joined). Filename `rgs-country-config-YYYY-MM-DD.csv`.
- Import: file input parsing the same format; validate each row with
  `CountryProductSchema` client-side; show a preview diff table (changed rows
  highlighted) with per-row accept; on confirm, PUT sequentially with progress;
  report failures per row. No deletes via import.

## Task C — admin queue country names
Queue table shows raw `countryCode`; map to `countryName` via the config list
(already fetched on the page for counts).

## Task D — cosmetic
Date-field schema messages leak "expected YYYY-MM-DD" into the portal
Travellers form errors — map that message to "Enter the date" in the form's
error display (portal, `TravellersStep.tsx`).

Definition of done: same as handoff 1 (typecheck + suites green, builds green,
one commit per task, `docs/CURSOR-STATUS-2.md` report). No deploys.
