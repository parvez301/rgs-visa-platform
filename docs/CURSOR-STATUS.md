# CURSOR-STATUS — handoff execution report

Branch: `feat/cursor-handoff`  
Worktree: `.worktrees/cursor-handoff`  
Base: `bc86b3d` (docs handoff)  
Date: 2026-07-23

## Per-task status

| Task | Status | Commit | Notes |
|---|---|---|---|
| 1 Wizard shell + routing | done | `090d4b8` | Placeholders for steps 2–5; step components own `patchDraft` |
| 2 Travellers step | done | `4a0ac0a` | TravellerSchema + passport &lt; travel+6m amber warning |
| 3 Docs step | done | `470a934` | `docLabels.ts`; upload card states; `reuploadOnly` prop ready |
| 4 Essentials step | done | `dbc37b1` | ApplicationEssentialsSchema |
| 5 Review + submit | done | `00f1703` | Full-screen confirmation overlay; API 400 → error box |
| 6 Rejected-doc re-entry | done | `76fc499` | Dashboard chip; SUBMITTED + REJECTED opens docs re-upload mode |
| 7 Admin scaffold | done | `e4d277b` | Port 3300; newPasswordRequired; typed `adminApi` |
| 8 Queue + detail | done | `1324dca` | View download disabled; see REVIEW-QUESTIONS |
| 9 Activity + leads | done | `6ae0723` | `/activity`, `/leads`, `/users/:userId` |
| 10 Config manager | done | `15813fd` | Edit drawer + seed button until first successful PUT |
| 11 Metrics tiles | done | `c22e267` | Signups / status strip / abandoned drafts / leads |
| 12 Marketing live-config | done | `1e15f86` | `useLiveCatalog` + CountryCard/Search/visa fee+docs hydration |
| 13 Portal+admin CDK | done | `d6bda00` | SPA 403/404→index.html; PortalUrl/AdminUrl; dist guard |
| 14 E2E checklist | done | _(this commit)_ | `scripts/e2e-staging.md` |

## Divergences / choices

1. **Wizard advance ownership:** Step components call `patchDraft({…, stepReached})`; shell only invalidates queries and switches `activeStep` (avoids double PATCH).
2. **Lead field name:** API uses `fullName` (not handoff’s `name`) — admin leads table matches API.
3. **S3 bucket names:** `rgs-portal-{stage}-{account}` / `rgs-admin-{stage}-{account}` (same uniqueness pattern as marketing), not bare `rgs-portal-{stage}`.
4. **`@types/node` added** under infra so `pnpm -r typecheck` and `cdk synth` are green (was pre-broken on main).
5. **Marketing `.env.example`:** blocked by `.gitignore` `.env.*` — set `NEXT_PUBLIC_API_URL` locally; empty default keeps SSG fallback.

## Open questions

See `docs/REVIEW-QUESTIONS.md` — primarily admin document download route.

## Verification run (latest)

- `pnpm -r typecheck` — green (all packages)
- `pnpm --filter @rgs/shared test` — 30/30
- `pnpm --filter @rgs/api test` — 41/41
- `pnpm --filter @rgs/portal build` / `@rgs/admin build` / `@rgs/marketing build` — green
- `cdk synth` — green (no deploy)

## Not done by design

- No `cdk deploy` / no AWS mutations
- No admin file download (awaiting review decision)
- E2E not browser-executed (Claude’s review step)
