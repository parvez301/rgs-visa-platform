# CURSOR-STATUS-2 — catalog scale-out handoff report

Branch: `feat/cursor-handoff-2`  
Worktree: `.worktrees/cursor-handoff-2`  
Base: `50f5fc7` (`fix(api): heal legacy config rows after schema evolution` on main)  
Date: 2026-07-23

## Per-task status

| Task | Status | Commit | Notes |
|---|---|---|---|
| A Config scale-out | done | `bea7a05` | Search, region chips, tier filter, table columns, drawer enums + officialUrl, FULFILLED+empty-docs guard, inactive highlight + awaiting-review count |
| B CSV export/import | done | `c3a9ab8` | `configCsv.ts`; full-field export; schema validate; preview diff + per-row accept; sequential PUT + failure report; no deletes |
| C Queue country names | done | `1413e2f` | Queue fetches `listCountries` and maps `countryCode` → `countryName` (fallback to code) |
| D Travellers date message | done | _(this commit)_ | Map Zod `expected YYYY-MM-DD` → `Enter the date` in TravellersStep |

## Divergences / choices

1. **Queue countries fetch:** Handoff said config was “already fetched on the page for counts”; QueuePage only had application/activity/leads queries. Added an `admin-countries` query (same key as Config) for the name map.
2. **Fee validation in drawer:** Allows `0` for government/service fees (visa-free / ETA rows); day fields still require positive integers.
3. **CSV “new” rows:** Import may PUT product codes not already in the catalog (additions). Deletes are never performed.
4. **Inactive filter chip:** Shows `Inactive (N awaiting review)` when N &gt; 0; subtitle also shows the count.

## Open questions

None new for this handoff. Prior admin download question remains in `docs/REVIEW-QUESTIONS.md` if still open on the older branch.

## Verification run (latest)

- `pnpm --filter @rgs/admin typecheck` — green
- `pnpm --filter @rgs/portal typecheck` — green (Task D)
- `pnpm --filter @rgs/shared test` — 34/34
- `pnpm --filter @rgs/api test` — 45/45
- `pnpm --filter @rgs/admin build` / `@rgs/portal build` — green

## Not done by design

- No `cdk deploy` / no AWS mutations
- No browser E2E against staging
