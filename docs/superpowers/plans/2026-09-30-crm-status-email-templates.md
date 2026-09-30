# CRM: Expanded Statuses + Configurable Status Email Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand case statuses to match the twelve client-facing visa stages, rename `IN_PROGRESS` → `DOCS_UNDER_REVIEW`, derive Granted/Refused only for individuals (groups stay on Decision Received), and let the desk edit per-status email subject/body in Admin UI (Dynamo-backed).

**Architecture:** Shared enums + state machine + derivation grow first (so the rest of the monorepo compiles). Status email templates are one Dynamo `META` row per `CaseStatus`, seeded with copy from the owner feedback doc. `statusNotify` loads and renders placeholders (no hard-coded generic body). Admin gets labels/chips for new statuses and a Status emails settings screen.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, zod, DynamoDB single-table (`TableClient`), React 19 + TanStack Query + Tailwind (admin), migration CLIs under `@rgs/migration`.

**Spec:** `docs/superpowers/specs/2026-09-30-crm-status-email-templates-design.md`

## Global Constraints

- Always descriptive variable names (user rule). No `e`, `x`, `res`, `tmp`, `i` outside trivial index loops.
- Match surrounding style: comment density of the file you edit; named-field construction; zod parse → `badRequest` on `ZodError`.
- Never write `undefined` Dynamo attribute values — spread conditionally.
- API routes are `PUT` (never `PATCH`) under `/api/v1/admin/crm/...`. Register literal paths before `{caseStatus}` param routes of the same method if any collide.
- Commit messages: conventional (`feat(crm): ...`, `fix(admin): ...`), one commit per task.
- Deploy target: **staging only**. Do not deploy prod, do not push unless asked.
- Do not resurrect the pre-2026-09-25 hard-coded generic status body once templates exist — missing/disabled template → skip send (spec §4.4).
- `IN_PROGRESS` must disappear from the codebase after Task 1–3 (except migration code that *reads* the old value to rename it).

## Review Focus

