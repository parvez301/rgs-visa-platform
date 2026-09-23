# RGS Admin — User management, roles, and screen access

**Status:** implemented (verified 2026-09-23 — automated suites in task 9; post-deploy smoke in §9 still requires separate approval).

**Context:** Admin Cognito pool today is flat — any signed-in admin sees every nav item and can call every admin API. This spec adds fixed roles, screen gating, and an Owner-only Users screen with email invite.

---

## 1. Goals

- Invite desk staff by email with a Cognito temporary password and forced change on first login.
- Assign exactly one of four fixed roles per admin.
- Hide nav items and block routes the role cannot use.
- Enforce the same rules on the API (403), not only in the UI.
- Seed the existing `admin@raysglobalservices.com` as **Owner** on staging and prod.

## 2. Non-goals (later)

- Case assignee / “bulk assign team”.
- Custom per-user screen overrides on top of roles.
- Portal (applicant) Cognito pool RBAC.
- Multi-role membership (one admin in multiple groups).
- Self-service signup for admins (pool stays `selfSignUpEnabled: false`).

---

## 3. Roles

Cognito **groups** on the Admins user pool (exact names):

| Group | Purpose |
|-------|---------|
| `Owner` | Full access; only role that manages admins |
| `Ops` | Day desk: visa queue + CRM ops |
| `Finance` | Collections / billing focus on CRM |
| `Viewer` | Read-only Queue, Activity, CRM |

One primary group per admin. Invite and role-change **replace** the previous group (remove from others, add to the chosen one).

Admins with **no** group after deploy must be treated as **no access** except a clear “contact Owner” screen — except the migration that seeds Owner (see §8). Prefer fail-closed over fail-open.

---

## 4. Screen / route matrix

| Screen | Route(s) | Owner | Ops | Finance | Viewer |
|--------|----------|-------|-----|---------|--------|
| Queue | `/`, `/applications/:id` | R/W | R/W | — | R |
| Activity | `/activity` | R/W | R/W | R/W | R |
| Leads | `/leads` | R/W | R/W | — | — |
| Notices | `/notices` | R/W | R/W | — | — |
| Config | `/config` | R/W | — | — | — |
| CRM Ledger / Case | `/crm`, `/crm/cases/:id` | R/W | R/W | R/W | R |
| CRM Review | `/crm/review` | R/W | R/W | — | — |
| Portal user activity | `/users/:userId` | R | R | R | R |
| **Admin users** | `/admin/users` (new) | R/W | — | — | — |

**Legend:** `R/W` = navigate + mutate; `R` = navigate + GET only; `—` = no nav, route redirects home (or 403 page), API 403.

**Viewer write ban (examples):** case status/billing/custody/outcome, New case, checklist marks, line items, review resolve, queue transitions, payment status, notices upsert/delete, config upsert. GET and read-only case/ledger remain allowed.

**Finance:** CRM mutations that are billing/invoice/line-item related allowed; CRM review blocked; visa Queue/Leads/Notices/Config blocked. Activity allowed (for audit while collecting).

**Nav:** `AdminShell` filters `NAV_LINKS` by role. New link label **Users** → `/admin/users` (Owner only). Existing portal activity route stays `/users/:userId` so it does not collide.

---

## 5. Cognito / infra

- Create four groups on `AdminsPool` (CDK `CfnUserPoolGroup` or equivalent).
- Ensure ID token (what the admin SPA uses) includes `cognito:groups` (default for groups membership).
- Lambda roles for admin API need IAM to:
  - `cognito-idp:AdminCreateUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminDisableUser`, `AdminEnableUser`, `AdminListGroupsForUser`, `ListUsers`, `AdminGetUser`
  - Scoped to the Admins pool ARN.
- Invite email: Cognito `AdminCreateUser` with `DesiredDeliveryMediums: EMAIL` (Cognito’s own invite email). Temporary password + `FORCE_CHANGE_PASSWORD`. App auth flow already supports new-password challenge if present; verify and extend `AuthPage` if needed.
- From-address for Cognito invite is Cognito’s default unless a custom SES identity is later wired to the pool — **out of scope** to rebrand invite mail in this slice; operational note only.

