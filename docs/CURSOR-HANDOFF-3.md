# CURSOR HANDOFF 3 — Notice Board · Activity Redesign · Status Cards

You are implementing three owner-requested features on a working, deployed codebase.
Claude (another session) is the reviewer and the **only** one who deploys. Your job:
the tasks in §6–§9, **one commit per task**, all checks green. Read §1–§5 fully
before writing any code. This document is both the design spec and the execution plan.

> Workflow reminder: same as HANDOFF 1 & 2. Work on a branch
> `feat/cursor-handoff-3`. Never deploy, never run `cdk deploy`, never touch AWS.
> If a task seems to require changing a `@rgs/shared` enum or the API contract in a
> way not described here, STOP and write a note in `docs/REVIEW-QUESTIONS.md`.

---

## 1. What the owner asked for (verbatim intent)

1. **Notice board** — a place to post visa rule changes (per country) and general
   announcements. Must look good on the marketing site AND be fully managed from the
   admin portal.
2. **Activity page is cluttered** — today it's a raw event dump; the admin cannot tell
   *which user is doing/requesting what* on the user portal. Make it legible and useful.
3. **Status card is confusing** — every application status is clubbed into one tile.
   Break it out so "how many created / draft / completed / …" is obvious at a glance.

## 2. Design decisions (already chosen — build to these)

| # | Decision | Chosen option |
|---|----------|---------------|
| D1 | Notice placement on marketing | Dedicated `/notices` page **+** "Latest updates" strip on home **+** country-tagged notices auto-appear on that country's `/visa/[slug]` page |
| D2 | Notice content model | **Structured**: title, category, optional country tag, severity (drives color), rich body (Markdown subset), pin-to-top, optional auto-expire date |
| D3 | Activity page primary lens | **Application-first timeline** — group events per application, with a separate section for account/system events not tied to an application |
| D4 | Status card layout | **Grouped buckets** (Needs action / In progress / Done), each expandable to per-status counts; payment / leads / signups become their own small tiles |

**Decisions I made for you that need owner sign-off on review** (implement as written;
Claude will confirm with the owner and flag any change):

- **D5 — Status bucket membership** (§9). Coded as a single `STATUS_BUCKETS` constant so
  it is a one-line change if the owner wants a status moved.
- **D6 — Markdown rendering** uses `marked` + `dompurify` with a tight allowlist (§7.5).
  These are the only new dependencies this handoff introduces.
- **D7 — Identity foundation** (§6): user profiles are now persisted and events are
  stamped with the actor's email/role. Without this the activity page cannot show names.

## 3. Read-first: current architecture (do not rebuild)

Monorepo (pnpm), TypeScript strict everywhere. Ports-and-adapters API on a single
DynamoDB table. Marketing is a **Next 15 static export** that fetches live data
client-side (no SSR at request time). Admin is a **Vite + react-router + TanStack Query** SPA.

| Piece | Where | Notes |
|---|---|---|
| Shared schemas / enums / status machine | `packages/shared/src/{schemas,statuses,statusMachine}.ts` | source of truth for types |
| Lambda API | `services/api/src/{domain,http,lib}` | `Router` in `http/router.ts`; user routes `http/userApi.ts`, admin routes `http/adminApi.ts` |
| Single table client | `services/api/src/lib/db.ts` | `query`, `get`, `put`, `queryGsi('GSI1'|'GSI2'|'GSI3', ...)` |
| Activity logging | `services/api/src/lib/context.ts` → `logActivity(...)` | writes `EVENT#{day}` partition + `GSI2 USER#{userId}` |
| Admin SPA pages | `apps/admin/src/pages/*` | `QueuePage`, `ActivityPage`, `UserActivityPage`, `ConfigPage`, `LeadsPage` |
| Admin API client | `apps/admin/src/lib/adminApi.ts` | typed `fetch` wrapper |
| Admin nav/shell | `apps/admin/src/components/AdminShell.tsx`, routes in `apps/admin/src/main.tsx` | |
| Marketing live-data pattern | `apps/marketing/src/lib/useLiveCatalog.ts` | **copy this pattern** for notices (fetch + sessionStorage cache) |
| Marketing pages/components | `apps/marketing/src/app/*`, `apps/marketing/src/components/*` | home = `app/page.tsx`; country = `app/visa/[slug]/page.tsx` |

