# CURSOR HANDOFF — RGS Visa Platform (execute this, in order)

You are implementing the remaining features of a working codebase. Claude (another
session) is the reviewer and the only one who deploys. Your job: the tasks in
§4, one commit per task, all checks green. Read §1–§3 fully before writing code.

---

## 1. Context — what this is and what already works

Atlys-style visa platform for Rays Global Services (India-origin travellers).
Monorepo (pnpm), TypeScript strict everywhere. Read these before starting:

- `docs/superpowers/specs/2026-07-23-rgs-visa-platform-design.md` — the spec (source of truth)
- `docs/superpowers/plans/2026-07-23-plan-4-user-portal.md` — portal plan
- `docs/staging-environment.md` — live staging URLs, pool IDs, env values

Already built and DEPLOYED to staging (do not rebuild):

| Piece | Where | State |
|---|---|---|
| Shared core (schemas, status machine, country catalog) | `packages/shared` | 30 tests green |
| Lambda API (applications, documents, admin, config, activity, leads) | `services/api` | 41 tests green |
| Marketing static site | `apps/marketing` | live on CloudFront |
| CDK infra (table, Cognito ×2, HTTP API, marketing hosting) | `infra` | deployed `RgsPlatform-staging`, ap-south-1 |
| Portal scaffold: auth (Cognito SRP), API client, dashboard | `apps/portal` | works against staging |

Commands: `pnpm --filter @rgs/shared test` · `pnpm --filter @rgs/api test` ·
`pnpm --filter @rgs/portal dev` (port 3200, `.env.local` already wired to staging) ·
`pnpm --filter @rgs/marketing build` · `pnpm -r typecheck`

## 2. Hard rules (violations = review rejection)

1. **Descriptive variable names.** Never `res`, `idx`, `cfg`, `e`. Write
   `reviewStatus`, `travellerIndex`, `countryProduct`, `changeEvent`.
2. **Status enums verbatim** from `@rgs/shared` (`DRAFT`…`DELIVERED`,
   `UNPAID`/`REQUESTED`/`PAID_OFFLINE`). Never invent states or transitions —
   the API enforces the machine; the UI renders it.
3. **Country data comes from the API** (`GET /api/v1/config/countries` public,
   `GET /api/v1/admin/config/countries` admin), NEVER hardcoded in UI. The
   static catalog in `@rgs/shared` is seed/fallback only.
4. **No red focus rings on form fields** (owner preference). Follow the
   existing pattern in `apps/portal/src/styles.css` — fields show focus via
   border tint; links/buttons keep the red `:focus-visible` ring.
5. **Design tokens**: use the existing Tailwind theme vars (`rgs-red`, `ink`,
   `mist`, `line`, fonts `font-display`/`font-body`/`mrz` class). Match the
   look of existing pages (`AuthPage.tsx`, `DashboardPage.tsx`, marketing).
6. **No new dependencies** beyond what package.jsons already declare, except
   where a task explicitly lists one.
7. **Never deploy, never run `cdk deploy`, never touch AWS resources.**
   CDK code changes are fine (Task 8/14) — Claude deploys them.
8. **Do not commit `.env*` files** (gitignored — keep it that way).
9. **Tests + typecheck green before every commit**: run
   `pnpm -r typecheck && pnpm --filter @rgs/shared test && pnpm --filter @rgs/api test`.
10. **One commit per task**, message style: `feat(portal): wizard shell with autosave`.
11. If something seems to require changing `packages/shared` enums or the API
    contract: STOP and leave a note in `docs/REVIEW-QUESTIONS.md` instead.

## 3. API surface you build against (stable, deployed)

Base URL (staging): `https://d3yks8h8m1.execute-api.ap-south-1.amazonaws.com`
Auth: `authorization: Bearer <idToken>` from the matching Cognito pool.
The typed client in `apps/portal/src/lib/api.ts` already wraps the user routes —
extend the same pattern for admin.

User routes (users pool JWT): POST/GET `/api/v1/applications`,
GET/PATCH `/api/v1/applications/{id}`, POST `/api/v1/applications/{id}/submit`,
POST `/api/v1/applications/{id}/documents/presign` → `{uploadUrl, objectKey}`,
POST `/api/v1/applications/{id}/documents`,
GET `/api/v1/applications/{id}/documents/download?docType=&travellerIndex=`.
Public: GET `/api/v1/config/countries`, POST `/api/v1/leads`.