---

## 6. API

### 6.1 Auth helpers

Replace bare “signed in” checks with:

- `requireAdmin(ctx)` — still requires Cognito admin JWT; returns `{ adminId, adminEmail, roles: AdminRole[] }`.
- `requireRole(ctx, allowed: AdminRole[])` — 403 if caller’s groups intersect `allowed` is empty.
- `requireScreen(ctx, screen: ScreenId)` — maps screen → allowed roles (single source shared with frontend via `@rgs/shared` or duplicated constant kept in sync by tests).

Parse `cognito:groups` from the authorizer claims (API Gateway JWT authorizer already forwards claims; confirm claim path in `RequestContext` and extend if groups are missing).

### 6.2 New Owner-only routes

Under `/api/v1/admin/staff` (name chosen to avoid clash with portal `GET /api/v1/admin/users`):

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/api/v1/admin/staff` | List admin pool users + resolved role + status |
| `POST` | `/api/v1/admin/staff` | Body `{ email, role }` — create + group + invite email |
| `PUT` | `/api/v1/admin/staff/{username}/role` | Body `{ role }` — set sole group |
| `POST` | `/api/v1/admin/staff/{username}/disable` | Disable user |
| `POST` | `/api/v1/admin/staff/{username}/enable` | Re-enable |

Guards:

- Only `Owner` may call these.
- Owner cannot disable **self**.
- Cannot disable or demote the **last** remaining Owner.
- Invite email must be a normal email; duplicate active user → 409.

### 6.3 Existing routes

Every existing admin and CRM route gets an explicit screen/role check matching §4. Prefer a small table at registration time over ad-hoc checks scattered in domain code.

---

## 7. Admin UI

### 7.1 Auth / session

- After login, read `cognito:groups` from the ID token (or `/api/v1/admin/me` if claims are awkward — prefer token first).
- Expose `useAdminAccess(): { role, can(screen), canWrite(screen) }` from auth context.
- `RequireAuth` stays; add `RequireScreen` / `RequireRole` wrappers on routes.

### 7.2 Users page (`/admin/users`)

Owner-only:

- Table: email, role, status (`FORCE_CHANGE_PASSWORD` / `CONFIRMED` / disabled).
- Invite form: email + role select → POST staff.
- Row actions: change role, disable/enable (with confirm).
- Empty / error states in existing admin visual language (no new design system).

### 7.3 Viewer UX

Mutating controls disabled or hidden; if a stale tab calls a write API, show the 403 message, do not fake success.

---

## 8. Migration / seed

One-shot (CDK custom resource **or** documented CLI + runbook on first deploy of this feature):

1. Ensure four groups exist.
2. For `admin@raysglobalservices.com` on staging and prod Admins pools: add to `Owner` if not already in a role group.

Idempotent. Do not invent a second Owner automatically for other emails.

Admins created manually in console without a group: Owner assigns a role via Users page after this ships (or they stay locked out — fail closed).

---

## 9. Testing

- Unit: role → screen matrix; last-Owner protection; Viewer write map.
- API: Owner invite happy path (mocked Cognito); Finance 403 on config; Viewer 403 on status PUT; Ops 200 on CRM status.
- Admin UI: nav link set per role; `/admin/users` redirects for non-Owner; Viewer cannot submit New case.

---

## 10. Rollout

1. Deploy infra (groups + IAM + seed Owner) + API enforcement + UI.
2. Staging: invite one Ops and one Viewer; confirm nav + 403s.
3. Prod: confirm `admin@…` is Owner; invite real staff; only then rely on role gates.

---

## 11. Open points resolved in design

| Topic | Decision |
|-------|----------|
| Role model | Fixed four roles |
| Storage | Cognito groups |
| Invite | Cognito temp password email + force change |
| Users route | `/admin/users` (UI); `/api/v1/admin/staff` (API) |
| Portal users list | Unchanged `GET /api/v1/admin/users` |

No unresolved placeholders.