**Table key patterns already in use** (match them):
- Country config: `PK=CONFIG#COUNTRY`, `SK={countryCode}#{productCode}` (see `domain/config.ts` — your template for notices).
- Application: `PK=USER#{userId}`, `SK=APP#{applicationId}`; GSIs: `GSI1=STATUS#{status}`, `GSI3=APP#{applicationId}`.
- Activity event: `PK=EVENT#{yyyy-mm-dd}`, `SK={iso}#{eventId}`, `GSI2=USER#{userId}`.

**Commands** (must all pass before every commit):
```
pnpm -r typecheck
pnpm --filter @rgs/shared test
pnpm --filter @rgs/api test
pnpm --filter @rgs/marketing build     # for marketing tasks
pnpm --filter @rgs/admin build         # for admin tasks
```
Dev: `pnpm --filter @rgs/marketing dev` · `pnpm --filter @rgs/admin dev` · env already wired to staging in each app's `.env.local` / `.env`.

## 4. Hard rules (violations = review rejection)

1. **Descriptive variable names.** Never `res`, `idx`, `cfg`, `e`, `n`. Write
   `noticeRecord`, `travellerIndex`, `activityEvent`, `statusBucket`.
2. **Status/enum values verbatim** from `@rgs/shared`. Never invent statuses or transitions.
3. **All dynamic data comes from the API**, never hardcoded in UI. Country names come from
   the live config (`countryNameByCode` map — see `QueuePage.tsx`).
4. **No red focus rings on form fields** (owner preference). Follow the existing pattern
   in the admin styles / existing inputs; the notice editor inputs must obey it.
5. **Design tokens only**: reuse the existing Tailwind theme vars/classes
   (`rgs-red`, `ink`, `ink-soft`, `paper`, `mist`, `line`, `font-display`, `mrz`).
   Match the look of `QueuePage.tsx`, `ConfigPage.tsx`, and the marketing components.
6. **No new dependencies** except the two named in D6 (`marked`, `dompurify`), and only in
   `apps/marketing`. Nothing else.
7. **Never deploy / never touch AWS.** No CDK changes are required by this handoff
   (see §5 — we reuse existing GSIs). If you think you need a new GSI or table change, STOP
   and write it in `docs/REVIEW-QUESTIONS.md`.
8. **Do not commit `.env*` files.**
9. **Tests + typecheck green before every commit.** Do not break the existing suites
   (`@rgs/shared` and `@rgs/api` are currently green).
10. **One commit per task**, message style `feat(admin): notices management page`.
11. **Backward compatibility:** existing activity events in the DB were written WITHOUT the
    new `actorEmail`/`actorRole` fields. Every schema change must keep parsing old rows
    (make new fields `.optional()`), and the UI must render gracefully when they're absent.

## 5. Storage plan (no infra change)

Everything below fits the existing table and existing GSIs. **No CDK change, so Claude
only redeploys the Lambda + the two static sites.** Reused key patterns:

| New item | PK | SK | GSI attrs (reuse existing GSIs) |
|---|---|---|---|
| Notice | `NOTICE` | `{createdAt}#{noticeId}` | none needed (small volume; list partition + sort/filter in code) |
| User profile | `USER#{userId}` | `PROFILE` | `GSI1PK=USERPROFILE`, `GSI1SK={createdAt}` → enables "list all users" via `queryGsi('GSI1','USERPROFILE')` |

