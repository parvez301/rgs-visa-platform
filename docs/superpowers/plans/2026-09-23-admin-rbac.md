# Admin RBAC & User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cognito-group roles (Owner / Ops / Finance / Viewer), screen-gated nav and routes, API 403 enforcement, and an Owner-only staff invite UI.

**Architecture:** Role and screen matrix live in `@rgs/shared` (pure). API Gateway JWT claims feed `RequestContext.roles`; helpers `requireRole` / `requireScreen` / `requireWrite` gate every admin route. Staff CRUD talks to Cognito Admin APIs. Admin SPA reads `cognito:groups` from the ID token, filters nav, and wraps routes. CDK creates four groups, IAM for Cognito admin calls, and seeds `admin@raysglobalservices.com` into `Owner`.

**Tech Stack:** TypeScript strict, Zod, Vitest, Cognito (`@aws-sdk/client-cognito-identity-provider`), CDK, React Router, amazon-cognito-identity-js, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-rbac-design.md`

## Global Constraints

- TypeScript `strict: true`; no `any`.
- Descriptive names — never `cfg`, `res`, `idx`, `val`.
- Fail-closed: admin with **no** Cognito role group gets no screens and API 403 (except auth).
- One role group per admin; invite/role-change removes other role groups then adds the chosen one.
- Portal `GET /api/v1/admin/users` stays portal profiles; staff API is `/api/v1/admin/staff`.
- UI Users page is `/admin/users` (not `/users/:userId`).
- Cognito group names exact: `Owner`, `Ops`, `Finance`, `Viewer`.
- Commit after every task with green tests.
- Do not implement case assignee, per-user screen overrides, or portal RBAC.

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/adminAccess.ts` | Roles, screens, matrix, `canAccessScreen`, `canWriteScreen`, `primaryRole` |
| `packages/shared/src/index.ts` | Re-export admin access |
| `services/api/src/http/router.ts` | Parse `cognito:groups` into `RequestContext.roles` |
| `services/api/src/http/adminAccess.ts` | `requireAdmin`, `requireRole`, `requireScreen`, `requireWrite` |
| `services/api/src/http/adminApi.ts` / `crmApi.ts` / `agentApi.ts` | Call new guards per route |
| `services/api/src/domain/admin/staff.ts` | Invite / list / setRole / disable / enable + last-Owner rules |
| `services/api/src/lib/cognitoAdmins.ts` | Thin Cognito Identity Provider wrapper (mockable) |
| `services/api/src/http/staffApi.ts` | Register `/api/v1/admin/staff*` routes |
| `infra/lib/rgs-platform-stack.ts` | Groups, IAM, env `ADMINS_USER_POOL_ID`, seed Owner |
| `apps/admin/src/lib/auth.tsx` | Expose `roles` / `primaryRole` from ID token |
| `apps/admin/src/lib/adminAccess.ts` | `useAdminAccess` hook |
| `apps/admin/src/components/RequireScreen.tsx` | Route guard |
| `apps/admin/src/components/AdminShell.tsx` | Filter nav by access |
| `apps/admin/src/main.tsx` | Wrap routes; add `/admin/users` |
| `apps/admin/src/pages/AdminUsersPage.tsx` | Owner staff UI |
| `apps/admin/src/lib/adminApi.ts` | Staff client methods |
| `apps/admin/src/pages/NoAccessPage.tsx` | Signed-in but no role |

---

### Task 1: Shared role + screen matrix

**Files:**
- Create: `packages/shared/src/adminAccess.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/adminAccess.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ADMIN_ROLES = ["Owner","Ops","Finance","Viewer"] as const`
  - `type AdminRole = (typeof ADMIN_ROLES)[number]`
  - `ADMIN_SCREENS = ["queue","activity","leads","notices","config","crm","crmReview","portalUser","adminUsers"] as const`
  - `type AdminScreen = (typeof ADMIN_SCREENS)[number]`
  - `type ScreenAccess = "none" | "read" | "write"`
  - `SCREEN_ACCESS: Record<AdminRole, Record<AdminScreen, ScreenAccess>>` matching spec §4
  - `primaryRole(roles: readonly string[]): AdminRole | null` — first match in Owner→Ops→Finance→Viewer order among known groups; ignore unknown strings
  - `canAccessScreen(role: AdminRole | null, screen: AdminScreen): boolean` — true if access ≠ `"none"`
  - `canWriteScreen(role: AdminRole | null, screen: AdminScreen): boolean` — true if access === `"write"`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  canAccessScreen,
  canWriteScreen,
  primaryRole,
  SCREEN_ACCESS,
} from "../src/adminAccess";