1. **Individual approved → `VISA_GRANTED`, not `DECIDED`** — one applicant, no `groupName`, all APPROVED (pinned Task 2).
2. **Group mixed outcomes → `DECIDED` only** — two+ applicants APPROVED+REJECTED never becomes `VISA_GRANTED` / `VISA_REFUSED` (pinned Task 2).
3. **`groupName` on a single applicant counts as group** — stays `DECIDED` when approved (pinned Task 2).
4. **Disabled template skips mail, status change still succeeds** (pinned Task 6).
5. **Create sends Application Received once** — partner with email + createCase → one mail; changing status later uses the new status template, not a duplicate of NEW (pinned Task 6).
6. **Rename migration is idempotent** — second run of IN_PROGRESS→DOCS_UNDER_REVIEW changes nothing harmful (pinned Task 8).
7. **Blank placeholder lines drop** — appointment line with no date does not leave `at .` (pinned Task 5).

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/crm/statuses.ts` | Enum + LIVE/TERMINAL lists |
| `packages/shared/src/crm/stateMachines.ts` | Transitions + `isCaseGroup` + `deriveCaseStatusFromApplicants` |
| `packages/shared/src/crm/normalize/status.ts` | Excel → new status ids |
| `packages/shared/src/crm/statusEmailDefaults.ts` | **Create** — seeded subject/body per status + placeholder phone constant |
| `packages/shared/src/crm/schemas.ts` | `StatusEmailTemplateSchema` + put/list types |
| `packages/shared/src/crm/index.ts` | Re-exports |
| `services/api/src/domain/crm/keys.ts` | `statusEmailTemplatePartitionKey` |
| `services/api/src/domain/crm/statusEmailTemplates.ts` | **Create** — get/list/put/reset/seed |
| `services/api/src/domain/crm/statusNotify.ts` | Load template, render, send on change + create |
| `services/api/src/domain/crm/cases.ts` | Pass `isGroup` into derive; notify on create |
| `services/api/src/domain/crm/crmEvents.ts` | Event meta may include `reason: "CREATE"` |
| `services/api/src/http/crmApi.ts` | Template routes |
| `services/migration/src/backfillCaseStatusRename.ts` | **Create** — IN_PROGRESS → DOCS_UNDER_REVIEW |
| `services/migration/src/seedStatusEmailTemplates.ts` | **Create** — insert-if-absent defaults |
| `services/migration/src/*Cli.ts` | CLIs + package.json scripts |
| `apps/admin/src/crm/labels.ts` | New labels |
| `apps/admin/src/crm/components/Chip.tsx` | New tints |
| `apps/admin/src/crm/api/crmClient.ts` | Template client methods |
| `apps/admin/src/crm/statusEmails/StatusEmailsPage.tsx` | **Create** — settings UI |
| `apps/admin/src/main.tsx` | Route `/crm/status-emails` |
| `apps/admin/src/crm/case/eventCopy.ts` | CREATE notify copy |

Plus every test file that still mentions `IN_PROGRESS` or the old generic body (grep and update in the owning task).

---

### Task 1: Expand `CASE_STATUSES` and rename `IN_PROGRESS`

**Files:**
- Modify: `packages/shared/src/crm/statuses.ts`
- Modify: `packages/shared/src/crm/normalize/status.ts`
- Modify: `packages/shared/test/crm/normalize/status.test.ts`
- Modify: `packages/shared/test/crm/index.test.ts` (if it lists statuses)
- Test: run shared package tests after mechanical renames in *this package only*; leave other packages red until Task 3

**Interfaces:**
- Produces: `CaseStatus` union including `DOCS_UNDER_REVIEW`, `ADDITIONAL_DOCS_REQUIRED`, `READY_FOR_SUBMISSION`, `UNDER_PROCESS`, `PASSPORT_RECEIVED`, `VISA_GRANTED`, `VISA_REFUSED`; no `IN_PROGRESS`
- Produces: updated `LIVE_CASE_STATUSES` / `TERMINAL_CASE_STATUSES` per spec §3.2

- [ ] **Step 1: Write the failing normalize test**

In `packages/shared/test/crm/normalize/status.test.ts`, change (or add) expectations so `"In Progress"` / `"Working on It"` map to `DOCS_UNDER_REVIEW`, and add:

```ts
it("maps additional docs / under process / passport received when the sheet uses those words", () => {
  expect(normalizeStatus("Additional Documents Required").caseStatus).toBe("ADDITIONAL_DOCS_REQUIRED");
  expect(normalizeStatus("Under Process").caseStatus).toBe("UNDER_PROCESS");
  expect(normalizeStatus("Passport Received").caseStatus).toBe("PASSPORT_RECEIVED");
});
```

(Use the real export name from `normalize/status.ts` — today it is likely `normalizeStatus` or similar; read the file and match.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/normalize/status.test.ts`
Expected: FAIL (still maps to `IN_PROGRESS` or unknown)

- [ ] **Step 3: Update `statuses.ts`**

Replace `CASE_STATUSES` with (order matters for readability, not runtime):

```ts
export const CASE_STATUSES = [
  "NEW",
  "DOCS_UNDER_REVIEW",
  "ADDITIONAL_DOCS_REQUIRED",
  "READY_FOR_SUBMISSION",
  "APPOINTMENT_SET",
  "SUBMITTED",
  "UNDER_PROCESS",
  "PASSPORT_RECEIVED",
  "DECIDED",
  "VISA_GRANTED",
  "VISA_REFUSED",
  "CLOSED",
  "NOT_SUBMITTED",
  "WITHDRAWN",
  "DUPLICATE",
] as const;
```

Update `LIVE_CASE_STATUSES` to every status except the four terminals (`CLOSED`, `NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`) — includes `DECIDED`, `VISA_GRANTED`, `VISA_REFUSED`.

- [ ] **Step 4: Update normalize mappings**

In `normalize/status.ts`: every `"IN_PROGRESS"` → `"DOCS_UNDER_REVIEW"`. Add sheet keys for the new stages used in Step 1. Keep `APPROVED` / `REJECTED` → `DECIDED` + outcome (spec D10).

- [ ] **Step 5: Run shared normalize + index tests**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/normalize/status.test.ts test/crm/index.test.ts`
Expected: PASS for those files. `stateMachines.test.ts` will fail until Task 2 — that is OK.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/crm/statuses.ts packages/shared/src/crm/normalize/status.ts packages/shared/test/crm/normalize/status.test.ts packages/shared/test/crm/index.test.ts
git commit -m "$(cat <<'EOF'
feat(crm): expand case statuses and rename IN_PROGRESS to DOCS_UNDER_REVIEW

EOF
)"
```

---

### Task 2: State machine + group-aware derivation

**Files:**
- Modify: `packages/shared/src/crm/stateMachines.ts`
- Modify: `packages/shared/test/crm/stateMachines.test.ts`
- Modify: every shared caller of `deriveCaseStatusFromApplicants` (grep)

**Interfaces:**
- Produces:
```ts
export function isCaseGroup(input: {
  groupName?: string | undefined;
  applicantCount: number;
}): boolean;

export function deriveCaseStatusFromApplicants(
  currentCaseStatus: CaseStatus,
  applicantOutcomes: readonly ApplicantOutcome[],
  options: { isGroup: boolean },
): CaseStatus;
```
- Consumes: new `CaseStatus` values from Task 1

- [ ] **Step 1: Rewrite failing derivation tests**

Replace `IN_PROGRESS` with `DOCS_UNDER_REVIEW` throughout the file. Change the signature of every `deriveCaseStatusFromApplicants` call to pass `{ isGroup: ... }`.

Add / adjust:

```ts
it("derives VISA_GRANTED for an individual when the only applicant is APPROVED", () => {
  expect(
    deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED"], { isGroup: false }),
  ).toBe("VISA_GRANTED");
});

it("derives VISA_REFUSED for an individual when the only applicant is REJECTED", () => {
  expect(
    deriveCaseStatusFromApplicants("SUBMITTED", ["REJECTED"], { isGroup: false }),
  ).toBe("VISA_REFUSED");
});

it("derives DECIDED for a group even when every applicant is APPROVED", () => {
  expect(
    deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "APPROVED"], { isGroup: true }),
  ).toBe("DECIDED");
});

it("derives DECIDED for a group with mixed APPROVED and REJECTED", () => {
  expect(
    deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "REJECTED"], { isGroup: true }),
  ).toBe("DECIDED");
});

it("reopens VISA_GRANTED to SUBMITTED when an applicant becomes live again", () => {
  expect(
    deriveCaseStatusFromApplicants("VISA_GRANTED", ["SENT_BACK"], { isGroup: false }),
  ).toBe("SUBMITTED");
});

it("isCaseGroup is true when groupName is set even for one applicant", () => {
  expect(isCaseGroup({ groupName: "Sharma Family", applicantCount: 1 })).toBe(true);
  expect(isCaseGroup({ applicantCount: 1 })).toBe(false);
  expect(isCaseGroup({ applicantCount: 2 })).toBe(true);
});
```

Update the embassy scenario: three APPROVED with `isGroup: true` → `DECIDED` (not `VISA_GRANTED`). The old single-APPROVED → `DECIDED` expectations become `VISA_GRANTED` with `isGroup: false`.

Happy-path transition tests: `NEW` → `DOCS_UNDER_REVIEW` → … include new siblings; skip-ahead from early live statuses to `UNDER_PROCESS`, `PASSPORT_RECEIVED`, `VISA_GRANTED`, `CLOSED`, etc.

- [ ] **Step 2: Run tests — expect FAIL**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/stateMachines.test.ts`
Expected: FAIL (old machine / old derive)

- [ ] **Step 3: Implement machine + derive**

`CASE_STATUS_FORWARD_TRANSITIONS`: build from happy-path order in spec §3.3. Every live status may reach any later happy-path status and `CLOSED`. `DECIDED` / `VISA_GRANTED` / `VISA_REFUSED` include `SUBMITTED` (reopen) and `CLOSED`. Off-ramps unchanged via `CASE_STATUS_OFF_RAMPS`.

```ts
export function isCaseGroup(input: {
  groupName?: string | undefined;
  applicantCount: number;
}): boolean {
  return input.groupName !== undefined || input.applicantCount > 1;
}

export function deriveCaseStatusFromApplicants(
  currentCaseStatus: CaseStatus,
  applicantOutcomes: readonly ApplicantOutcome[],
  options: { isGroup: boolean },
): CaseStatus {
  if (TERMINAL_CASE_STATUSES.includes(currentCaseStatus)) {
    return currentCaseStatus;
  }
  if (applicantOutcomes.length === 0) {
    return currentCaseStatus;
  }
  const everyApplicantDecided = applicantOutcomes.every(
    (applicantOutcome) => applicantOutcome === "APPROVED" || applicantOutcome === "REJECTED",
  );
  if (everyApplicantDecided) {
    if (options.isGroup) return "DECIDED";
    if (applicantOutcomes.every((applicantOutcome) => applicantOutcome === "APPROVED")) {
      return "VISA_GRANTED";
    }
    if (applicantOutcomes.every((applicantOutcome) => applicantOutcome === "REJECTED")) {
      return "VISA_REFUSED";
    }
    return "DECIDED";
  }
  if (
    currentCaseStatus === "DECIDED" ||
    currentCaseStatus === "VISA_GRANTED" ||
    currentCaseStatus === "VISA_REFUSED"
  ) {
    return "SUBMITTED";
  }
  return currentCaseStatus;
}
```

- [ ] **Step 4: Run state machine tests — PASS**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/stateMachines.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/stateMachines.ts packages/shared/test/crm/stateMachines.test.ts
git commit -m "$(cat <<'EOF'
feat(crm): status transitions and group-aware granted/refused derivation

EOF
)"
```

---

### Task 3: Compile sweep — replace `IN_PROGRESS` across api/admin/migration tests

**Files:**
- Grep the repo for `IN_PROGRESS` and fix every reference except migration rename *readers*
- Modify: `apps/admin/src/crm/labels.ts`, `apps/admin/src/crm/components/Chip.tsx`, and any `Record<crm.CaseStatus, …>` that must stay total
- Modify: `services/api/src/domain/crm/cases.ts` — pass `{ isGroup: crm.isCaseGroup({ groupName: updatedCase.groupName, applicantCount: updatedApplicants.length }) }` into derive
- Modify: `services/api/src/domain/crm/statusNotify.ts` — temporary label map keys (full template rewrite is Task 6); at minimum replace `IN_PROGRESS` label key with `DOCS_UNDER_REVIEW` so the package typechecks

**Interfaces:**
- Consumes: Task 1–2 types
- Produces: monorepo typecheck green; tests may still expect old email body until Task 6

- [ ] **Step 1: Grep and replace**

```bash
rg -n "IN_PROGRESS" --glob '!docs/**' --glob '!**/node_modules/**'
```

For each hit: use `DOCS_UNDER_REVIEW` unless the file is the future rename migrator.

Update labels:

```ts
export const CASE_STATUS_LABELS: Record<crm.CaseStatus, string> = {
  NEW: "Application Received",
  DOCS_UNDER_REVIEW: "Documents Under Review",
  ADDITIONAL_DOCS_REQUIRED: "Additional Documents Required",
  READY_FOR_SUBMISSION: "Ready for Submission",
  APPOINTMENT_SET: "Appointment Booked",
  SUBMITTED: "Application Submitted",
  UNDER_PROCESS: "Under Embassy Processing",
  PASSPORT_RECEIVED: "Passport Received",
  DECIDED: "Decision Received",
  VISA_GRANTED: "Visa Granted",
  VISA_REFUSED: "Visa Refused",
  CLOSED: "Application Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};
```

Chip tints (spec spirit): new mid-pipeline statuses use AMBER/BLUE/VIOLET as fits; `VISA_GRANTED` → EMERALD; `VISA_REFUSED` → ROSE; `PASSPORT_RECEIVED` → ORANGE; `UNDER_PROCESS` → BLUE; etc. Every key required.

- [ ] **Step 2: Fix `cases.ts` derive call**

```ts
  const derivedCaseStatus = crm.deriveCaseStatusFromApplicants(
    updatedCase.caseStatus,
    updatedApplicants.map((applicant) => applicant.outcome),
    {
      isGroup: crm.isCaseGroup({
        groupName: updatedCase.groupName,
        applicantCount: updatedApplicants.length,
      }),
    },
  );
```

- [ ] **Step 3: Typecheck + targeted tests**

Run: `pnpm --filter @rgs/shared typecheck && pnpm --filter @rgs/api typecheck && pnpm --filter @rgs/admin typecheck`
Expected: PASS

Run: `pnpm --filter @rgs/shared test`  
Run a subset of api case/status tests — expect PASS except statusNotify body assertions if labels changed (fix those expectations to new labels like `Documents Under Review`).

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "$(cat <<'EOF'
chore(crm): sweep IN_PROGRESS to DOCS_UNDER_REVIEW across api and admin

EOF
)"
```

---

### Task 4: Shared template schema + default copy

**Files:**
- Create: `packages/shared/src/crm/statusEmailDefaults.ts`
- Modify: `packages/shared/src/crm/schemas.ts`
- Modify: `packages/shared/src/crm/index.ts`
- Create: `packages/shared/test/crm/statusEmailDefaults.test.ts`

**Interfaces:**
- Produces:
```ts
export const STATUS_EMAIL_PHONE = "+91 98180 67432 / 011-41011617";

export function defaultStatusEmailTemplate(
  caseStatus: CaseStatus,
): { subject: string; body: string; enabled: boolean };

export const StatusEmailTemplateSchema = z.object({
  tenantId: z.string().min(1),
  caseStatus: z.enum(CASE_STATUSES),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  enabled: z.boolean(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().email().or(z.literal("")),
});
export type StatusEmailTemplate = z.infer<typeof StatusEmailTemplateSchema>;

export const UpsertStatusEmailTemplateBodySchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  enabled: z.boolean(),
});
```

- [ ] **Step 1: Failing test — every status has a default**

```ts
import { CASE_STATUSES, defaultStatusEmailTemplate } from "../../src/crm";

it("provides a default subject and body for every case status", () => {
  for (const caseStatus of CASE_STATUSES) {
    const template = defaultStatusEmailTemplate(caseStatus);
    expect(template.subject.length).toBeGreaterThan(0);
    expect(template.body.length).toBeGreaterThan(0);
    expect(template.enabled).toBe(true);
  }
});

it("uses feedback placeholders in Application Received", () => {
  const template = defaultStatusEmailTemplate("NEW");
  expect(template.body).toContain("{{clientName}}");
  expect(template.body).toContain("{{applicationId}}");
  expect(template.body).toContain("{{phone}}");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/statusEmailDefaults.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement defaults**

Port copy from the feedback doc into `statusEmailDefaults.ts`. Map bracket tokens to `{{…}}`. For statuses without feedback prose (off-ramps), short bodies:

```
Dear {{clientName}},
Your application {{applicationId}} has been marked as {{/* use plain words per status */}}.
Regards, Rays Global Services (RGS)
📞 {{phone}}
```

Default **subject** for each status (seed):

`{{applicationId}} – <Label> – {{clientName}} – {{countryVisaType}}`

where `<Label>` matches admin `CASE_STATUS_LABELS` wording (hard-code the same strings here to avoid importing admin).

Happy-path bodies follow the doc (Visa Granted / Refused / Decision Received / etc.). Group Decision Received body must include `{{applicantsBlock}}`.

- [ ] **Step 4: Add zod schemas + export**

- [ ] **Step 5: Run tests — PASS**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/statusEmailDefaults.test.ts test/crm/schemas.test.ts`
Expected: PASS (extend schemas.test if you add round-trip cases)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/crm/statusEmailDefaults.ts packages/shared/src/crm/schemas.ts packages/shared/src/crm/index.ts packages/shared/test/crm/statusEmailDefaults.test.ts packages/shared/test/crm/schemas.test.ts
git commit -m "$(cat <<'EOF'
feat(crm): status email template schema and seeded default copy