> Verify the exact GSI attribute names (`GSI1PK`/`GSI1SK`) in `services/api/src/lib/db.ts`
> and `domain/applications.ts` (`applicationToItem`) before writing profiles, and mirror them.
> The `USERPROFILE` GSI1 partition cannot collide with the application `STATUS#…` partitions.

---

## 6. WORKSTREAM A — Identity foundation (do FIRST; C depends on it)

Goal: make it possible to say **"Priya Sharma (priya@…) submitted a UAE application"**
instead of `SUBMITTED user=1a2b3c…`. Two parts: persist a user profile, and stamp the
acting person's email/role onto every event.

### Task A1 — Extend the activity event with actor identity (`packages/shared`)
`packages/shared/src/statuses.ts`:
- Add event types to `ACTIVITY_EVENT_TYPES`: `"NOTICE_PUBLISHED"` (used by Workstream B).
- Add `export const ACTIVITY_ACTOR_ROLES = ["user","admin","system"] as const;` + type.

`packages/shared/src/schemas.ts` — extend `ActivityEventSchema`:
```ts
actorEmail: z.string().email().optional(),
actorRole: z.enum(ACTIVITY_ACTOR_ROLES).optional(),
```
Keep them optional so old rows still parse. Export nothing else new here.

**Tests** (`packages/shared/test`): an event WITHOUT `actorEmail`/`actorRole` still parses;
an event WITH them parses; a bad `actorRole` fails.

### Task A2 — Persist user profiles + log real signups (`services/api`)
New file `services/api/src/domain/users.ts`:
- `PROFILE_SORT_KEY = "PROFILE"`.
- `ensureUserProfile(context, userId, email, extra?: { fullName?; phone? }): Promise<User>`
  - `get(PK=USER#{userId}, SK=PROFILE)`. If it exists, return it.
  - If missing: build `User` (`fullName` = `extra.fullName ?? email.split("@")[0]`,
    `phone` = `extra.phone ?? ""` — **note:** `UserSchema.phone` currently requires
    `min(8)`; relax it to `z.string().default("")` in `schemas.ts` so email-only signups are
    valid, OR store `phone` optional. Pick optional; update `UserSchema` accordingly and its
    test). Set `createdAt = context.now()`.
  - `put({ PK:USER#{userId}, SK:PROFILE, GSI1PK:"USERPROFILE", GSI1SK:createdAt, ...profile })`.
  - `logActivity(context, "SIGNED_UP", userId, undefined, { email }, { actorEmail: email, actorRole: "user" })` — only on first creation.
  - Return the profile.
- `getUserProfile(context, userId): Promise<User | null>`.
- `listUserProfiles(context): Promise<User[]>` via `queryGsi("GSI1","USERPROFILE")`.

Wire it in:
- In `domain/applications.ts` → `createDraft(...)`, call `ensureUserProfile(context, userId, email)`
  at the top. This means `createDraft` must receive the caller email — thread
  `email` from `userApi.ts` (the `requireUser` result already has it) into `createDraft`.
- Add routes in `http/userApi.ts`:
  - `POST /api/v1/me` → body `{ fullName?, phone? }` (optional) → `ensureUserProfile(context, callerId, callerEmail, body)` → returns the profile. (Portal may call this right after sign-in; safe to call repeatedly.)
  - `GET /api/v1/me` → `getUserProfile` (or ensure+return) → returns the profile.

**Tests** (`services/api/test`): `ensureUserProfile` is idempotent (second call does not
re-log `SIGNED_UP` and does not overwrite `createdAt`); `listUserProfiles` returns created
profiles; `createDraft` creates a profile the first time.

### Task A3 — Stamp actor identity on all `logActivity` calls (`services/api`)
Change `logActivity` signature in `lib/context.ts` to accept an optional actor:
```ts
export async function logActivity(
  context, eventType, userId, applicationId,
  meta = {},
  actor?: { actorEmail?: string; actorRole?: "user" | "admin" | "system" },
)
```
Persist `actorEmail`/`actorRole` into both the stored item and the returned event (omit keys when undefined, like `applicationId`).

