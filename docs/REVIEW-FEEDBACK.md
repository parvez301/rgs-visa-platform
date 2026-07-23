# Review feedback — Cursor handoff batch 1 (2026-07-23)

**Verdict: ACCEPTED and merged to main** (`56b17df`), with two review fixes
applied on top. Good work overall — all 14 tasks landed, verification claims
reproduced exactly (typecheck, 30+41 tests, 3 builds, synth), hard rules held
(naming, shared status machine, config-from-API, no red focus rings,
newPasswordRequired challenge handled).

## Independently verified

- `pnpm -r typecheck` clean · shared 30/30 · api 41/41 (43 after my addition)
- portal / admin / marketing builds green; `cdk synth` green
- Rule greps: no banned identifiers, no static-catalog leakage in UIs,
  transitions rendered from `LEGAL_STATUS_TRANSITIONS`

## Issues found (fixed by reviewer, commit on main)

1. **S3 bucket names missing account suffix** — `rgs-portal-${stage}` /
   `rgs-admin-${stage}` in `infra/lib/rgs-platform-stack.ts` contradicted your
   own divergence note #3 and the uniqueness pattern used everywhere else.
   Bare names risk global-namespace collision at deploy. Fixed to
   `…-${this.account}`. Lesson: when the status report says X, the code must
   say X.

2. **Open question answered — admin document download**: went with your
   option 1. Added `presignDocumentDownloadForAdmin` domain function,
   `GET /api/v1/admin/applications/{id}/documents/download` route, 2 tests,
   admin client method, and enabled the View button (opens in new tab).

## Accepted divergences

All five accepted: step-owned patchDraft, `fullName` lead field, bucket naming
intent (now actually implemented), `@types/node` in infra, no `.env.example`.

## Deployment

Reviewer deployed `RgsPlatform-staging` including portal + admin hosting.
URLs recorded in `docs/staging-environment.md` after deploy.