EOF
)"
```

---

### Task 5: Template persistence + placeholder renderer

**Files:**
- Modify: `services/api/src/domain/crm/keys.ts`
- Create: `services/api/src/domain/crm/statusEmailTemplates.ts`
- Create: `services/api/src/domain/crm/statusEmailRender.ts`
- Create: `services/api/test/crm/statusEmailTemplates.test.ts`
- Create: `services/api/test/crm/statusEmailRender.test.ts`

**Interfaces:**
- Produces:
```ts
export function statusEmailTemplatePartitionKey(tenantId: string, caseStatus: crm.CaseStatus): string;
// → TENANT#${tenantId}#STATUS_EMAIL_TEMPLATE#${caseStatus}

export async function getStatusEmailTemplate(...): Promise<crm.StatusEmailTemplate | undefined>;
export async function listStatusEmailTemplates(...): Promise<crm.StatusEmailTemplate[]>;
export async function upsertStatusEmailTemplate(...): Promise<crm.StatusEmailTemplate>;
export async function resetStatusEmailTemplate(...): Promise<crm.StatusEmailTemplate>;
export async function seedStatusEmailTemplatesIfAbsent(context, tenantId, actorEmail): Promise<number>;

export type StatusEmailVars = {
  clientName: string;
  countryVisaType: string;
  applicationId: string;
  appointmentDate: string;
  appointmentTime: string;
  centre: string;
  applicantsBlock: string;
  phone: string;
};