Update every call site to pass the correct actor — **the actor is who performed it, which
is NOT always `event.userId`** (admin actions act on a user's application):
- `domain/applications.ts` (`APPLICATION_STARTED`, `STEP_COMPLETED`, `SUBMITTED`): actor `{ actorEmail: <caller email>, actorRole:"user" }`. Thread caller email into these fns (submit already has `userEmail`; add `email` to the others).
- `domain/documents.ts` (`DOC_UPLOADED`): actor is the user → thread caller email; `actorRole:"user"`.
- `domain/admin.ts` (`STATUS_CHANGED`, `DOC_REVIEWED`, payment events): actor is the **admin**. These fns already receive `adminId`; **also thread `adminEmail`** from `requestContext.callerEmail` (update the router calls in `adminApi.ts` to pass it). Set `{ actorEmail: adminEmail, actorRole:"admin" }`. Keep `event.userId` = the application owner (unchanged) so the event still attaches to the owner's timeline.
- `domain/leads.ts` (`LEAD_CREATED`): `{ actorRole:"system" }`, no email.
- `domain/config.ts` (`CONFIG_CHANGED`): actor = admin; thread `adminEmail`; `actorRole:"admin"`.

Also **enrich meta where the humanizer needs it** (Task C2 depends on these keys existing):
- `APPLICATION_STARTED` meta must include `{ countryCode }`.
- `SUBMITTED` meta must include `{ countryCode }`.
- `STEP_COMPLETED` meta must include `{ step }`.
- `DOC_UPLOADED` meta must include `{ docType, travellerIndex }`.
- `STATUS_CHANGED` meta must include `{ fromStatus, toStatus }`.
Read each call site and add any missing key; do not remove existing keys.

**Tests:** a user action event carries `actorRole:"user"` + email; an admin status change
carries `actorRole:"admin"` + admin email while `userId` stays the application owner.

### Task A4 — Admin "list users" endpoint (`services/api`)
`http/adminApi.ts`: add `GET /api/v1/admin/users` → `requireAdmin` → `listUserProfiles(context)`.
This powers the activity page's `userId → {fullName,email}` resolution.

---

## 7. WORKSTREAM B — Notice board

### Task B1 — Notice schema (`packages/shared`)
`statuses.ts`:
```ts
export const NOTICE_CATEGORIES = ["RULE_CHANGE","FEE_UPDATE","GENERAL","ALERT"] as const;
export const NOTICE_SEVERITIES = ["INFO","IMPORTANT","URGENT"] as const;
export const NOTICE_STATUSES   = ["DRAFT","PUBLISHED","ARCHIVED"] as const;
// + exported types for each
```
`schemas.ts`:
```ts
export const NoticeSchema = z.object({
  noticeId: z.string().min(1),
  title: z.string().trim().min(3).max(140),
  body: z.string().min(1).max(8000),            // Markdown (restricted subset, see B4/7.5)
  category: z.enum(NOTICE_CATEGORIES),
  severity: z.enum(NOTICE_SEVERITIES),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(), // omit = global/all-countries
  pinned: z.boolean().default(false),
  status: z.enum(NOTICE_STATUSES).default("DRAFT"),
  publishedAt: isoDateTime.optional(),          // set the first time status becomes PUBLISHED
  expiresAt: isoDate.optional(),                // public hides after this date; admin still sees it
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  createdByEmail: z.string().email().optional(),
});
export type Notice = z.infer<typeof NoticeSchema>;
// Input for create/update (server fills ids/timestamps/publishedAt):
export const NoticeInputSchema = NoticeSchema.pick({
  title:true, body:true, category:true, severity:true, countryCode:true, pinned:true, status:true, expiresAt:true,
}).extend({ noticeId: z.string().optional() });
```
**Tests:** valid notice parses; title < 3 fails; bad `countryCode` fails; `pinned`/`status` defaults apply.

### Task B2 — Notices domain (`services/api/src/domain/notices.ts`)
Template: `domain/config.ts`. `NOTICE_PARTITION_KEY = "NOTICE"`, `noticeSortKey(createdAt, noticeId)`.
- `listNotices(context): Promise<Notice[]>` — all rows, newest first (sort by `createdAt` desc).
- `listPublicNotices(context, opts?: { countryCode?: string }): Promise<Notice[]>`
  - only `status === "PUBLISHED"`; drop where `expiresAt` present and `< today` (`context.now()`).
  - if `opts.countryCode` given → keep notices whose `countryCode === opts.countryCode` **or** is undefined (global). No filter otherwise.
  - sort: **pinned first**, then `publishedAt` desc (fallback `createdAt`).
  - **Return a public projection**, not the raw row: omit internal fields
    `createdByEmail`, `status`, `updatedAt` (they must not reach the marketing site).
    Keep `noticeId, title, body, category, severity, countryCode?, pinned, publishedAt, createdAt, expiresAt?`.
- `upsertNotice(context, adminEmail, input: unknown): Promise<Notice>`
  - `NoticeInputSchema.parse`; `noticeId = input.noticeId ?? newId("ntc", now)`.
  - load existing (if `noticeId` given) to preserve `createdAt`/`publishedAt`.
  - `publishedAt`: set to now the first time `status` transitions to `PUBLISHED` and it isn't already set.
  - `updatedAt = now`; `createdByEmail` set on first create.
  - `put({ PK, SK: noticeSortKey(createdAt, noticeId), ...notice })`.
  - if the resulting status is `PUBLISHED`, `logActivity(context, "NOTICE_PUBLISHED", adminEmail, undefined, { noticeId, title, countryCode? }, { actorEmail: adminEmail, actorRole:"admin" })`.
    (Use `adminEmail` as the `userId` for this system-ish event; it has no application.)
  - return the notice.
- `deleteNotice(context, noticeId): Promise<void>` — find the row (scan the `NOTICE` partition for matching `noticeId` since SK embeds `createdAt`), then delete by its real PK/SK.

**Tests:** upsert on create sets `createdAt`/`updatedAt`; publishing sets `publishedAt` once and does not move it on later edits; `listPublicNotices` excludes DRAFT/ARCHIVED and expired; country filter returns country-specific + global; pinned sorts first.

### Task B3 — Notice routes (`services/api/src/http`)
- Admin (`adminApi.ts`): `GET /api/v1/admin/notices` → `listNotices`; `PUT /api/v1/admin/notices` → `upsertNotice(context, requestContext.callerEmail, body)`; `DELETE /api/v1/admin/notices/{noticeId}` → `deleteNotice`.
- Public (`userApi.ts`, no auth — sits next to `GET /api/v1/config/countries`): `GET /api/v1/notices` → `listPublicNotices(context, { countryCode: queryParams.countryCode })`.

### Task B4 — Marketing: data hook + Markdown renderer (`apps/marketing`)
- `src/lib/useNotices.ts` — copy `useLiveCatalog.ts` (sessionStorage cache, in-flight dedupe, `NEXT_PUBLIC_API_URL`), but fetch `/api/v1/notices` (optionally `?countryCode=XX`). Export `useNotices(countryCode?)` returning `Notice[] | null`. **Key the sessionStorage cache and the in-flight promise by scope** (`rgs.notices.all` vs `rgs.notices.{countryCode}`) so the country banner and the `/notices` page don't overwrite each other's data.
- `src/lib/renderNoticeBody.ts` — add deps `marked` + `dompurify` to `apps/marketing/package.json`. Parse Markdown with `marked` then sanitize with `dompurify` using a **tight allowlist**: `ALLOWED_TAGS = ['p','br','strong','em','ul','ol','li','a']`, `ALLOWED_ATTR = ['href','target','rel']`; force `a` to `target="_blank" rel="noopener noreferrer"`. Return sanitized HTML string for `dangerouslySetInnerHTML`. These are client components, so `dompurify` runs in the browser.

### Task B5 — Marketing: presentation (`apps/marketing`)
- `src/components/NoticeBadge.tsx` — small pill for category + severity (severity drives color: INFO = neutral/blue, IMPORTANT = amber, URGENT = red `rgs-red`). Reused everywhere.
- `src/components/NoticeCard.tsx` — title, badges, country name (resolve via existing catalog/`countryContent`), relative date, rendered body. Pinned notices show a "Pinned" marker.
- `src/components/HomeNoticesStrip.tsx` — client component; `useNotices()`; render up to 4 (pinned first) as a compact "Latest visa updates" panel; "See all updates →" links to `/notices`; render nothing if the list is empty (no empty box). Insert it into `src/app/page.tsx` in a sensible spot (e.g., after `HowItWorks`/before `CtaBand` — match existing section rhythm).
- `src/app/notices/page.tsx` — new route; static shell + client fetch of all published notices; filter controls (by country, by category); list of `NoticeCard`. Add "Notices" to the header nav (`SiteHeader.tsx`) and footer (`SiteFooter.tsx`).
- `src/components/CountryNoticeBanner.tsx` — client component used inside `src/app/visa/[slug]/page.tsx`; `useNotices(countryCode)`; renders country-specific + global notices as banner(s) near the top of the country page; hidden when none.

**Check:** `pnpm --filter @rgs/marketing build` (static export) succeeds with the new `/notices` route and the client components.

### Task B6 — Admin: notice management (`apps/admin`)
- `src/lib/adminApi.ts` — add `listNotices`, `upsertNotice`, `deleteNotice` (mirror the config methods; import `Notice` type from `@rgs/shared`).
- `src/pages/NoticesPage.tsx` — table (Title · Country · Category · Severity · Status · Updated) + "New notice" button; clicking a row or "New" opens the editor.
- `src/components/NoticeEditor.tsx` — fields: title, category `<select>`, severity `<select>`, country `<select>` (optional "All countries", options from `adminApi.listCountries`), pinned checkbox, `expiresAt` date (optional), status `<select>` (Draft/Published/Archived), body `<textarea>` (Markdown) with a **live preview** pane (reuse the same sanitize allowlist — you may add a tiny local sanitize util in admin, or accept plain preview; do NOT add new deps to admin — render preview by escaping + basic replacement, or show raw Markdown). Save → `upsertNotice`; Delete → confirm inline (no `window.confirm` dialog — use an in-page confirm state) → `deleteNotice`. Obey hard rule #4 (no red focus ring on inputs).
- Nav: add "Notices" link in `AdminShell.tsx`; add the route(s) in `main.tsx`.
- Invalidate the `["admin-notices"]` query key on save/delete.

**Check:** `pnpm --filter @rgs/admin build` succeeds; create → publish → see it via the public endpoint.

---

## 8. WORKSTREAM C — Activity page redesign (application-first)

Depends on Workstream A (profiles + `actorEmail`). Rewrite `apps/admin/src/pages/ActivityPage.tsx`
into an application-first timeline, plus a section for account/system events.

### Task C1 — Shared admin label/humanizer helpers (`apps/admin/src/lib/`)
- `labels.ts`: `STATUS_LABELS: Record<ApplicationStatus,string>` (`DRAFT→"Draft"`,
  `SUBMITTED→"Submitted"`, `DOCS_VERIFIED→"Docs verified"`,
  `SENT_TO_IMMIGRATION→"At immigration"`, `APPROVED→"Approved"`, `REJECTED→"Rejected"`,
  `DELIVERED→"Delivered"`), `DOC_LABELS: Record<DocType,string>`, and
  `PAYMENT_LABELS: Record<PaymentStatus,string>`. Reuse these in QueuePage too (Workstream D).
- `activityHumanizer.ts`: `eventToSentence(event, ctx): { icon: string; text: string }`
  where `ctx` gives `{ countryNameByCode, userNameById }`. Map each `eventType` using the
  meta keys guaranteed in Task A3. Examples (align exactly to real meta keys — read the
  call sites):

  | eventType | rendered text |
  |---|---|
  | `SIGNED_UP` | `{actor} created an account` |
  | `APPLICATION_STARTED` | `started a {Country} application` |
  | `STEP_COMPLETED` | `completed the {step} step` |
  | `DOC_UPLOADED` | `uploaded {DocLabel} (traveller {n+1})` |
  | `DOC_REVIEWED` | `admin {decision} {DocLabel} (traveller {n+1})` |
  | `SUBMITTED` | `submitted the {Country} application` |
  | `STATUS_CHANGED` | `status: {StatusLabel(from)} → {StatusLabel(to)} (by admin)` |
  | `PAYMENT_REQUESTED` | `admin requested payment` |
  | `PAYMENT_MARKED_PAID` | `admin marked payment received` |
  | `LEAD_CREATED` | `new website enquiry: {topic}` |
  | `CONFIG_CHANGED` | `admin updated {Country} config` |
  | `NOTICE_PUBLISHED` | `admin published notice: {title}` |

  `{actor}` resolves from `userNameById.get(event.userId)?.fullName ?? event.actorEmail ?? short(userId)`.
  Include a small `[user]`/`[admin]`/`[system]` tag derived from `event.actorRole`.

### Task C2 — Rewrite `ActivityPage.tsx`
Data (TanStack Query, `enabled: idToken!==null`):
- recent activity for the window (default 7d) — `adminApi.listActivity(idToken,{daysBack})`.
- all applications across statuses — reuse the `useQueries` multi-status pattern from `QueuePage.tsx`.
- users — new `adminApi.listUsers(idToken)` → build `userNameById: Map<userId, User>`.
- countries — `adminApi.listCountries` → `countryNameByCode` (as in QueuePage).

Render:
1. **Controls row**: search box (matches user name/email or country), event-type filter
   (multiselect or "all"), time window `1 / 7 / 30d` (reuse the pill pattern).
2. **By application** (primary): group filtered events by `applicationId`. For each
   application (sorted by most-recent event desc) render an **ApplicationTimelineCard**:
   - header: Country name · owner `fullName` + `email` (from the app's `userId` → profile) ·
     current `status` chip (via `STATUS_LABELS`) · `paymentStatus` chip · updated relative time ·
     a link to `/applications/{id}` and `/users/{userId}`.
   - body: vertical mini-timeline of that app's events, each = icon + `eventToSentence` text +
     actor tag + relative time, newest first.
3. **Account & platform events** (secondary section): events with **no** `applicationId`
   (`SIGNED_UP`, `LEAD_CREATED`, `CONFIG_CHANGED`, `NOTICE_PUBLISHED`) humanized as single lines.
4. Empty states for each section.

Optional (leave if time-boxed): a "Raw feed" toggle that shows the old flat list — nice for
debugging but not required.

### Task C3 — Refresh `UserActivityPage.tsx`
Add a profile header (fullName + email from `adminApi.listUsers` or a `getUser` call) and
render each event via `eventToSentence` (reuse C1). Keep the "← Back to activity" link.

---

## 9. WORKSTREAM D — Status cards (grouped buckets) in `QueuePage.tsx`

Replace the current 4-tile `MetricTile` block (the crammed "Applications by status" tile)
with grouped buckets + secondary tiles. Keep the table and the status filter tabs below.

### Task D1 — Bucket model (D5 — confirm on review)
Add a single constant (top of `QueuePage.tsx` or `lib/labels.ts`):
```ts
export const STATUS_BUCKETS = [
  { key:"NEEDS_ACTION", label:"Needs your action", accent:"attention",
    statuses:["SUBMITTED","DOCS_VERIFIED","APPROVED"] },        // admin must act next
  { key:"IN_PROGRESS", label:"In progress", accent:"neutral",
    statuses:["DRAFT","SENT_TO_IMMIGRATION"] },                  // waiting on user or govt
  { key:"DONE", label:"Done", accent:"positive",
    statuses:["DELIVERED","REJECTED"] },
] as const;
```
Rationale for the owner: buckets are organised by **who owes the next step**, not raw order,
so "Needs your action" is the admin's real work queue. One-line change to re-map.

### Task D2 — Render buckets
- Three `StatusBucketCard`s in a row. Each shows: the bucket label, a big **total** (sum of
  its statuses' counts), and a list of `StatusLabel — count` sub-rows. Each sub-row is a
  button that calls `setSelectedStatus(status)` (drives the existing table filter) — reuse
  the counts already computed in `countsByStatus`.
- On the DRAFT sub-row (In progress bucket), append the existing `abandonedDraftCount` as a
  muted note: `Draft — 12  ·  3 idle >24h`.
- Accent maps to existing tokens (attention = `rgs-red`/amber tint, positive = emerald, neutral = ink/mist) — subtle left border or heading color, consistent with existing cards.

### Task D3 — Secondary tiles row
Below the buckets, a small tile row:
- **Payment** — compute from `allApplications` (already flat-mapped): `Unpaid n · Requested n · Paid n` using `PAYMENT_LABELS`.
- **New leads** — `newLeadsCount` (existing).
- **Signups this week** — `signupsThisWeek` (existing; now actually populated because A2 logs `SIGNED_UP`).

Keep the `StatusTab` filter row and the applications table exactly as they work today.
Delete the old crammed `MetricTile` "Applications by status" usage.

---

## 10. Test & quality gates

- `@rgs/shared`: new tests for `NoticeSchema`, extended `ActivityEventSchema` (old rows parse),
  relaxed `UserSchema.phone`.
- `@rgs/api`: new tests for `domain/notices.ts` and `domain/users.ts`; updated activity tests
  asserting `actorRole`/`actorEmail`. **Do not break the existing suites.**
- Front-ends: `pnpm --filter @rgs/marketing build` and `pnpm --filter @rgs/admin build` must
  pass; `pnpm -r typecheck` clean.
- Manual smoke (against staging via the dev servers): admin creates + publishes a UAE notice
  → appears on marketing home strip, `/notices`, and `/visa/uae`; a portal signup then draft
  shows a named entry in the activity timeline; QueuePage buckets show correct per-status counts.

## 11. Suggested commit sequence (one per task)

```
A1  feat(shared): actor identity + NOTICE_PUBLISHED on activity events
A2  feat(api): persist user profiles and log real signups
A3  feat(api): stamp actor email/role on all activity events
A4  feat(api): admin list-users endpoint
B1  feat(shared): notice schema and input schema
B2  feat(api): notices domain (list/public/upsert/delete)
B3  feat(api): notice routes (admin CRUD + public read)
B4  feat(marketing): notices data hook and markdown renderer
B5  feat(marketing): notice board UI (home strip, /notices, country banner)
B6  feat(admin): notices management page and editor
C1  feat(admin): status labels and activity humanizer helpers
C2  feat(admin): application-first activity timeline
C3  feat(admin): humanized user activity page
D1  feat(admin): status bucket model
D2  feat(admin): grouped status bucket cards on queue
D3  feat(admin): payment/leads/signups secondary tiles
```

## 12. When you finish / if you get stuck

- All checks green, one commit per task, branch `feat/cursor-handoff-3` pushed.
- Anything that would require a `@rgs/shared` contract change or a new GSI/table change not
  described here → STOP and write it in `docs/REVIEW-QUESTIONS.md` (do not improvise).
- Leave a short status summary in `docs/CURSOR-STATUS-3.md` (mirror `CURSOR-STATUS-2.md`):
  what's done, what's pending, any deviations, and the manual-smoke results.