Admin routes (admins pool JWT): GET `/api/v1/admin/applications?status=`,
GET `/api/v1/admin/applications/{id}` → `{application, documents}`,
POST `/api/v1/admin/applications/{id}/transition` `{toStatus, userEmail}`,
POST `/api/v1/admin/applications/{id}/payment` `{toPaymentStatus, userEmail}`,
POST `/api/v1/admin/documents/review`
`{applicationId, docType, travellerIndex, decision, userEmail, rejectReason?}`,
POST `/api/v1/admin/applications/{id}/notes` `{noteText}`,
GET `/api/v1/admin/activity[?userId=|?daysBack=]`, GET `/api/v1/admin/leads`,
GET/PUT `/api/v1/admin/config/countries` (PUT body = full CountryProduct),
POST `/api/v1/admin/config/seed`.

Upload flow: presign → HTTP PUT file to `uploadUrl` with matching content-type
(helper `uploadFileToPresignedUrl` exists) → record via POST documents.
Allowed types: image/jpeg, image/png, application/pdf. Max 10 MB (validate client-side).

## 4. Tasks, in order

### Phase A — finish the user portal wizard (`apps/portal`)

**Task 1 — Wizard shell + routing.**
Create `src/pages/wizard/WizardPage.tsx` at route `/apply/:applicationId`
(add to `main.tsx` inside RequireAuth). Full-screen layout: left rail with the
4 steps (Travellers, Docs, Essentials, Review) from `WIZARD_STEPS`, progress %
(completed steps / 4), content area, Back-to-dashboard link. Load application
via `portalApi.getApplication`; current step from `application.stepReached`,
navigable via rail (only to previously reached steps). On every step advance:
`portalApi.patchDraft(... {stepReached})`. If `status !== "DRAFT"`, redirect to
dashboard. Sub-components live in `src/pages/wizard/steps/`.

**Task 2 — Travellers step.** `steps/TravellersStep.tsx`. Form per traveller:
fullName, dateOfBirth, nationality (default IN), passportNumber,
passportIssueDate, passportExpiryDate. Add/remove travellers (1..9).
Validate with `TravellerSchema` from `@rgs/shared` on Continue; inline errors;
warn (non-blocking, amber note) when passportExpiryDate < travel date + 6 months.
Continue = `patchDraft({travellers, stepReached: "docs"})`.

**Task 3 — Docs step.** `steps/DocsStep.tsx`. For each traveller × each
docType in the country's `docsRequired` (from the application's country via
`useQuery(["countries"])` — find by countryCode): an upload card with label
(reuse label map — copy `DOC_TYPE_LABELS` from marketing into
`src/lib/docLabels.ts`), file input (`accept="image/*,application/pdf"`,
`capture` friendly), client-side checks (type in allowed list, ≤ 10 MB),
states: empty → uploading (progress indeterminate) → uploaded (green tick,
re-upload button) → REJECTED (show `rejectReason` in red, re-upload button).
Existing documents come from `getApplication().documents`. Continue enabled
only when every (traveller, docType) slot has a non-REJECTED document;
Continue = `patchDraft({stepReached: "essentials"})`.

**Task 4 — Essentials step.** `steps/EssentialsStep.tsx`. Fields:
intendedTravelDate (date input, min today), purposeOfTravel (select: Tourism,
Business, Family visit, Transit, Other), contactPhone, residentialAddress.
Validate with `ApplicationEssentialsSchema`. Continue =
`patchDraft({essentials, stepReached: "review"})`.

**Task 5 — Review + submit.** `steps/ReviewStep.tsx`. Read-only summary of
travellers, docs (names + ticks), essentials; fee card (govt + service + total
INR, `en-IN` formatting) from the country product; note "No payment now — our
team contacts you after review." Submit button → `portalApi.submitApplication`;
on success show a full-screen confirmation (application id, status timeline,
"Track on dashboard" link). Map API 400s (missing docs) to a readable error box.

**Task 6 — Rejected-doc re-entry.** On dashboard cards with status
`SUBMITTED`, if any document has `reviewStatus === "REJECTED"`, show a red
chip "Action needed — re-upload document" linking to `/apply/{id}` opening
directly at the Docs step in a re-upload-only mode (only rejected slots
enabled; after upload show "Done — our team will re-check"). Note: PATCH is
blocked after submit, so do NOT call patchDraft here — upload endpoints
still work for rejected slots.

### Phase B — admin portal (`apps/admin`, new Vite app)