export function renderStatusEmail(template: string, vars: StatusEmailVars): string;
```

`listStatusEmailTemplates` returns one entry per `CASE_STATUSES` value: stored row if present, else in-memory default (with empty `updatedAt`/`updatedBy` or synthetic) — pick one rule and test it: **prefer** returning stored-or-default objects that always validate, marking defaults with `updatedBy: ""` and `updatedAt` = seed time only when persisted.

`renderStatusEmail`: replace all `{{token}}`; then drop lines that are empty or whitespace-only after replacement.

- [ ] **Step 1: Failing render test**

```ts
it("drops a line that becomes blank after substitution", () => {
  const rendered = renderStatusEmail(
    "Hello {{clientName}}\nAppointment: {{appointmentDate}} at {{appointmentTime}} at {{centre}}\nBye",
    {
      clientName: "Asha",
      countryVisaType: "UAE Tourist",
      applicationId: "31377",
      appointmentDate: "",
      appointmentTime: "",
      centre: "",
      applicantsBlock: "",
      phone: "+91 …",
    },
  );
  expect(rendered).toBe("Hello Asha\nBye");
  expect(rendered).not.toContain("{{");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusEmailRender.test.ts`

- [ ] **Step 3: Implement render + templates domain**

Use `putIfAbsent` for seed (same pattern as ref claims). `upsert` overwrites. `reset` writes `defaultStatusEmailTemplate(status)` fields with `updatedAt/By`.

- [ ] **Step 4: Tests for upsert / reset / seed idempotent**

```ts
it("seed inserts defaults once; second seed inserts zero", async () => {
  const context = buildTestContext();
  const first = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
  const second = await seedStatusEmailTemplatesIfAbsent(context, TENANT_ID, ACTOR);
  expect(first).toBe(crm.CASE_STATUSES.length);
  expect(second).toBe(0);
});
```

- [ ] **Step 5: Run — PASS**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusEmailRender.test.ts test/crm/statusEmailTemplates.test.ts`

- [ ] **Step 6: Commit**

```bash
git add services/api/src/domain/crm/keys.ts services/api/src/domain/crm/statusEmailTemplates.ts services/api/src/domain/crm/statusEmailRender.ts services/api/test/crm/statusEmailRender.test.ts services/api/test/crm/statusEmailTemplates.test.ts
git commit -m "$(cat <<'EOF'
feat(api): persist status email templates and render placeholders

EOF
)"
```

---

### Task 6: Rewrite `statusNotify` + notify on create

**Files:**
- Modify: `services/api/src/domain/crm/statusNotify.ts`
- Modify: `services/api/src/domain/crm/cases.ts` (`createCase` after `CASE_CREATED`)
- Modify: `services/api/src/domain/crm/crmEvents.ts` / `eventCopy` meta docs if needed
- Modify: `services/api/test/crm/statusNotify.test.ts` (and any createCase tests counting emails)
- Modify: `apps/admin/src/crm/case/eventCopy.ts` + Timeline tests
- Modify: `services/api/test/helpers.ts` — call `seedStatusEmailTemplatesIfAbsent` inside `buildTestContext` **or** document that mail tests must seed; **prefer seeding in helpers** so create+mail works everywhere

**Interfaces:**
- Produces:
```ts
export async function notifyOnCaseStatusChange(
  context, tenantId, crmCase, fromStatus, toStatus, actorEmail,
): Promise<void>;

export async function notifyOnCaseCreated(
  context, tenantId, crmCase, actorEmail,
): Promise<void>;
```
- Event meta for create notifies: `{ channel: "email", toAddress, toStatus, reason: "CREATE" }`
- Event meta for changes: keep `{ channel, toAddress, fromStatus, toStatus }`

- [ ] **Step 1: Rewrite statusNotify tests for templated copy**

Examples of new expectations:

- After seed + change to `DOCS_UNDER_REVIEW`, body contains `Documents Under Review` or feedback phrase `under document review` (match whatever default body you seeded).
- Subject still contains `caseRef` and country name.
- Group body contains `{{applicantsBlock}}` rendered lines (REF – name – outcome).
- Disabled template: `upsert` with `enabled: false` for `DOCS_UNDER_REVIEW`, change status → `sentEmails` length 0, case status still updated.
- Create: partner with email → exactly one email with NEW template; then change status → second email for new status.

Remove assertions that require the old `is now X (was Y)` sentence.

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusNotify.test.ts`

- [ ] **Step 3: Implement notify**

Pseudo:

```ts
async function sendStatusTemplateMail(...) {
  const template = await getStatusEmailTemplate(context, tenantId, toStatus);
  const effective = template ?? /* do not send */ undefined;
  if (effective === undefined || !effective.enabled) return;
  const travellers = await resolveCaseTravellers(...);
  const vars = buildVars(crmCase, travellers);
  const subject = renderStatusEmail(effective.subject, vars);
  const bodyText = renderStatusEmail(effective.body, vars);
  // partner + client loop unchanged
}
```

`buildVars`: `clientName` = groupName ?? first applicant name; `countryVisaType` = `${countryName}` + optional visa label; `applicantsBlock` = joined lines only when `isCaseGroup`; appointment date formatted as today when set else `""`.

`createCase`: after `CASE_CREATED`, `await notifyOnCaseCreated(...)`.

- [ ] **Step 4: Fix email-count fallout**

Any test that creates a case with a partner `contactEmail` and asserts `sentEmails` length must account for the create mail. Grep `sentEmails` and fix.

- [ ] **Step 5: Timeline copy for CREATE**

```ts
case "PARTNER_NOTIFIED":
case "CLIENT_NOTIFIED":
  // if meta.reason === "CREATE" → "… emailed at {to} on create ({toStatus})"
  // else existing transition copy
```

- [ ] **Step 6: Run api + admin timeline tests — PASS**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusNotify.test.ts test/crm/cases.test.ts`
Run: `pnpm --filter @rgs/admin exec vitest run test/crm/Timeline.test.tsx`

- [ ] **Step 7: Commit**

```bash
git add services/api/src/domain/crm/statusNotify.ts services/api/src/domain/crm/cases.ts services/api/test/helpers.ts services/api/test/crm/statusNotify.test.ts services/api/test/crm/cases.test.ts apps/admin/src/crm/case/eventCopy.ts apps/admin/test/crm/Timeline.test.tsx
git commit -m "$(cat <<'EOF'
feat(api): send configurable status emails on create and status change

EOF
)"
```

---

### Task 7: HTTP routes for templates

**Files:**
- Modify: `services/api/src/http/crmApi.ts`
- Modify: `services/api/test/crm/crmApi.test.ts`
- Modify: `services/api/test/http/routeAccessMatrix.test.ts` if it enumerates routes

**Interfaces:**
- `GET /api/v1/admin/crm/status-email-templates` — `requireScreen(..., "crm")` → `{ templates: StatusEmailTemplate[] }`
- `GET /api/v1/admin/crm/status-email-templates/{caseStatus}` — 404 if you only return stored; **or** return default — match list behaviour from Task 5
- `PUT /api/v1/admin/crm/status-email-templates/{caseStatus}` — `requireWrite` body `UpsertStatusEmailTemplateBodySchema`
- `POST /api/v1/admin/crm/status-email-templates/{caseStatus}/reset` — `requireWrite`

Validate `caseStatus` with `z.enum(CASE_STATUSES)` or 400.

- [ ] **Step 1: Failing route tests** (write + read + reset + write-guard)

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Wire routes**

- [ ] **Step 4: Run — PASS**

Run: `pnpm --filter ./services/api exec vitest run test/crm/crmApi.test.ts test/http/routeAccessMatrix.test.ts`

- [ ] **Step 5: Commit**

```bash
git add services/api/src/http/crmApi.ts services/api/test/crm/crmApi.test.ts services/api/test/http/routeAccessMatrix.test.ts
git commit -m "$(cat <<'EOF'
feat(api): admin routes for status email templates

EOF
)"
```

---

### Task 8: Migration CLIs — rename statuses + seed templates

**Files:**
- Create: `services/migration/src/backfillCaseStatusRename.ts`
- Create: `services/migration/src/runBackfillCaseStatusRenameCli.ts`
- Create: `services/migration/src/backfillCaseStatusRenameCli.ts`
- Create: `services/migration/src/seedStatusEmailTemplates.ts`
- Create: `services/migration/src/seedStatusEmailTemplatesCli.ts` (+ run wrapper)
- Create: `services/migration/test/backfillCaseStatusRename.test.ts`
- Create: `services/migration/test/seedStatusEmailTemplates.test.ts`
- Modify: `services/migration/package.json` scripts:
  - `"backfill:case-status-rename": "tsx src/backfillCaseStatusRenameCli.ts"`
  - `"seed:status-email-templates": "tsx src/seedStatusEmailTemplatesCli.ts"`

**Interfaces:**
- Rename: scan case META items (same case-scan pattern as `backfillRefClaims`); if `caseStatus === "IN_PROGRESS"` (string on raw item) or already typed legacy, rewrite case + GSI1PK via existing `writeCase` / table put so GSI1 updates.
- Because shared types no longer include `IN_PROGRESS`, the migrator must read **raw** attribute maps or cast carefully when detecting the old value.
- Seed: call `seedStatusEmailTemplatesIfAbsent`.

- [ ] **Step 1: Failing rename test** — put a raw item with `caseStatus: "IN_PROGRESS"` and old GSI1PK; run backfill; expect `DOCS_UNDER_REVIEW` and new GSI1PK.

- [ ] **Step 2: Implement + idempotent second run**

- [ ] **Step 3: Seed tests**

- [ ] **Step 4: Run migration package tests — PASS**

Run: `pnpm --filter @rgs/migration test`

- [ ] **Step 5: Commit**

```bash
git add services/migration
git commit -m "$(cat <<'EOF'
feat(migration): rename IN_PROGRESS cases and seed status email templates

EOF
)"
```

---

### Task 9: Admin Status emails page + client

**Files:**
- Modify: `apps/admin/src/crm/api/crmClient.ts`
- Create: `apps/admin/src/crm/statusEmails/StatusEmailsPage.tsx`
- Create: `apps/admin/test/crm/StatusEmailsPage.test.tsx`
- Modify: `apps/admin/src/main.tsx` — route under CRM access:
  - `path="/crm/status-emails"` wrapping same auth/screen guard as `/crm`
- Modify: ledger or shell nav — add a text link “Status emails” near CRM chrome (LedgerPage header actions or AdminShell CRM nav if one exists; if none, a link on Ledger toolbar is enough)
- Modify: `apps/admin/test/crm/labels.test.ts` / Chip tests if they enumerate statuses

**Interfaces:**
- Client:
```ts
listStatusEmailTemplates(): Promise<{ templates: StatusEmailTemplate[] }>
putStatusEmailTemplate(caseStatus, body): Promise<StatusEmailTemplate>
resetStatusEmailTemplate(caseStatus): Promise<StatusEmailTemplate>
```

UI: table of status label + enabled; row opens drawer with subject/body textareas, placeholder cheat-sheet (`{{clientName}}` …), Preview panel using sample vars, Save, Reset to default. Write role only for mutations (mirror other CRM write buttons).

- [ ] **Step 1: Component test — renders list from client mock, saves PUT**

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement page + route + client**

- [ ] **Step 4: Run admin tests — PASS**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm/StatusEmailsPage.test.tsx test/crm/labels.test.ts test/crm/Chip.test.tsx`

- [ ] **Step 5: Full verification**

Run: `pnpm --filter @rgs/shared test && pnpm --filter ./services/api exec vitest run test/crm && pnpm --filter @rgs/migration test && pnpm --filter @rgs/admin test`
Expected: PASS (ignore only pre-existing baseline failures documented on main, if any still apply — re-check before claiming)

- [ ] **Step 6: Commit**

```bash
git add apps/admin
git commit -m "$(cat <<'EOF'
feat(admin): Status emails settings screen for editable templates

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec section | Task |
|--------------|------|
| §3 statuses + rename | 1, 3, 8 |
| §3.3–3.4 transitions + derive | 2 |
| §3.5 normalize | 1 |
| §4 templates storage/placeholders/send | 4, 5, 6 |
| §4.4 create notify | 6 |
| §5 API | 7 |
| §6 Admin UI | 3 (labels/chips), 9 |
| §7 Migration | 8 |
| §8 out of scope | not planned |
| §9 tests | each task |

No TBD placeholders remain. `deriveCaseStatusFromApplicants` options object is consistent across Task 2 and Task 3/6. Review Focus items each name a pinning task.