describe("primaryRole", () => {
  it("prefers Owner when multiple groups are present", () => {
    expect(primaryRole(["Ops", "Owner"])).toBe("Owner");
  });
  it("returns null when no known role group is present", () => {
    expect(primaryRole([])).toBeNull();
    expect(primaryRole(["SomethingElse"])).toBeNull();
  });
});

describe("screen matrix", () => {
  it("gives Owner write on adminUsers and config", () => {
    expect(SCREEN_ACCESS.Owner.adminUsers).toBe("write");
    expect(SCREEN_ACCESS.Owner.config).toBe("write");
  });
  it("blocks Finance from queue and crmReview", () => {
    expect(canAccessScreen("Finance", "queue")).toBe(false);
    expect(canAccessScreen("Finance", "crmReview")).toBe(false);
    expect(canAccessScreen("Finance", "crm")).toBe(true);
    expect(canWriteScreen("Finance", "crm")).toBe(true);
  });
  it("makes Viewer read-only on crm and queue", () => {
    expect(canAccessScreen("Viewer", "crm")).toBe(true);
    expect(canWriteScreen("Viewer", "crm")).toBe(false);
    expect(canWriteScreen("Viewer", "queue")).toBe(false);
  });
  it("blocks Ops from config and adminUsers", () => {
    expect(canAccessScreen("Ops", "config")).toBe(false);
    expect(canAccessScreen("Ops", "adminUsers")).toBe(false);
  });
  it("treats null role as no access", () => {
    expect(canAccessScreen(null, "crm")).toBe(false);
    expect(canWriteScreen(null, "crm")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm exec vitest run test/adminAccess.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `adminAccess.ts` and export from `index.ts`**

Fill `SCREEN_ACCESS` exactly from spec §4:
- Owner: all screens `"write"` (portalUser `"read"` is fine if Activity links are read — use `"read"` for `portalUser` for all roles that can open it; Owner/Ops/Finance/Viewer all `"read"` on `portalUser`).
- Ops: queue/activity/leads/notices/crm/crmReview `"write"`; portalUser `"read"`; config/adminUsers `"none"`.
- Finance: activity/crm `"write"`; portalUser `"read"`; all others `"none"`.
- Viewer: queue/activity/crm `"read"`; portalUser `"read"`; all others `"none"`.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd packages/shared && pnpm exec vitest run test/adminAccess.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/adminAccess.ts packages/shared/src/index.ts packages/shared/test/adminAccess.test.ts
git commit -m "feat(shared): admin role and screen access matrix"
```

---

### Task 2: Parse Cognito groups into RequestContext + access helpers

**Files:**
- Modify: `services/api/src/http/router.ts`
- Create: `services/api/src/http/adminAccess.ts`
- Modify: `services/api/src/http/adminApi.ts` — re-export or replace `requireAdmin` to use new module (keep `export function requireAdmin` signature extended)
- Test: `services/api/test/http/adminAccess.test.ts`
- Test: `services/api/test/http/parseCognitoGroups.test.ts` (or colocate parse helper tests)

**Interfaces:**
- Consumes: `primaryRole`, `canAccessScreen`, `canWriteScreen`, `AdminRole`, `AdminScreen` from `@rgs/shared`.
- Produces:
  - `RequestContext.roles: string[]` (raw group names from JWT)
  - `parseCognitoGroupsClaim(claim: unknown): string[]` — handles missing, JSON string array, or already-array
  - `requireAdmin(ctx) => { adminId, adminEmail, role: AdminRole }` — throws 403 if no callerId **or** `primaryRole(ctx.roles)` is null
  - `requireRole(ctx, allowed: readonly AdminRole[])`
  - `requireScreen(ctx, screen: AdminScreen)` — needs access ≠ none
  - `requireWrite(ctx, screen: AdminScreen)` — needs write

- [ ] **Step 1: Write failing tests for `parseCognitoGroupsClaim` and `requireWrite`**

```ts
import { describe, expect, it } from "vitest";
import { parseCognitoGroupsClaim } from "../../src/http/adminAccess";
import { requireAdmin, requireWrite } from "../../src/http/adminAccess";
import { ApiError } from "../../src/lib/errors";
import type { RequestContext } from "../../src/http/router";

function ctx(partial: Partial<RequestContext>): RequestContext {
  return {
    callerId: "sub-1",
    callerEmail: "a@example.com",
    roles: [],
    pathParams: {},
    queryParams: {},
    body: undefined,
    ...partial,
  };
}

describe("parseCognitoGroupsClaim", () => {
  it("parses the JSON string API Gateway puts in jwt claims", () => {
    expect(parseCognitoGroupsClaim("[\"Owner\",\"Ops\"]")).toEqual(["Owner", "Ops"]);
  });
  it("returns empty for missing claim", () => {
    expect(parseCognitoGroupsClaim(undefined)).toEqual([]);
  });
});

describe("requireAdmin", () => {
  it("403 when signed in but no role group", () => {
    expect(() => requireAdmin(ctx({ roles: [] }))).toThrow(ApiError);
  });
  it("returns Owner when group present", () => {
    expect(requireAdmin(ctx({ roles: ["Owner"] })).role).toBe("Owner");
  });
});

describe("requireWrite", () => {
  it("403 for Viewer on crm writes", () => {
    expect(() => requireWrite(ctx({ roles: ["Viewer"] }), "crm")).toThrow(ApiError);
  });
  it("allows Ops on crm writes", () => {
    expect(() => requireWrite(ctx({ roles: ["Ops"] }), "crm")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd services/api && pnpm exec vitest run test/http/adminAccess.test.ts`

- [ ] **Step 3: Implement**

In `router.ts` dispatch, set:
```ts
roles: parseCognitoGroupsClaim(jwtClaims["cognito:groups"]),
```
Export `parseCognitoGroupsClaim` from `adminAccess.ts`. Move/replace `requireAdmin` from `adminApi.ts` into `adminAccess.ts` and update imports in `adminApi.ts`, `crmApi.ts`, `agentApi.ts` to import from `./adminAccess` (or re-export from `adminApi` for minimal churn — prefer single module `adminAccess.ts`).

Use `forbidden(...)` / `ApiError(403, ...)` consistent with existing `forbidden` helper.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add services/api/src/http/router.ts services/api/src/http/adminAccess.ts services/api/src/http/adminApi.ts services/api/src/http/crmApi.ts services/api/src/http/agentApi.ts services/api/test/http/adminAccess.test.ts
git commit -m "feat(api): parse Cognito groups and require role/screen/write"
```

---

### Task 3: Gate every existing admin + CRM + agent route

**Files:**
- Modify: `services/api/src/http/adminApi.ts`
- Modify: `services/api/src/http/crmApi.ts`
- Modify: `services/api/src/http/agentApi.ts`
- Test: `services/api/test/http/routeAccessMatrix.test.ts`

**Interfaces:**
- Consumes: `requireScreen`, `requireWrite` from Task 2.
- Produces: every mutating route calls `requireWrite(screen)`; every read calls `requireScreen(screen)`.

Screen mapping (apply exactly):

| Routes prefix / pattern | Screen | Read vs write |
|-------------------------|--------|---------------|
| applications, transition, review doc, payment | `queue` | write on mutations; read on GET |
| activity, user activity | `activity` | read (if any write notes → write) |
| leads | `leads` | |
| notices | `notices` | |
| config/countries | `config` | |
| GET admin/users (portal profiles) | `portalUser` or `activity` | use `activity` read (same roles) |
| crm partners/travellers/cases ledger GET | `crm` | read |
| crm case/applicant/billing/line-item/checklist mutations | `crm` | write |
| crm review | `crmReview` | |
| agent turn/proposals/memories | `crm` | write for mutations; read for GET transcript if any |

- [ ] **Step 1: Write a matrix test that walks `registeredRoutes` and asserts each path has been classified**

Keep a `ROUTE_ACCESS: { method, pathPattern, screen, mode: "read"|"write" }[]` in the test file (or exported from a small `routeAccess.ts` used by both router registration comments and test). Fail if `adminRouter.registeredRoutes` has a route not in the table.

- [ ] **Step 2: Run — expect FAIL** (missing table or ungated)

- [ ] **Step 3: Replace each `requireAdmin` with `requireScreen` / `requireWrite` as appropriate. Keep `requireAdmin` only where you still need `{ adminEmail }` after a screen check — pattern:

```ts
requireWrite(requestContext, "crm");
const { adminEmail } = requireAdmin(requestContext);
```

Or have `requireWrite` return the same shape as `requireAdmin`.

- [ ] **Step 4: Run full API http/crm tests touched + matrix test — PASS**

Run: `cd services/api && pnpm exec vitest run test/http test/crm --reporter=dot`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): enforce screen access on admin and CRM routes"
```

---

### Task 4: Cognito staff domain (invite / role / disable)

**Files:**
- Create: `services/api/src/lib/cognitoAdmins.ts`
- Create: `services/api/src/domain/admin/staff.ts`
- Test: `services/api/test/admin/staff.test.ts`
- Modify: `services/api/package.json` — add `@aws-sdk/client-cognito-identity-provider` if missing
- Modify: `services/api/src/lib/context.ts` — optional `cognitoAdmins?: CognitoAdminsClient` on `AppContext` **or** pass client into staff functions (prefer inject on `AppContext` for testability)

**Interfaces:**
- Consumes: `AdminRole`, `ADMIN_ROLES` from shared.
- Produces:
  - `interface CognitoAdminsClient { listUsers(); adminCreateUser(...); adminAddUserToGroup(...); adminRemoveUserFromGroup(...); adminListGroupsForUser(...); adminDisableUser(...); adminEnableUser(...); adminGetUser(...) }`
  - `InMemoryCognitoAdmins` for tests
  - `listStaff(client): Promise<StaffMember[]>` where `StaffMember = { username, email, role: AdminRole | null, status: string, enabled: boolean }`
  - `inviteStaff(client, { email, role }, actorEmail): Promise<StaffMember>`
  - `setStaffRole(client, username, role, actorUsername): Promise<void>`
  - `disableStaff(client, username, actorUsername): Promise<void>`
  - `enableStaff(client, username): Promise<void>`
  - Throws `ApiError` 409 duplicate; 400 last Owner demote/disable; 400 self-disable

Last-Owner rule: before remove/disable of an Owner, count users whose sole/primary role is Owner; if count would drop to 0 → 400.

- [ ] **Step 1: Failing tests** — invite assigns group; setRole removes other role groups; cannot disable self; cannot demote last Owner.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement in-memory client + staff domain**

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): staff invite and role domain over Cognito admins"
```

---

### Task 5: Staff HTTP routes + wire production Cognito client

**Files:**
- Create: `services/api/src/http/staffApi.ts`
- Modify: `services/api/src/http/adminApi.ts` — `registerStaffRoutes(adminRouter, context)`
- Modify: `services/api/src/http/handler.ts` — build Cognito client from `ADMINS_USER_POOL_ID`
- Test: `services/api/test/http/staffApi.test.ts` (router dispatch with in-memory cognito on context)

**Interfaces:**
- `GET /api/v1/admin/staff` — `requireWrite` is wrong; use `requireScreen(ctx, "adminUsers")` (Owner write matrix implies read). Spec: Owner only → `requireRole(ctx, ["Owner"])` is enough.
- `POST /api/v1/admin/staff` body `{ email: string, role: AdminRole }`
- `PUT /api/v1/admin/staff/{username}/role` body `{ role }`
- `POST /api/v1/admin/staff/{username}/disable`
- `POST /api/v1/admin/staff/{username}/enable`

- [ ] **Step 1–4:** TDD routes with in-memory Cognito; 403 for Ops calling invite.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(api): Owner staff management HTTP routes"
```

---

### Task 6: CDK — groups, IAM, env, seed Owner

**Files:**
- Modify: `infra/lib/rgs-platform-stack.ts`
- Optional: `infra/lib/seed-admin-owner.ts` or inline `AwsCustomResource`

**Steps:**

- [ ] **Step 1:** Add four `cognito.CfnUserPoolGroup` resources on `adminsPool` (`Owner`, `Ops`, `Finance`, `Viewer`).

- [ ] **Step 2:** Env on admin + appointment lambdas: `ADMINS_USER_POOL_ID: adminsPool.userPoolId`.

- [ ] **Step 3:** Grant admin Lambda (and only functions that need staff APIs — admin API) IAM:
  `cognito-idp:AdminCreateUser`, `AdminAddUserToGroup`, `AdminRemoveUserFromGroup`, `AdminListGroupsForUser`, `AdminDisableUser`, `AdminEnableUser`, `AdminGetUser`, `ListUsers` on `adminsPool.userPoolArn` and `arn:...:userpool/.../*` as required by Cognito.

- [ ] **Step 4:** Seed: `AwsCustomResource` (or one-shot script documented + run in deploy notes) that `AdminAddUserToGroup` for username/email `admin@raysglobalservices.com` → `Owner`, ignoring "already in group". Prefer custom resource so staging/prod both get it on deploy.

- [ ] **Step 5:** `cd infra && pnpm exec tsc --noEmit` PASS

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(infra): Cognito admin role groups, IAM, and Owner seed"
```

Do **not** deploy in this task unless the executor is explicitly told to deploy.

---

### Task 7: Admin auth exposes roles + access hook + guards

**Files:**
- Modify: `apps/admin/src/lib/auth.tsx`
- Create: `apps/admin/src/lib/adminAccess.ts`
- Create: `apps/admin/src/components/RequireScreen.tsx`
- Create: `apps/admin/src/pages/NoAccessPage.tsx`
- Test: `apps/admin/test/adminAccess.test.ts` (pure helpers) and/or `RequireScreen` test

**Interfaces:**
- Extend `AuthState` with `roles: string[]`, `primaryRole: AdminRole | null`
- Parse groups from `session.getIdToken().payload["cognito:groups"]` (string | string[] | undefined) — same logic as server; import `primaryRole` from `@rgs/shared` and a small local `parseGroups` or shared helper if exported.
- `useAdminAccess()` → `{ primaryRole, canAccess(screen), canWrite(screen) }`
- `RequireScreen({ screen, write?: boolean, children })` — if no access, `<Navigate to="/no-access" />` or home; if signed in with null role → NoAccessPage

- [ ] **Step 1–4:** TDD parse + RequireScreen behaviour with AuthContext fixture (see existing `AuthContext` export pattern in CRM tests).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(admin): expose Cognito roles and RequireScreen guard"
```

---

### Task 8: Nav filter + wrap all routes + Admin Users page

**Files:**
- Modify: `apps/admin/src/components/AdminShell.tsx` — each nav item has a `screen: AdminScreen`; filter with `canAccess`
- Modify: `apps/admin/src/main.tsx` — wrap routes; add `/admin/users`, `/no-access`
- Create: `apps/admin/src/pages/AdminUsersPage.tsx`
- Modify: `apps/admin/src/lib/adminApi.ts` — `listStaff`, `inviteStaff`, `setStaffRole`, `disableStaff`, `enableStaff`
- Test: `apps/admin/test/AdminUsersPage.test.tsx`, `AdminShell` nav filter test

**AdminUsersPage behaviour:**
- Table of staff from `listStaff`
- Invite: email + role select + submit
- Row: role `<select>` → setStaffRole; Disable/Enable buttons with confirm
- On 403/400 show error text from API

**Viewer UX (minimum in this task):** on CRM New case button and bulk bar, disable when `!canWrite("crm")` — or hide. Prefer hide destructive write entry points (New case, BulkActionsBar) when `!canWrite("crm")`.

- [ ] **Step 1–4:** TDD page + nav; wire routes with `RequireScreen`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(admin): Users page, nav gating, and route guards"
```

---

### Task 9: End-to-end verification checklist (manual + automated smoke)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-admin-rbac-design.md` — set Status to `implemented` when done (optional in same PR)
- Create: `docs/superpowers/plans/2026-09-23-admin-rbac-verification.md` only if needed — else keep checklist in commit message / PR

- [ ] **Step 1:** Run automated suites:

```bash
cd packages/shared && pnpm test
cd services/api && pnpm exec vitest run test/http test/admin
cd apps/admin && pnpm exec vitest run test/adminAccess.test.ts test/AdminUsersPage.test.tsx
```

- [ ] **Step 2:** After deploy (separate approval): confirm Owner seed; invite Ops; Viewer cannot PUT status (403); Finance cannot open Config.

- [ ] **Step 3: Final commit** if doc status updated

```bash
git commit -am "docs: mark admin RBAC spec implemented"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §3 Roles / groups | 1, 6 |
| §4 Screen matrix | 1, 3, 8 |
| §5 Cognito / IAM / invite email | 4, 5, 6 |
| §6 API helpers + staff routes | 2, 3, 4, 5 |
| §7 Admin UI | 7, 8 |
| §8 Seed Owner | 6 |
| §9 Testing | each task + 9 |
| §2 Non-goals | Global Constraints |

**Placeholder scan:** none intentional. Cognito invite branding left as operational note in spec §5 — not a plan task.

**Type consistency:** `AdminRole`, `AdminScreen`, `StaffMember`, `requireWrite(ctx, screen)`, `/api/v1/admin/staff` used uniformly.