**Task 7 — Scaffold.** Mirror `apps/portal` structure exactly (Vite, React 19,
Tailwind 4, react-query, react-router, amazon-cognito-identity-js) but:
pool env vars `VITE_ADMINS_POOL_ID` / `VITE_ADMINS_CLIENT_ID` (values in
`docs/staging-environment.md`), port 3300, no self-signup UI (sign-in +
new-password-required challenge only — Cognito admin-created users get a
temporary password; handle `newPasswordRequired` callback in auth).
Dark-accent header (ink background) to visually distinguish from user portal.
Admin API client `src/lib/adminApi.ts` typed for every admin route in §3.

**Task 8 — Queue + detail.** Routes `/` (queue) and `/applications/:id`.
Queue: status tab bar (all 7 statuses + count badge fetched per status),
table rows: id (short), country, travellers count, updatedAt (relative),
paymentStatus chip; row click → detail. Detail page: traveller data table,
documents grid (thumbnail-less cards: docType, traveller, reviewStatus,
View button → admin presigned download — ADD an admin download route? NO:
use `GET /api/v1/admin/applications/{id}` s3Key + a new small API addition is
FORBIDDEN without review — instead leave a "View" button disabled with tooltip
"download in review build" and note it in `docs/REVIEW-QUESTIONS.md`),
Approve / Reject (+ reason dialog) per document via documents/review,
status transition buttons (only legal next statuses per
`LEGAL_STATUS_TRANSITIONS` from shared), payment buttons (Request payment /
Mark paid per current paymentStatus), internal notes list + add box.
Every action → optimistic refetch.

**Task 9 — Activity feed + leads.** Route `/activity`: reverse-chron feed
(daysBack selector 1/2/7), rows: time, eventType chip, userId (short),
applicationId link when present, meta summary. Route `/leads`: table of new
leads (name, phone, topic, message, createdAt). Route `/users/:userId`
activity trail via `?userId=`.

**Task 10 — Config manager.** Route `/config`. Table of all products from
admin config GET: country, fees (govt/service), processing days, stay/validity,
docs count, active toggle. Edit drawer per row: number inputs for fees/days,
multi-checkbox for docsRequired (all 9 DocTypes with labels), active switch;
Save → PUT full CountryProduct object; success toast "Live immediately for
new applications". "Seed catalog" button (POST seed) shown only when list
came from fallback (hint: compare — if PUT ever 200s, seeded). Numbers must
use descriptive `parseInt` handling — no NaN writes.

**Task 11 — Admin metrics tiles.** On queue page top: signups this week,
applications by status (from queue counts), abandoned drafts (DRAFT with
updatedAt > 24h old — computable client-side from DRAFT queue), new leads
count. Simple stat tiles, no chart library.

### Phase C — glue

**Task 12 — Marketing live-config hydration.** In `apps/marketing`, add
`NEXT_PUBLIC_API_URL` env (empty default). In `CountryCard`/country page fee
card/`CountrySearch`: after mount, fetch `/api/v1/config/countries` once
(shared tiny hook `src/lib/useLiveCatalog.ts`, sessionStorage cache) and
overwrite fees/processing days/docs when available. SSG values remain as
fallback. No layout shift beyond number swaps.

**Task 13 — Portal + admin hosting in CDK.** In `infra/lib/rgs-platform-stack.ts`
add two more S3+CloudFront pairs (`rgs-portal-{stage}`, `rgs-admin-{stage}`)
mirroring the marketing pattern BUT with SPA fallback: errorResponses map
403/404 → `/index.html` with 200 (client routing), no directory-index
function needed. BucketDeployments from `apps/portal/dist` and
`apps/admin/dist`. Add CfnOutputs `PortalUrl`, `AdminUrl`. Guard: if `dist`
folders don't exist, `cdk synth` must still work — build both apps first in
your verification, but do NOT deploy.

**Task 14 — E2E happy-path script.** `scripts/e2e-staging.md` — a manual
checklist (not automated): sign up → UAE draft → complete wizard with dummy
files → submit → (admin) approve docs → walk transitions → verify user
timeline. Claude runs this at review time.

## 5. Definition of done / how review works

- After EVERY task: `pnpm -r typecheck` green, both test suites green,
  `pnpm --filter @rgs/marketing build` green (and portal/admin `build` green
  from their tasks onward), committed.
- When all tasks done (or you're blocked): write `docs/CURSOR-STATUS.md` —
  per task: done/blocked, commit hash, anything you diverged on, open
  questions. Claude reviews diffs, runs the suites, drives the e2e checklist
  in a browser against staging, deploys infra changes, and files fixes back
  to you via `docs/REVIEW-FEEDBACK.md`.
