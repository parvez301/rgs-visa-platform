# CURSOR-STATUS-3 — notice board, activity redesign, status cards

Branch: `feat/cursor-handoff-3` (main checkout)  
Base: `e7ff29d` (`docs: Cursor handoff 3 — notice board, activity redesign, status cards`)  
Date: 2026-07-24

## Per-task status

| Task | Status | Commit | Notes |
|---|---|---|---|
| A1 Actor + NOTICE_PUBLISHED | done | `073a239` | Optional `actorEmail`/`actorRole`; old rows still parse |
| A2 User profiles + signups | done | `a531c92` | `USER#…/PROFILE`, GSI1 `USERPROFILE`; `POST/GET /me`; `SIGNED_UP` |
| A3 Stamp actors | done | `746e798` | All `logActivity` sites; admin vs app-owner semantics |
| A4 List users | done | `e404b2a` | `GET /api/v1/admin/users` |
| B1 Notice schemas | done | `cb35256` | `NoticeSchema` / `NoticeInputSchema` |
| B2 Notices domain | done | `8aedb75` | PK=`NOTICE`; public projection omits admin fields |
| B3 Notice routes | done | `edc1d5c` | Admin CRUD + public `GET /notices` |
| B4 Marketing hook + MD | done | `59162d1` | `useNotices`, `marked`+`dompurify` (marketing only) |
| B5 Marketing UI | done | `99f65d0` | Home strip, `/notices`, country banner, nav |
| B6 Admin notices | done | `a05d694` | `NoticesPage` + `NoticeEditor` |
| C1 Labels + humanizer | done | `3f7a7d6` | `labels.ts`, `activityHumanizer.ts` |
| C2 Activity timeline | done | `b3ddd37` | Application-first cards + account/platform section |
| C3 User activity | done | `e40c38a` | Profile header + humanized lines |
| D1 Status buckets | done | `ac7096b` | `STATUS_BUCKETS` + `StatusBucket` type in `labels.ts` |
| D2 Bucket cards | done | `6fde70d` | Three `StatusBucketCard`s; Draft idle note |
| D3 Secondary tiles | done | `a1acce3` | Payment / leads / signups; old crammed tile removed |

## Divergences / choices

1. **`STATUS_BUCKETS` landed in C1** (`labels.ts`) and was typed/confirmed in D1 — same constant, remappable per D5.
2. **Admin notice preview** uses a light markdown escape/replace (no new admin deps); marketing uses `marked`+`dompurify` only.
3. **Marketing `PublicNotice`** is a local type in `useNotices.ts` (not exported from `@rgs/shared`).
4. **A3 commit** also picked up untracked `apps/marketing/src/lib/CLAUDE.md` and `packages/shared/src/CLAUDE.md` via earlier `git add -A` — leftover from prior session; not part of the handoff spec.
5. **No “Raw feed” toggle** on Activity (optional in C2).

## Open questions

None written to `docs/REVIEW-QUESTIONS.md` for this handoff.

## Verification run (latest)

- `pnpm -r typecheck` — green
- `pnpm --filter @rgs/shared test` — 41/41
- `pnpm --filter @rgs/api test` — 56/56
- `pnpm --filter @rgs/admin build` / marketing typecheck — green

## Not done by design

- No `cdk deploy` / no AWS mutations / no push (local Cursor working tree)
- No browser E2E against staging (manual smoke left for Claude review)
