# CRM Ledger, Case Screen and Agent Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give RGS a working interface over the CRM they already own — one Excel-shaped Ledger of every case, a Case drill-down, and a persistent agent panel beside both — plus the one backend read model the Ledger cannot exist without.

**Architecture:** A new `apps/admin/src/crm/` directory routed at `/crm/*` inside the existing admin app (same React 19 / Vite / Tailwind 4 / react-router / TanStack Query / Cognito host, no second login). Behind it, one new projection route — `GET /api/v1/admin/crm/cases/ledger` — that reads case META items straight off GSI1/GSI2 and never reassembles a case, fed by a per-case `applicantSummary` computed inside `writeCase` so it cannot drift. Every write the human makes goes to the existing REST mutators; every write the *agent* makes stays behind the existing approval gate.

**Tech Stack:** TypeScript strict (ESM, no file extensions on local imports), React 19, Vite 6, Tailwind 4, react-router 7, TanStack Query 5, TanStack Virtual 3, Vitest 2 + Testing Library, Zod 3, DynamoDB single-table via the existing `TableClient` port.

**Spec:** `docs/superpowers/specs/2026-09-11-rgs-crm-ledger-design.md` (the binding document for this slice), whose parent is `docs/superpowers/specs/2026-09-09-rgs-crm-design.md`. Executors read both; where they disagree the parent wins except where the child gives a reason.

## Global Constraints

- Node >= 22, pnpm workspace. TypeScript strict with `noUncheckedIndexedAccess: true`.
- **ESM only: local imports carry no file extension.** `import { foo } from "./bar"`, never `"./bar.js"`.
- **Descriptive variable names.** Repo owner's standing rule. No `x`, `res`, `tmp`, `d`, `i`.
- **`services/api/src/domain/crm/keys.ts` is the ONLY file permitted to write a CRM DynamoDB key as a string literal.** Every new key shape gets a builder there.
- **`services/api/src/http/router.ts` maps only `ApiError` subclasses.** A bare `.parse()` ZodError becomes a 500. Use `parseBody` / `parseQueryParam` / `badRequest`.
- **The CDK admin route `/api/v1/admin/{proxy+}` declares GET/POST/PUT/DELETE and NO PATCH** (`infra/lib/rgs-platform-stack.ts:213-221`). Use PUT. A PATCH route passes every unit test and then 404s in the deployed environment.
- **`Router.match` returns the FIRST route whose segment count and literals match** (`services/api/src/http/router.ts:57-75`). A literal route must be registered BEFORE a same-length parameterised one or the parameterised one swallows it. This bites twice in this plan: `/crm/cases/ledger` vs `/crm/cases/{caseId}`, and `/crm/review/summary` vs `/crm/review/{reviewItemId}`.
- **API Gateway v2 collapses a repeated query parameter into one comma-joined string** and `RequestContext.queryParams` is `Record<string, string>` (`router.ts:5-12`). "Repeatable `status`" is therefore `?status=NEW,SUBMITTED`, parsed by splitting on commas.
- **`services/api/src/lib/tableRetry.ts:212-221` returns an object literal implementing `TableClient`, and `handler.ts:72` wraps the production table in it.** Any method added to the `TableClient` interface MUST be delegated there, or the route works in every unit test and throws `is not a function` in production.
- Every domain mutation takes `(context, tenantId, ..., actorEmail)` in that order and records a CRM event. Follow `services/api/src/domain/crm/cases.ts`.
- `context.now()` for all time in API code. Never `new Date()` inside domain code.
- Listing endpoints answer `{ <records>, unreadable<Record>Ids }` and never let one corrupt row take a screen down. New listings follow this; new clients read them through `unwrapListingResponse` (`packages/shared/src/listings.ts`).
- **Colour `--crm-primary` (`#5645d4`) appears on exactly one control in the whole product: Approve on an agent proposal card.** Not Save, not Create Case, not Resolve.
- **Buttons are 8px rectangles, never pills.** Radii: 4px chips, 6px badges, 8px buttons and inputs, 12px cards.
- **Body type 14px / 1.45; ledger row height 32px.** The fetched Notion `DESIGN.md` describes a marketing site at 16/1.55 — its brand language is used, its type scale is not (spec §3).
- **Enum values are never rendered raw.** Every user-visible label comes from the single label map in `apps/admin/src/crm/labels.ts`.
- A test that does not go red when you break the line it covers has not tested anything. Before committing any task, delete or invert the line your new test targets and confirm the test fails.

---

## Scope: what this plan deliberately excludes

Named in spec §11, repeated here so an executor does not "helpfully" add them:

| Excluded | Why |
|---|---|
| Today screen | Needs the watchdog detection engine, which does not exist in the codebase. |
| Partners screen | 257 agencies, alias management, revenue. Real work, lands second with no adoption risk. |
| Memory screen | Memories are cited and deletable *from the agent panel* in this slice, which is the AX requirement. |
| Mobile layout | The desk is a desktop. |
| Bulk merge resolution | Depends on what §7's inline resolution reveals about how RGS works the queue. |
| Playwright / any end-to-end harness | There is none in this repo; adding one is its own decision. |
| A bulk agent write tool | Spec §6 decides against it with two reasons. The panel makes N proposals and N approvals. |

---

## Established facts, measured in the codebase on 2026-09-11 at `main` = `88b5c46`

Do not re-derive these; do not assume anything beyond them.

**Backend, exists and is ready to build on:**

- `writeCase` (`services/api/src/domain/crm/caseStore.ts:19-53`) destructures `{ applicants, ...caseBody }` and puts `caseBody` on the META item with `GSI1PK = caseStatusGsi1Pk(tenantId, caseStatus)`, `GSI1SK = updatedAt`, `GSI2PK = partnerCasesGsi2Pk(tenantId, partnerId)`, `GSI2SK = receivedDate`. **Every case-level column the Ledger shows is already on that one item.**
- Every mutator — `changeCaseStatus`, `changeApplicantCustody`, `changeApplicantOutcome`, `changeBillingStatus`, `updateCaseDetails`, `createCase` — reassembles the whole case and calls `writeCase`. There is exactly one write path (`cases.ts`).
- `DynamoTableClient.runQuery` (`db.ts:117-160`) drains every page, so an unbounded query returns a whole partition rather than silently truncating it. It has **no** `ExclusiveStartKey` parameter exposed to callers and **no** `ProjectionExpression`.
- `TableClient` is `{ get, put, delete, query, queryGsi }` (`db.ts:44-58`). `InMemoryTableClient` implements it over a `Map` and is always strongly consistent.
- Every GSI is `ProjectionType.ALL` (`infra/lib/rgs-platform-stack.ts:41-46`), so a `ProjectionExpression` on a GSI query is legal and reduces response bytes.
- `listCasesByStatus` defaults `limit` to **50**, takes one status, and calls `readCase` per case — one strongly-consistent GetItem plus one strongly-consistent Query each. 7,156 cases is 14,312 sequential round-trips.
- `countCasesByField` (`cases.ts:520-560`) already demonstrates the pattern this plan generalises: read META items off GSI1, use the attributes that are already there, reassemble nothing.
- `crm.ReviewItem` is keyed on **`caseRef`, not `caseId`** (`packages/shared/src/crm/reviewItem.ts:57-79`). Joining review items to Ledger rows is a join on `caseRef`.
- `listReviewItems` is capped at 200 with a `hasMore` flag and has no cursor (`reviewQueue.ts:122-147`). The real import produced 3,958 OPEN items.
- Review resolution is **`PUT /api/v1/admin/crm/review/{reviewItemId}/resolve`** — spec §2 says POST; the code says PUT (`crmApi.ts:245`) and the CDK has no PATCH but does have PUT. **The code wins.**
- Proposal approve/discard are **PUT**, not POST: `PUT .../agent/proposals/{proposalId}/approve` and `.../discard` (`agentApi.ts:346,394`). Spec §2 says POST. **The code wins.**
- `POST /api/v1/admin/crm/agent/turn` validates the replayed `conversation` strictly (`agentApi.ts:100-220`): a `tool_result` must carry `toolName` AND a `toolCallId` naming a call on the *immediately preceding* assistant message; only an assistant message may carry `toolCalls`; an assistant message must carry text, tool calls or both; ids cap at 256 chars; the whole replay caps at 100,000 chars counted as `content + toolCallId + toolName + JSON.stringify(input)` per message.
- `AgentTurnResult` is `{ reply, proposals, appliedChanges, toolCallsMade, stoppedAtIterationCap, usage }` (`loop.ts:36-63`). `appliedChanges` are already applied; `proposals` are PENDING.
- `ProposedChange` is `{ proposalId, toolName, input, summary: {field,from,to}[], caseId?, proposedBy, proposedAt, status, decidedBy?, decidedAt?, discardReason? }` (`approval.ts:26-41`).
- `CrmEvent` is `{ eventId, eventType, caseId, actorEmail, meta: Record<string, string|number|boolean>, createdAt }`; `PROPOSAL_APPROVED` carries `meta.autoApplied` (`crmEvents.ts:21-50`).
- `GET .../agent/memories?scope=ORG|PARTNER|USER[&partnerId=]` answers `recallMemories(...)`; `DELETE .../agent/memories/{memoryKey}?scope=...` answers `{ forgotten: boolean }` — honest about whether anything was there (`agentApi.ts:432-511`).
- `CrmUserPrefs.trustLevel` defaults to 0 and `autoApplyOptIn` to false, and **nothing in production writes them** — `recordConfirmedWithoutEdit` only bumps a counter. The panel's trust indicator reads "level 0, auto-apply off" and that is the truth.

**Frontend, exists and is ready to build on:**

- `apps/admin` runs React 19.1, Vite 6, Tailwind 4 via `@tailwindcss/vite`, react-router 7, `@tanstack/react-query` 5.60, `amazon-cognito-identity-js`, `@rgs/shared` (`apps/admin/package.json`).
- `main.tsx` mounts one `QueryClient` (`retry: 1, staleTime: 30_000`), one `AuthProvider`, one `BrowserRouter` with a `RequireAuth` wrapper around every page.
- `useAuth()` yields `{ isLoading, isSignedIn, email, idToken, signOut, ... }` (`apps/admin/src/lib/auth.tsx`). `idToken` is the bearer token every API call passes.
- `apps/admin/src/lib/adminApi.ts` is the client pattern: a module-private `apiFetch<T>(path, { method, body, idToken })` that throws `ApiRequestError(statusCode, code, message)`, plus a `fetchListing` helper built on `unwrapListingResponse`.
- `apps/admin/src/styles.css` is `@import "tailwindcss"` plus an `@theme` block of CSS custom properties. Tailwind 4 needs no config file.
- **`apps/admin` has NO test runner today** — its `test` script is `echo "admin verified via typecheck + e2e"`. Task 7 installs one.
- **Neither `@tanstack/react-virtual` nor any Testing Library package is in `pnpm-lock.yaml`.** Both are new dependencies.

---

## File structure

**Shared package** — types both sides parse against:

| File | Responsibility |
|---|---|
| `packages/shared/src/crm/ledger.ts` (new) | `ApplicantSummary`, `LedgerRow`, their Zod schemas, `emptyApplicantSummary()`, `summariseApplicants()`. The one definition of a Ledger row, imported by the API projection AND the React client. |
| `packages/shared/src/crm/index.ts` (modify) | Re-export `./ledger`. |

**API** — one new read model, one new summary read, no new writes:

| File | Responsibility |
|---|---|
| `services/api/src/lib/db.ts` (modify) | `projection` on `QueryOptions`; `queryGsiPage` + `QueryPage` + `TableItemKey` on `TableClient`; both adapters implement them. |
| `services/api/src/lib/tableRetry.ts` (modify) | Delegate `queryGsiPage`. |
| `services/api/src/domain/crm/ledger.ts` (new) | `listLedgerRows` — the projection read, the status/partner routing, and the cursor codec. |
| `services/api/src/domain/crm/caseStore.ts` (modify) | Compute `applicantSummary` inside `writeCase`. |
| `services/api/src/domain/crm/reviewQueue.ts` (modify) | `summariseOpenReviewItems` — caseRef → item ids + reason kinds, over the whole OPEN partition. |
| `services/api/src/http/crmApi.ts` (modify) | `GET .../cases/ledger` and `GET .../review/summary`, each registered before its parameterised sibling. |
| `services/migration/src/backfillApplicantSummary.ts` (new) | Re-runnable backfill that gives the 7,156 already-imported cases the summary `writeCase` now computes. |

**Admin app** — a new directory that does not touch the existing visa-platform pages:

| File | Responsibility |
|---|---|
| `apps/admin/src/crm/theme.css` | The Notion token block, as Tailwind 4 `@theme` custom properties. |
| `apps/admin/src/crm/labels.ts` | The single display-label map for every enum, and the four axes' chip tints. |
| `apps/admin/src/crm/components/Chip.tsx` | `<AxisChip>` — one component, four axes, the `UNKNOWN` dashed case. |
| `apps/admin/src/crm/api/crmClient.ts` | Typed fetch wrappers for every CRM route this slice touches. |
| `apps/admin/src/crm/api/hooks.ts` | TanStack Query hooks: `useLedgerRows`, `useCase`, `useCaseEvents`, `usePartners`, `useReviewSummary`, `useReviewItem`, and the mutation hooks with optimistic update + rollback. |
| `apps/admin/src/crm/ledger/LedgerPage.tsx` | The screen: filter bar, view chips, virtualized table, panel splitter. |
| `apps/admin/src/crm/ledger/LedgerTable.tsx` | Virtualized rows, sticky header + REF column, applicant sub-rows. |
| `apps/admin/src/crm/ledger/useGridKeyboard.ts` | The fixed keymap and focus/selection state machine. |
| `apps/admin/src/crm/ledger/EditableCell.tsx` | Inline edit, commit on blur, Esc restore, Cmd/Ctrl+Enter commit-and-stay. |
| `apps/admin/src/crm/ledger/views.ts` | Saved views: a named set of filters plus a sort, per user, in `localStorage`. |
| `apps/admin/src/crm/ledger/ReviewMarker.tsx` | The §7 row marker and its inline resolve popover. |
| `apps/admin/src/crm/case/CasePage.tsx` | The drill-down: shared fields, applicants table, line items, notes, timeline. |
| `apps/admin/src/crm/case/Timeline.tsx` | The audit surface, including the auto-applied/human-approved distinction. |
| `apps/admin/src/crm/agent/AgentPanel.tsx` | The persistent panel: transcript, proposals, memories, trust indicator. |
| `apps/admin/src/crm/agent/transcript.ts` | The client-side transcript state machine that must satisfy the route's pairing rules. |
| `apps/admin/src/crm/agent/ProposalCard.tsx` | One card, N proposals, editable before approval, per-item result reporting. |
| `apps/admin/src/crm/UndoToast.tsx` | The Escape Hatch, shared by every optimistic write. |

---

## Task order and what each one delivers

| # | Task | Deliverable a reviewer can reject on its own |
|---|---|---|
| 1 | `applicantSummary` on the META item | Every case write carries a roll-up; a test proves it moves when custody moves. |
| 2 | Projection + paged GSI reads | `TableClient` can ask for a subset of attributes and resume a partition. |
| 3 | The Ledger read model | `listLedgerRows` returns projected rows and a resumable cursor. |
| 4 | The Ledger route | `GET .../cases/ledger` answers, and cannot be swallowed by `{caseId}`. |
| 5 | The open-review summary and its route | Ledger markers have data to render from. |
| 6 | Backfill for the 7,156 imported cases | The real ledger renders roll-ups, not "not summarised". |
| 7 | The case-details route | A human can edit an appointment date without asking the agent to propose it. |
| 8 | Admin test harness, theme, labels, chips | `pnpm --filter @rgs/admin test` runs real tests; the design tokens exist once. |
| 9 | CRM API client + query hooks | Every route this slice uses is typed and tested against a stubbed `fetch`. |
| 10 | The virtualized Ledger table | 7,156 rows render, sticky header and REF, roll-ups on the collapsed parent. |
| 11 | Grid keyboard + selection | The fixed keymap from spec §4, tested key by key. |
| 12 | Inline edit, optimistic write, undo toast, 409 | A desk agent can edit the wrong row and take it back. |
| 13 | Applicant sub-rows and saved views | `→` discloses applicants; a view is a named filter set. |
| 14 | The Case screen | Shared fields, applicants, line items, notes, timeline with the auto-applied distinction. |
| 15 | The agent panel | Transcript that satisfies the route's pairing rules, proposal cards, memories, trust indicator. |
| 16 | Review markers in the Ledger | §7's inline data cleaning. |

**Tasks 1-7 are backend and ship on their own.** Tasks 8-16 are the interface. Task 6 is an operational step as much as a code one — see Manual Verification.

---

### Task 1: The applicant roll-up, computed where it cannot drift

**Files:**
- Create: `packages/shared/src/crm/ledger.ts`
- Modify: `packages/shared/src/crm/index.ts`
- Modify: `services/api/src/domain/crm/caseStore.ts:19-53` (`writeCase`)
- Test: `packages/shared/test/crm/ledger.test.ts` (create)
- Test: `services/api/test/crm/caseStore.test.ts` (extend)

**Interfaces:**
- Consumes: `crm.CaseApplicant`, `crm.CustodyStatus`, `crm.ApplicantOutcome` from `packages/shared/src/crm/statuses.ts` and `schemas.ts`.
- Produces:
  - `crm.ApplicantSummary` = `{ count: number; custody: Partial<Record<CustodyStatus, number>>; outcome: Partial<Record<ApplicantOutcome, number>> }`
  - `crm.summariseApplicants(applicants: readonly Pick<CaseApplicant, "custody" | "outcome">[]): ApplicantSummary`
  - `crm.ApplicantSummarySchema`, `crm.LedgerRow`, `crm.LedgerRowSchema` (the row type is defined here too; Task 3 is its first consumer).

**Why the summary is computed inside `writeCase` and nowhere else:** every mutator in `cases.ts` reassembles the whole case and calls `writeCase`. There is exactly one place a case can reach storage, so there is exactly one place the summary can be computed, and no way to persist a case without going through it. A summary computed in each mutator instead would be five places to forget.

**Why counts omit their zeros:** `Partial<Record<...>>` with only the non-zero entries, not nine keys per case. Nine zero-valued keys on 7,156 META items is roughly another megabyte on every Ledger page read, for information the reader already has (`count` minus the sum). Spec §2.1 writes it as `Record<CustodyStatus, number>`; this is the departure and that is the reason.

- [ ] **Step 1: Write the failing shared-package test**

Create `packages/shared/test/crm/ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LedgerRowSchema, summariseApplicants } from "../../src/crm/ledger";

describe("summariseApplicants", () => {
  it("counts each custody and outcome value that actually occurs", () => {
    const summary = summariseApplicants([
      { custody: "AT_EMBASSY", outcome: "PENDING" },
      { custody: "AT_EMBASSY", outcome: "PENDING" },
      { custody: "WITH_RGS", outcome: "APPROVED" },
    ]);

    expect(summary.count).toBe(3);
    expect(summary.custody).toEqual({ AT_EMBASSY: 2, WITH_RGS: 1 });
    expect(summary.outcome).toEqual({ PENDING: 2, APPROVED: 1 });
  });

  it("omits a state nobody is in rather than writing it as zero", () => {
    const summary = summariseApplicants([{ custody: "NOT_HELD", outcome: "PENDING" }]);

    expect(Object.keys(summary.custody)).toEqual(["NOT_HELD"]);
    expect(summary.custody.RETURNED).toBeUndefined();
  });

  it("summarises an empty applicant list as a count of zero, not as an error", () => {
    // A case cannot legally have no applicants, but a half-written partition
    // can, and a summariser that throws there turns a storage defect into a
    // crash in the one function every write path runs through.
    expect(summariseApplicants([])).toEqual({ count: 0, custody: {}, outcome: {} });
  });
});

describe("LedgerRowSchema", () => {
  const validRow = {
    caseId: "case_1",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-05T09:00:00.000Z",
    applicantSummary: { count: 1, custody: { WITH_RGS: 1 }, outcome: { PENDING: 1 } },
  };

  it("parses a projected META item", () => {
    expect(LedgerRowSchema.parse(validRow).caseRef).toBe("RGS-1001");
  });

  it("accepts a row with no applicantSummary, because 7,156 stored cases predate it", () => {
    const { applicantSummary: _omitted, ...rowWithoutSummary } = validRow;
    expect(LedgerRowSchema.parse(rowWithoutSummary).applicantSummary).toBeUndefined();
  });

  it("refuses a summary naming a custody state that does not exist", () => {
    expect(() =>
      LedgerRowSchema.parse({
        ...validRow,
        applicantSummary: { count: 1, custody: { LOST_IN_TRANSIT: 1 }, outcome: {} },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/ledger.test.ts`
Expected: FAIL — `Cannot find module '../../src/crm/ledger'`.

- [ ] **Step 3: Write `packages/shared/src/crm/ledger.ts`**

```ts
import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  CUSTODY_STATUSES,
  VISA_TYPES,
  type ApplicantOutcome,
  type CaseApplicant,
  type CustodyStatus,
} from "./statuses";

/**
 * How many applicants on a case are in each state, carried on the case's own
 * META item so the Ledger can show a roll-up without reading a single
 * applicant record.
 *
 * Only states that actually occur appear. A state nobody is in is absent, not
 * zero: nine zero keys on every one of 7,156 stored cases is about a megabyte
 * added to every Ledger page, and `count` minus the sum already says it.
 */
export interface ApplicantSummary {
  count: number;
  custody: Partial<Record<CustodyStatus, number>>;
  outcome: Partial<Record<ApplicantOutcome, number>>;
}

/**
 * A counts-by-state validator built from the state tuple itself, so adding a
 * custody state to `statuses.ts` cannot leave a second list here out of date.
 *
 * `.strict()`, not the default strip: an unknown key means a stored summary
 * names a state this build does not have, and stripping it would let the row
 * through carrying a count that silently vanished. Refused instead, which
 * lands the case in `unreadableCaseIds` where an operator can see it.
 *
 * The cast is the one place this file needs one: `z.object` over a computed
 * shape infers `ZodObject<Record<string, ...>>`, and the state union is what
 * every consumer actually wants to switch on.
 */
function stateCountsSchema<StateType extends string>(
  allowedStates: readonly StateType[],
): z.ZodType<Partial<Record<StateType, number>>> {
  const countsShape = Object.fromEntries(
    allowedStates.map((stateName) => [stateName, z.number().int().nonnegative().optional()]),
  );
  return z.object(countsShape).strict() as unknown as z.ZodType<Partial<Record<StateType, number>>>;
}

export const ApplicantSummarySchema: z.ZodType<ApplicantSummary> = z.object({
  count: z.number().int().nonnegative(),
  custody: stateCountsSchema(CUSTODY_STATUSES),
  outcome: stateCountsSchema(APPLICANT_OUTCOMES),
});

/**
 * The one computation of a case's roll-up. Called from `writeCase` and from
 * nowhere else in production code — see the comment there for why that is the
 * property worth protecting.
 */
export function summariseApplicants(
  applicants: readonly Pick<CaseApplicant, "custody" | "outcome">[],
): ApplicantSummary {
  const custodyCounts: Partial<Record<CustodyStatus, number>> = {};
  const outcomeCounts: Partial<Record<ApplicantOutcome, number>> = {};
  for (const applicant of applicants) {
    custodyCounts[applicant.custody] = (custodyCounts[applicant.custody] ?? 0) + 1;
    outcomeCounts[applicant.outcome] = (outcomeCounts[applicant.outcome] ?? 0) + 1;
  }
  return { count: applicants.length, custody: custodyCounts, outcome: outcomeCounts };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * One row of the Ledger: exactly the columns spec §4 lists, and nothing else.
 *
 * This is what the projection route reads off a case META item — never
 * `legacyRaw`, never `lineItems`, never the applicant records. The same type
 * is parsed on the server (to name a row it could not read) and consumed by
 * the React client, so a column added here is a column both sides agree on.
 *
 * `applicantSummary` is optional and that is a statement about real data, not
 * a convenience: 7,156 cases were imported before `writeCase` computed one.
 * The Ledger renders those as "not summarised" rather than as a fabricated
 * zero, and the Plan 5 backfill (`services/migration/src/backfillApplicantSummary.ts`)
 * is what removes them.
 */
export const LedgerRowSchema = z.object({
  caseId: z.string().min(1),
  caseRef: z.string().min(1),
  partnerId: z.string().min(1),
  destinationCountry: z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2"),
  caseType: z.enum(CASE_TYPES),
  visaType: z.enum(VISA_TYPES).optional(),
  caseStatus: z.enum(CASE_STATUSES),
  billingStatus: z.enum(BILLING_STATUSES),
  receivedDate: isoDate,
  appointmentDate: isoDate.optional(),
  totalInr: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  applicantSummary: ApplicantSummarySchema.optional(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;
```

Add to `packages/shared/src/crm/index.ts`, keeping the file's existing order:

```ts
export * from "./ledger";
```

- [ ] **Step 4: Run the shared test and watch it pass**

Run: `pnpm --filter @rgs/shared exec vitest run test/crm/ledger.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing `writeCase` test**

Append to `services/api/test/crm/caseStore.test.ts` (it already imports `writeCase`, `buildTestContext` and the key builders; add `META_SORT_KEY` and `casePartitionKey` to the existing import if they are not there):

```ts
describe("writeCase applicantSummary", () => {
  it("puts a roll-up of every applicant's custody and outcome on the META item", async () => {
    const context = buildTestContext();
    const crmCase = buildCase({
      applicants: [
        { applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" },
        { applicantRef: "A2", travellerId: "trav_2", custody: "AT_EMBASSY", outcome: "PENDING" },
      ],
    });

    await writeCase(context, crmCase);

    const metaItem = await context.table.get(
      casePartitionKey(crmCase.tenantId, crmCase.caseId),
      META_SORT_KEY,
    );
    expect(metaItem?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, AT_EMBASSY: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("moves the stored roll-up when one applicant's custody moves", async () => {
    // The property that matters: not that writeCase can compute a summary
    // once, but that no mutator can change an applicant without the stored
    // summary following. changeApplicantCustody goes through writeCase like
    // every other mutator, so this is the test that goes red if the
    // computation is ever lifted out of it.
    const context = buildTestContext();
    const crmCase = buildCase({
      applicants: [
        { applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" },
        { applicantRef: "A2", travellerId: "trav_2", custody: "WITH_RGS", outcome: "PENDING" },
      ],
    });
    await writeCase(context, crmCase);

    await changeApplicantCustody(
      context,
      crmCase.tenantId,
      crmCase.caseId,
      "A1",
      "AT_EMBASSY",
      "ops@rgs.test",
    );

    const metaItem = await context.table.get(
      casePartitionKey(crmCase.tenantId, crmCase.caseId),
      META_SORT_KEY,
    );
    expect(metaItem?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, AT_EMBASSY: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("drops a stale summary carried in on the case body rather than storing it", async () => {
    // CrmCaseSchema strips unknown keys, so a CrmCase cannot legally carry
    // applicantSummary -- but writeCase spreads ...caseBody onto the item, and
    // a caller that hand-built the object could. The computed value must win.
    const context = buildTestContext();
    const crmCase = buildCase({
      applicants: [{ applicantRef: "A1", travellerId: "trav_1", custody: "NOT_HELD", outcome: "PENDING" }],
    });

    await writeCase(context, {
      ...crmCase,
      applicantSummary: { count: 99, custody: { RETURNED: 99 }, outcome: {} },
    } as typeof crmCase);

    const metaItem = await context.table.get(
      casePartitionKey(crmCase.tenantId, crmCase.caseId),
      META_SORT_KEY,
    );
    expect(metaItem?.["applicantSummary"]).toEqual({
      count: 1,
      custody: { NOT_HELD: 1 },
      outcome: { PENDING: 1 },
    });
  });
});
```

If `caseStore.test.ts` has no `buildCase` helper, write one at the top of the new `describe` that returns a `crm.CrmCaseSchema.parse({...})` with `tenantId: "rgs"`, `caseId: "case_summary_1"`, `caseRef: "RGS-SUM-1"`, `caseType: "VISA"`, `visaType: "TOURIST"`, `partnerId: "partner_1"`, `destinationCountry: "AE"`, `caseStatus: "IN_PROGRESS"`, `billingStatus: "UNBILLED"`, `receivedDate: "2026-03-04"`, `createdAt`/`updatedAt` of `"2026-03-04T10:00:00.000Z"`, and the applicants the caller passes.

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/caseStore.test.ts -t "applicantSummary"`
Expected: FAIL — `expected undefined to equal { count: 2, ... }`.

- [ ] **Step 7: Compute the summary in `writeCase`**

In `services/api/src/domain/crm/caseStore.ts`, the META put becomes:

```ts
  await context.table.put({
    PK: partitionKey,
    SK: META_SORT_KEY,
    GSI1PK: caseStatusGsi1Pk(crmCase.tenantId, crmCase.caseStatus),
    GSI1SK: crmCase.updatedAt,
    GSI2PK: partnerCasesGsi2Pk(crmCase.tenantId, crmCase.partnerId),
    GSI2SK: crmCase.receivedDate,
    ...caseBody,
    // AFTER the spread, deliberately: a caller that hand-built a case object
    // carrying a stale applicantSummary must not be able to store it. The
    // computed value is the only one that can reach the item.
    //
    // Computed here and nowhere else because here is the only place a case
    // can reach storage -- every mutator in cases.ts reassembles the whole
    // case and calls this function -- so there is no way to persist a case
    // whose roll-up disagrees with its applicants. `readCase` never reads this
    // attribute back: CrmCaseSchema strips unknown keys, so the domain object
    // stays exactly what it was, and the Ledger projection (Plan 5 Task 3) is
    // the only reader.
    applicantSummary: crm.summariseApplicants(applicants),
  });
```

- [ ] **Step 8: Run the API test and watch it pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/caseStore.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove the test can fail**

Comment out the `applicantSummary:` line in `writeCase`, re-run the three new tests, confirm all three go red, then restore it.

- [ ] **Step 10: Full suite and commit**

```bash
pnpm --filter @rgs/shared test && pnpm --filter @rgs/api test && pnpm -r typecheck
git add packages/shared/src/crm/ledger.ts packages/shared/src/crm/index.ts packages/shared/test/crm/ledger.test.ts services/api/src/domain/crm/caseStore.ts services/api/test/crm/caseStore.test.ts
git commit -m "feat(crm): carry an applicant roll-up on every case META item"
```

---

### Task 2: Projected and resumable GSI reads

**Files:**
- Modify: `services/api/src/lib/db.ts`
- Modify: `services/api/src/lib/tableRetry.ts:212-221`
- Test: `services/api/test/db.test.ts` (extend)
- Test: `services/api/test/tableRetry.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, on `TableClient`:
  - `QueryOptions.projection?: readonly string[]` — attribute names to return. Applies to `query`, `queryGsi` and `queryGsiPage`.
  - `TableItemKey = Record<string, unknown>`
  - `QueryPage = { items: TableItem[]; nextStartKey?: TableItemKey }`
  - `PagedQueryOptions = QueryOptions & { startKey?: TableItemKey }`
  - `queryGsiPage(indexName: "GSI1" | "GSI2" | "GSI3", partitionKey: string, options?: PagedQueryOptions): Promise<QueryPage>`

**Context for the implementer.** `runQuery` drains every page on purpose — a lookup that concludes "no match" from a truncated page goes on to create a duplicate. `queryGsiPage` is the opposite contract and must not be built by adding a flag to `runQuery`: it fills **up to** `limit` items and hands back the key to resume from. DynamoDB's `Limit` caps what a page returns, so the collected count can never overshoot and nothing is ever sliced away with its cursor. Two invariants a reviewer should check: a page that exhausts its partition returns **no** `nextStartKey`, and a `startKey` handed back in is never re-read.

- [ ] **Step 1: Write the failing in-memory tests**

Append to `services/api/test/db.test.ts`:

```ts
describe("InMemoryTableClient projection and paging", () => {
  function buildPopulatedClient(itemCount: number): InMemoryTableClient {
    const tableClient = new InMemoryTableClient();
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
      const paddedIndex = String(itemIndex).padStart(3, "0");
      void tableClient.put({
        PK: `TENANT#rgs#CASE#case_${paddedIndex}`,
        SK: "META",
        GSI1PK: "TENANT#rgs#CASE_STATUS#NEW",
        GSI1SK: `2026-03-01T00:00:${paddedIndex.slice(1)}.000Z`,
        caseId: `case_${paddedIndex}`,
        caseRef: `RGS-${paddedIndex}`,
        legacyRaw: { STATUS: "a very long original spreadsheet row" },
      });
    }
    return tableClient;
  }

  it("returns only the projected attributes", async () => {
    const tableClient = buildPopulatedClient(1);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      projection: ["PK", "SK", "caseId", "caseRef"],
    });

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual(["PK", "SK", "caseId", "caseRef"].sort());
    expect(page.items[0]!["legacyRaw"]).toBeUndefined();
  });

  it("resumes exactly after the cursor, with no row read twice and none skipped", async () => {
    const tableClient = buildPopulatedClient(10);

    const firstPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 4 });
    expect(firstPage.items).toHaveLength(4);
    expect(firstPage.nextStartKey).toBeDefined();

    const secondPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 4,
      startKey: firstPage.nextStartKey,
    });
    const thirdPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 4,
      startKey: secondPage.nextStartKey,
    });

    const readCaseIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
      (item) => item["caseId"],
    );
    expect(readCaseIds).toHaveLength(10);
    expect(new Set(readCaseIds).size).toBe(10);
    expect(thirdPage.nextStartKey).toBeUndefined();
  });

  it("reports no cursor when the partition fits in one page", async () => {
    const tableClient = buildPopulatedClient(3);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 50 });

    expect(page.items).toHaveLength(3);
    expect(page.nextStartKey).toBeUndefined();
  });

  it("honours scanForward: false and still resumes correctly", async () => {
    const tableClient = buildPopulatedClient(6);

    const firstPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 2,
      scanForward: false,
    });
    const secondPage = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      limit: 2,
      scanForward: false,
      startKey: firstPage.nextStartKey,
    });

    expect(firstPage.items.map((item) => item["caseId"])).toEqual(["case_005", "case_004"]);
    expect(secondPage.items.map((item) => item["caseId"])).toEqual(["case_003", "case_002"]);
  });
});
```

- [ ] **Step 2: Write the failing DynamoDB-adapter tests**

Append to `services/api/test/db.test.ts`, reusing the existing `buildStubbedTableClient` harness at the top of that file:

```ts
describe("DynamoTableClient.queryGsiPage", () => {
  it("builds a ProjectionExpression with placeholder names", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      projection: ["PK", "caseStatus"],
    });

    const [queryInput] = capturedInputs;
    // Placeholders, never raw names: `status`-like attribute names are
    // DynamoDB reserved words and a raw ProjectionExpression 400s on them.
    expect(queryInput!.ProjectionExpression).toBe("#p0, #p1");
    expect(queryInput!.ExpressionAttributeNames).toMatchObject({
      "#p0": "PK",
      "#p1": "caseStatus",
      "#pk": "GSI1PK",
    });
  });

  it("stops at the limit instead of draining, and returns the key to resume from", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([
      { Items: [{ PK: "a", SK: "META" }, { PK: "b", SK: "META" }], LastEvaluatedKey: { PK: "b", SK: "META" } },
      { Items: [{ PK: "c", SK: "META" }] },
    ]);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 2 });

    expect(page.items.map((item) => item.PK)).toEqual(["a", "b"]);
    expect(page.nextStartKey).toEqual({ PK: "b", SK: "META" });
    // The second page must never have been requested. This is the half of the
    // claim that separates queryGsiPage from runQuery, and asserting only the
    // returned items would pass with a drained query too.
    expect(capturedInputs).toHaveLength(1);
  });

  it("forwards a supplied startKey as ExclusiveStartKey", async () => {
    const { tableClient, capturedInputs } = buildStubbedTableClient([{ Items: [] }]);

    await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
      startKey: { PK: "b", SK: "META" },
    });

    expect(capturedInputs[0]!.ExclusiveStartKey).toEqual({ PK: "b", SK: "META" });
  });

  it("reports no cursor when DynamoDB reports no LastEvaluatedKey", async () => {
    const { tableClient } = buildStubbedTableClient([{ Items: [{ PK: "a", SK: "META" }] }]);

    const page = await tableClient.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", { limit: 10 });

    expect(page.nextStartKey).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `pnpm --filter @rgs/api exec vitest run test/db.test.ts`
Expected: FAIL — `tableClient.queryGsiPage is not a function`.

- [ ] **Step 4: Extend `db.ts`**

Add to the type block:

```ts
/** A DynamoDB primary/index key, as both adapters hand it back. */
export type TableItemKey = Record<string, unknown>;

/** One page of a partition, plus where to resume if there is more. */
export interface QueryPage {
  items: TableItem[];
  /** Absent when the partition is exhausted -- never an empty object. */
  nextStartKey?: TableItemKey;
}

export interface PagedQueryOptions extends QueryOptions {
  startKey?: TableItemKey;
}
```

Add `projection` to `QueryOptions`:

```ts
  /**
   * Attribute names to return instead of the whole item. Every GSI in this
   * stack is ProjectionType.ALL, so this reduces response bytes rather than
   * index coverage -- which is the whole point on the Ledger read, where the
   * difference is 1.4 MB against 7-21 MB. Always include PK and SK: callers
   * filter on SK and recover a caseId from PK.
   */
  projection?: readonly string[];
```

Add to `TableClient`:

```ts
  /**
   * One page of a GSI partition, resumable. The opposite contract to
   * `queryGsi`, which drains: this fills up to `limit` and reports where to
   * continue. Use it when a caller pages a partition across HTTP requests;
   * use `queryGsi` when a truncated answer would be a wrong answer.
   */
  queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options?: PagedQueryOptions,
  ): Promise<QueryPage>;
```

In `DynamoTableClient`, factor the projection out and add the method:

```ts
  /**
   * Placeholders, never raw attribute names: `status`, `name`, `size` and a
   * hundred others are DynamoDB reserved words, and a raw name in a
   * ProjectionExpression is a ValidationException at runtime that no unit
   * test over the in-memory adapter would catch.
   */
  private static buildProjection(
    projection: readonly string[] | undefined,
    attributeNames: Record<string, string>,
  ): string | undefined {
    if (projection === undefined || projection.length === 0) return undefined;
    return projection
      .map((attributeName, attributeIndex) => {
        const placeholder = `#p${attributeIndex}`;
        attributeNames[placeholder] = attributeName;
        return placeholder;
      })
      .join(", ");
  }

  async queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: PagedQueryOptions = {},
  ): Promise<QueryPage> {
    const pkAttribute = `${indexName}PK`;
    const skAttribute = `${indexName}SK`;
    const hasSkPrefix = options.skPrefix !== undefined;
    const collectedItems: TableItem[] = [];
    let exclusiveStartKey: TableItemKey | undefined = options.startKey;

    do {
      const remainingLimit =
        options.limit === undefined ? undefined : options.limit - collectedItems.length;
      const attributeNames: Record<string, string> = { "#pk": pkAttribute };
      if (hasSkPrefix) attributeNames["#sk"] = skAttribute;
      const projectionExpression = DynamoTableClient.buildProjection(
        options.projection,
        attributeNames,
      );
      const result = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: indexName,
          KeyConditionExpression: hasSkPrefix ? `#pk = :pk AND begins_with(#sk, :skPrefix)` : `#pk = :pk`,
          ExpressionAttributeNames: attributeNames,
          ExpressionAttributeValues: hasSkPrefix
            ? { ":pk": partitionKey, ":skPrefix": options.skPrefix }
            : { ":pk": partitionKey },
          Limit: remainingLimit,
          ScanIndexForward: options.scanForward ?? true,
          ExclusiveStartKey: exclusiveStartKey,
          ...(projectionExpression !== undefined
            ? { ProjectionExpression: projectionExpression }
            : {}),
        }),
      );
      collectedItems.push(...((result.Items ?? []) as TableItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
      // Unlike runQuery this does NOT keep going once the limit is met: the
      // caller is paging, and the unread remainder is what nextStartKey is
      // for. DynamoDB's own Limit means collectedItems can never overshoot,
      // so nothing is ever sliced off behind its own cursor.
    } while (
      exclusiveStartKey !== undefined &&
      (options.limit === undefined || collectedItems.length < options.limit)
    );

    return {
      items: collectedItems,
      ...(exclusiveStartKey !== undefined ? { nextStartKey: exclusiveStartKey } : {}),
    };
  }
```

Thread `projection` through `runQuery` as well, by building `ExpressionAttributeNames` the same way and spreading `ProjectionExpression` when it is defined.

In `InMemoryTableClient`, add the projection to `filterAndSort` and implement the page:

```ts
  async queryGsiPage(
    indexName: "GSI1" | "GSI2" | "GSI3",
    partitionKey: string,
    options: PagedQueryOptions = {},
  ): Promise<QueryPage> {
    const pkAttribute = `${indexName}PK` as const;
    const skAttribute = `${indexName}SK` as const;
    // Ordered exactly as queryGsi would, and NOT limited yet: the cursor is a
    // position in this order, so slicing before finding it would lose it.
    const orderedItems = this.filterAndSort(
      (item) => item[pkAttribute] === partitionKey,
      (item) => String(item[skAttribute] ?? ""),
      { ...options, limit: undefined, projection: undefined },
    );

    const resumeIndex =
      options.startKey === undefined
        ? 0
        : orderedItems.findIndex(
            (item) =>
              item.PK === options.startKey!["PK"] && item.SK === options.startKey!["SK"],
          ) + 1;
    const pageSize = options.limit ?? orderedItems.length;
    const pageItems = orderedItems.slice(resumeIndex, resumeIndex + pageSize);
    const lastItem = pageItems[pageItems.length - 1];
    const hasMore = resumeIndex + pageItems.length < orderedItems.length;

    return {
      items: pageItems.map((item) => projectItem(item, options.projection)),
      ...(hasMore && lastItem !== undefined
        ? { nextStartKey: { PK: lastItem.PK, SK: lastItem.SK } }
        : {}),
    };
  }
```

with a module-level helper both in-memory paths use:

```ts
/**
 * The in-memory stand-in for ProjectionExpression. An attribute the item does
 * not have is simply absent from the result, exactly as DynamoDB returns it --
 * never present-and-undefined, which would read back as a null column.
 */
function projectItem(item: TableItem, projection: readonly string[] | undefined): TableItem {
  if (projection === undefined || projection.length === 0) return item;
  const projected: Record<string, unknown> = {};
  for (const attributeName of projection) {
    if (attributeName in item) projected[attributeName] = item[attributeName];
  }
  return projected as TableItem;
}
```

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm --filter @rgs/api exec vitest run test/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing delegation test**

`pnpm --filter @rgs/api typecheck` now fails: `withWriteRetries` returns an object literal that no longer satisfies `TableClient`. That compile error is the seam doing its job — but a compile error is not a test, and the production handler is the only caller. Append to `services/api/test/tableRetry.test.ts`:

```ts
it("forwards queryGsiPage to the wrapped table, because reads are not retried but must still work", async () => {
  const pagedReads: { indexName: string; partitionKey: string; startKey: unknown }[] = [];
  const retryingTable = withWriteRetries({
    ...new InMemoryTableClient(),
    queryGsiPage: async (indexName, partitionKey, options) => {
      pagedReads.push({ indexName, partitionKey, startKey: options?.startKey });
      return { items: [{ PK: "a", SK: "META" }], nextStartKey: { PK: "a", SK: "META" } };
    },
  } as unknown as TableClient);

  const page = await retryingTable.queryGsiPage("GSI1", "TENANT#rgs#CASE_STATUS#NEW", {
    startKey: { PK: "z", SK: "META" },
  });

  expect(pagedReads).toEqual([
    { indexName: "GSI1", partitionKey: "TENANT#rgs#CASE_STATUS#NEW", startKey: { PK: "z", SK: "META" } },
  ]);
  expect(page.nextStartKey).toEqual({ PK: "a", SK: "META" });
});
```

- [ ] **Step 7: Delegate it in `tableRetry.ts`**

In the returned object literal, beside the other two read delegations:

```ts
    // Reads are not retried (see this file's header). Delegated all the same:
    // handler.ts wraps the production table in this object, so a method that
    // is missing here is a method that does not exist in production while
    // every unit test -- which builds an InMemoryTableClient directly --
    // passes.
    queryGsiPage: (indexName, partitionKey, queryOptions) =>
      table.queryGsiPage(indexName, partitionKey, queryOptions),
```

- [ ] **Step 8: Run everything and commit**

```bash
pnpm --filter @rgs/api test && pnpm -r typecheck
git add services/api/src/lib/db.ts services/api/src/lib/tableRetry.ts services/api/test/db.test.ts services/api/test/tableRetry.test.ts
git commit -m "feat(db): projected attributes and resumable GSI pages"
```

---

### Task 3: The Ledger read model

**Files:**
- Create: `services/api/src/domain/crm/ledger.ts`
- Test: `services/api/test/crm/ledger.test.ts` (create)

**Interfaces:**
- Consumes: `crm.LedgerRow`, `crm.LedgerRowSchema` (Task 1); `TableClient.queryGsiPage`, `QueryOptions.projection`, `TableItemKey` (Task 2); `caseStatusGsi1Pk`, `partnerCasesGsi2Pk`, `META_SORT_KEY`, `caseIdFromPartitionKey` (`keys.ts`); `collectReadableRecords`, `parseStoredRecord`, `stripStorageKeys`, `storedRecordId` (`storedRecords.ts`); `badRequest` (`errors.ts`).
- Produces:
  - `LEDGER_PROJECTED_ATTRIBUTES: readonly string[]`
  - `DEFAULT_LEDGER_PAGE_LIMIT = 500`, `MAX_LEDGER_PAGE_LIMIT = 1000`
  - `interface LedgerQuery { statuses: crm.CaseStatus[]; partnerId?: string; limit: number; cursor?: string }`
  - `interface LedgerPage { rows: crm.LedgerRow[]; unreadableCaseIds: string[]; nextCursor?: string }`
  - `listLedgerRows(context: AppContext, tenantId: string, query: LedgerQuery): Promise<LedgerPage>`

**Three decisions made here rather than left to the implementer, each with its reason:**

1. **No server-side `sort`.** Spec §2.1 asks for `sort` = `receivedDate | updatedAt`, asc/desc. GSI1 (all cases, partitioned by status) is ordered by `updatedAt` and GSI2 (one partner) by `receivedDate`; **no index orders all cases by `receivedDate`**. A `sort` parameter this route could not honour across nine partitions would be a promise kept only inside each one, which is worse than no promise. The route's contract is instead: *every matching row, exactly once, across the pages of a cursor*. Display order is the client's, over the rows it holds — which is every row, at about 1.4 MB. That is the size spec §2.1 itself computes.

2. **Status partitions are served sequentially, not merged.** Page 1 fills from the first requested status, spills into the second, and so on. A k-way merge would need all nine partitions open at once and buys ordering the client does not need (see 1).

3. **`partnerId` ignores `statuses` server-side.** In partner mode the read is one GSI2 partition and status is not its key, so filtering after the page is filled would under-fill pages — a client asking for 500 rows and getting 12 with a cursor, repeatedly. The partner's cases all come back and the client filters. The route says so in its response by echoing the query it actually ran.

- [ ] **Step 1: Write the failing test**

Create `services/api/test/crm/ledger.test.ts`:

```ts
import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { writeCase } from "../../src/domain/crm/caseStore";
import {
  DEFAULT_LEDGER_PAGE_LIMIT,
  LEDGER_PROJECTED_ATTRIBUTES,
  listLedgerRows,
} from "../../src/domain/crm/ledger";
import { casePartitionKey, META_SORT_KEY } from "../../src/domain/crm/keys";

const TENANT_ID = "rgs";

function buildCase(overrides: Partial<crm.CrmCase> & { caseId: string }): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
    tenantId: TENANT_ID,
    caseRef: `RGS-${overrides.caseId}`,
    caseType: "VISA",
    visaType: "TOURIST",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12000,
    applicants: [{ applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" }],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  });
}

async function seedCases(context: TestContext, cases: crm.CrmCase[]): Promise<void> {
  for (const crmCase of cases) await writeCase(context, crmCase);
}

describe("listLedgerRows", () => {
  it("projects only the Ledger's own columns", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", legacyRaw: { STATUS: "the whole original spreadsheet row" } }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ caseRef: "RGS-case_1", caseStatus: "NEW", totalInr: 12000 });
    // Both halves asserted: the columns are right AND the two heavy
    // attributes are gone. Checking only the first would pass against a
    // route that returned whole cases.
    expect(page.rows[0]).not.toHaveProperty("legacyRaw");
    expect(page.rows[0]).not.toHaveProperty("lineItems");
    expect(LEDGER_PROJECTED_ATTRIBUTES).not.toContain("legacyRaw");
    expect(LEDGER_PROJECTED_ATTRIBUTES).not.toContain("lineItems");
  });

  it("carries the applicant roll-up through", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({
        caseId: "case_1",
        applicants: [
          { applicantRef: "A1", travellerId: "t1", custody: "AT_EMBASSY", outcome: "PENDING" },
          { applicantRef: "A2", travellerId: "t2", custody: "WITH_RGS", outcome: "PENDING" },
        ],
      }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows[0]!.applicantSummary).toEqual({
      count: 2,
      custody: { AT_EMBASSY: 1, WITH_RGS: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("reads every requested status, spilling from one partition into the next", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED" }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW", "SUBMITTED"],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2", "case_3"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns every row exactly once across a cursor walk that crosses a partition boundary", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW", updatedAt: "2026-03-04T10:00:01.000Z" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW", updatedAt: "2026-03-04T10:00:02.000Z" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:03.000Z" }),
      buildCase({ caseId: "case_4", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:04.000Z" }),
      buildCase({ caseId: "case_5", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:05.000Z" }),
    ]);

    const collectedCaseIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await listLedgerRows(context, TENANT_ID, {
        statuses: ["NEW", "SUBMITTED"],
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      collectedCaseIds.push(...page.rows.map((row) => row.caseId));
      cursor = page.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(collectedCaseIds).toHaveLength(5);
    expect(new Set(collectedCaseIds).size).toBe(5);
  });

  it("refuses a cursor issued for a different filter rather than silently restarting", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW" }),
    ]);

    const firstPage = await listLedgerRows(context, TENANT_ID, { statuses: ["NEW"], limit: 1 });
    expect(firstPage.nextCursor).toBeDefined();

    await expect(
      listLedgerRows(context, TENANT_ID, {
        statuses: ["SUBMITTED"],
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a malformed cursor", async () => {
    const context = buildTestContext();

    await expect(
      listLedgerRows(context, TENANT_ID, { statuses: ["NEW"], limit: 10, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("names a row it could not read instead of dropping it", async () => {
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1" })]);
    // Corrupt the stored META item the way a hand-repair would: a
    // destinationCountry that is not a country code at all.
    const metaItem = await context.table.get(casePartitionKey(TENANT_ID, "case_1"), META_SORT_KEY);
    await context.table.put({ ...metaItem!, destinationCountry: "United Arab Emirates" });

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows).toHaveLength(0);
    expect(page.unreadableCaseIds).toEqual(["case_1"]);
  });

  it("reads one partner's whole partition when partnerId is given, whatever the statuses say", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", partnerId: "partner_a", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", partnerId: "partner_a", caseStatus: "CLOSED" }),
      buildCase({ caseId: "case_3", partnerId: "partner_b", caseStatus: "NEW" }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW"],
      partnerId: "partner_a",
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    // Both of partner_a's cases, including the CLOSED one the status filter
    // would have excluded: in partner mode the client filters, and the
    // alternative is pages that arrive almost empty.
    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2"]);
  });

  it("never reassembles a case", async () => {
    // The whole point of the read model. readCase issues a base-table get plus
    // a base-table query per case; a Ledger that did that is 14,312
    // round-trips. Asserted by counting what the table client was asked for.
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1" }), buildCase({ caseId: "case_2" })]);
    let baseTableReadCount = 0;
    const countingTable = {
      ...context.table,
      get: async (...callArguments: Parameters<typeof context.table.get>) => {
        baseTableReadCount += 1;
        return context.table.get(...callArguments);
      },
      query: async (...callArguments: Parameters<typeof context.table.query>) => {
        baseTableReadCount += 1;
        return context.table.query(...callArguments);
      },
      queryGsiPage: context.table.queryGsiPage.bind(context.table),
      queryGsi: context.table.queryGsi.bind(context.table),
      put: context.table.put.bind(context.table),
      delete: context.table.delete.bind(context.table),
    };

    await listLedgerRows({ ...context, table: countingTable }, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(baseTableReadCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/ledger.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/crm/ledger'`.

- [ ] **Step 3: Write `services/api/src/domain/crm/ledger.ts`**

```ts
import { crm } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../../lib/context";
import type { TableItem, TableItemKey } from "../../lib/db";
import { badRequest, corruptRecord } from "../../lib/errors";
import { collectReadableRecords, parseStoredRecord, stripStorageKeys } from "../../lib/storedRecords";
import {
  META_SORT_KEY,
  caseIdFromPartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";

/**
 * The Ledger read model (spec §2.1).
 *
 * `listCasesByStatus` cannot serve this screen: it defaults to 50 rows of one
 * status and calls `readCase` per case -- a strongly-consistent GetItem plus a
 * strongly-consistent Query each, 14,312 sequential round-trips for the real
 * 7,156-case ledger, to rebuild applicant arrays no column displays. Every
 * case-level column the Ledger shows is already on the META item that the GSI
 * query returns (`caseStore.writeCase` spreads `...caseBody` onto it), so this
 * module reads those items, projects the Ledger's columns off them, and
 * reassembles nothing.
 */

/**
 * Exactly the columns spec §4 lists, plus the two storage keys every reader
 * here needs: `SK` to tell a META item from an applicant item, `PK` to recover
 * a caseId from a row whose body has lost one.
 *
 * `legacyRaw` and `lineItems` are deliberately absent, and a test asserts it:
 * they are the difference between a 1.4 MB page and a 7-21 MB one.
 */
export const LEDGER_PROJECTED_ATTRIBUTES: readonly string[] = [
  "PK",
  "SK",
  "caseId",
  "caseRef",
  "partnerId",
  "destinationCountry",
  "caseType",
  "visaType",
  "caseStatus",
  "billingStatus",
  "receivedDate",
  "appointmentDate",
  "totalInr",
  "updatedAt",
  "applicantSummary",
];

export const DEFAULT_LEDGER_PAGE_LIMIT = 500;
export const MAX_LEDGER_PAGE_LIMIT = 1000;

/**
 * A hard stop on the page-filling loop. A partition that keeps answering with
 * a cursor and no rows would otherwise spin forever inside one HTTP request;
 * bounded, the caller gets a short page and a cursor, which is a state the
 * client already handles.
 */
const MAX_PARTITION_QUERIES_PER_PAGE = 64;

export interface LedgerQuery {
  /** Resolved by the route; never empty. Ignored when `partnerId` is set. */
  statuses: crm.CaseStatus[];
  partnerId?: string;
  limit: number;
  cursor?: string;
}

export interface LedgerPage {
  rows: crm.LedgerRow[];
  /**
   * META items the projection could not parse. Named rather than dropped, for
   * the reason every listing in this codebase names them: a case missing from
   * the Ledger is indistinguishable from a case that was never imported.
   */
  unreadableCaseIds: string[];
  nextCursor?: string;
}

/**
 * Where a page stopped. `scopeKey` pins the filter the cursor was issued for:
 * a client that changes its status filter mid-scroll and sends the old cursor
 * would otherwise resume at partition 3 of a different list of partitions and
 * quietly skip two statuses. Refused instead.
 */
const LedgerCursorSchema = z.object({
  v: z.literal(1),
  scopeKey: z.string().min(1),
  partitionIndex: z.number().int().nonnegative(),
  startKey: z.record(z.unknown()).optional(),
});
type LedgerCursor = z.infer<typeof LedgerCursorSchema>;

function scopeKeyFor(query: LedgerQuery): string {
  return query.partnerId !== undefined
    ? `partner:${query.partnerId}`
    : `status:${query.statuses.join(",")}`;
}

function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A cursor that will not decode is a 400, never a silent restart from row one:
 * an infinite-scroll client handed "start again" instead of an error appends
 * the first page forever.
 */
function decodeLedgerCursor(rawCursor: string, expectedScopeKey: string): LedgerCursor {
  let parsedCursor: LedgerCursor;
  try {
    parsedCursor = LedgerCursorSchema.parse(
      JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")),
    );
  } catch {
    throw badRequest("This ledger cursor could not be read");
  }
  if (parsedCursor.scopeKey !== expectedScopeKey) {
    throw badRequest(
      "This ledger cursor was issued for a different filter; start again from the first page",
    );
  }
  return parsedCursor;
}

export async function listLedgerRows(
  context: AppContext,
  tenantId: string,
  query: LedgerQuery,
): Promise<LedgerPage> {
  const scopeKey = scopeKeyFor(query);
  const resumeFrom =
    query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor, scopeKey);

  // Partner mode is one GSI2 partition ordered by receivedDate; status mode is
  // one GSI1 partition per requested status, each ordered by updatedAt. The
  // rest of this function does not care which it got.
  const indexName = query.partnerId !== undefined ? "GSI2" : "GSI1";
  const partitionKeys =
    query.partnerId !== undefined
      ? [partnerCasesGsi2Pk(tenantId, query.partnerId)]
      : query.statuses.map((caseStatus) => caseStatusGsi1Pk(tenantId, caseStatus));

  const collectedItems: TableItem[] = [];
  let partitionIndex = resumeFrom?.partitionIndex ?? 0;
  let startKey: TableItemKey | undefined = resumeFrom?.startKey;
  let nextCursor: string | undefined;
  let queryCount = 0;

  while (partitionIndex < partitionKeys.length) {
    const remainingRowCount = query.limit - collectedItems.length;
    if (remainingRowCount <= 0 || queryCount >= MAX_PARTITION_QUERIES_PER_PAGE) {
      nextCursor = encodeLedgerCursor({
        v: 1,
        scopeKey,
        partitionIndex,
        ...(startKey !== undefined ? { startKey } : {}),
      });
      break;
    }

    const page = await context.table.queryGsiPage(indexName, partitionKeys[partitionIndex]!, {
      limit: remainingRowCount,
      scanForward: false,
      projection: LEDGER_PROJECTED_ATTRIBUTES,
      ...(startKey !== undefined ? { startKey } : {}),
    });
    queryCount += 1;
    collectedItems.push(...page.items.filter((item) => item["SK"] === META_SORT_KEY));

    if (page.nextStartKey !== undefined) {
      startKey = page.nextStartKey;
    } else {
      partitionIndex += 1;
      startKey = undefined;
    }
  }

  const { records, unreadableRecordIds } = await collectReadableRecords(
    collectedItems,
    parseLedgerRow,
    { entityDescription: "CRM ledger row", scopeDescription: `tenant ${tenantId}` },
  );

  return {
    rows: records,
    unreadableCaseIds: unreadableRecordIds,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/**
 * A projected META item becomes one Ledger row, or names itself as unreadable.
 *
 * The caseId comes from the body when it is there and from the partition key
 * when it is not, exactly as `cases.ts` does -- a half-written or hand-repaired
 * item is the case that most needs to be findable.
 */
function parseLedgerRow(metaItem: TableItem): crm.LedgerRow {
  const caseIdFromBody = metaItem["caseId"];
  const caseId =
    typeof caseIdFromBody === "string" && caseIdFromBody.length > 0
      ? caseIdFromBody
      : caseIdFromPartitionKey(metaItem.PK);
  if (caseId === undefined) {
    throw corruptRecord("Ledger row", metaItem.PK, "the row names no caseId at all");
  }
  return parseStoredRecord(crm.LedgerRowSchema, "Ledger row", caseId, {
    ...stripStorageKeys(metaItem),
    caseId,
  });
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/ledger.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Prove two of the tests can fail**

Change `scanForward: false` to `true` — the cursor-walk test must still pass (it asserts a set, not an order). Then delete the `parsedCursor.scopeKey !== expectedScopeKey` check and confirm "refuses a cursor issued for a different filter" goes red. Restore both.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @rgs/api test && pnpm -r typecheck
git add services/api/src/domain/crm/ledger.ts services/api/test/crm/ledger.test.ts
git commit -m "feat(crm): a projected, resumable ledger read model"
```

---

### Task 4: The Ledger route

**Files:**
- Modify: `services/api/src/http/crmApi.ts` (register **before** the existing `GET /api/v1/admin/crm/cases/{caseId}` at line 156)
- Test: `services/api/test/crm/crmApi.test.ts` (extend)

**Interfaces:**
- Consumes: `listLedgerRows`, `LedgerQuery`, `DEFAULT_LEDGER_PAGE_LIMIT`, `MAX_LEDGER_PAGE_LIMIT` (Task 3).
- Produces: `GET /api/v1/admin/crm/cases/ledger` answering `{ rows, unreadableCaseIds, nextCursor?, appliedQuery }`.

`appliedQuery` is `{ statuses: CaseStatus[]; partnerId?: string; limit: number }` — what the route actually ran, not what was asked for. It exists because partner mode ignores the status filter (Task 3, decision 3), and a client that cannot see that would draw a filter chip that is not in force.

- [ ] **Step 1: Write the failing route tests**

Append to `services/api/test/crm/crmApi.test.ts` (it already has `buildRouter`, `call` and `callUnauthenticated`):

```ts
describe("GET /api/v1/admin/crm/cases/ledger", () => {
  it("is matched before the {caseId} route, not swallowed by it", async () => {
    // Router.match returns the FIRST route whose segment count and literals
    // match, and both paths are six segments. Registration order is the whole
    // defence, so it is asserted directly rather than inferred from a 200.
    const router = buildRouter(buildTestContext());
    const registeredPaths = router.registeredRoutes
      .filter((route) => route.method === "GET")
      .map((route) => route.path);

    expect(registeredPaths.indexOf("/api/v1/admin/crm/cases/ledger")).toBeGreaterThanOrEqual(0);
    expect(registeredPaths.indexOf("/api/v1/admin/crm/cases/ledger")).toBeLessThan(
      registeredPaths.indexOf("/api/v1/admin/crm/cases/{caseId}"),
    );
  });

  it("answers rows, not a case", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "NEW");
    const router = buildRouter(context);

    const { statusCode, payload } = await call(router, "GET", "/api/v1/admin/crm/cases/ledger");

    expect(statusCode).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].caseRef).toBe("RGS-case_1");
    expect(payload.appliedQuery.statuses).toEqual([...crm.CASE_STATUSES]);
  });

  it("parses a comma-joined repeated status parameter", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "NEW");
    await seedLedgerCase(context, "case_2", "CLOSED");
    const router = buildRouter(context);

    const { payload } = await call(router, "GET", "/api/v1/admin/crm/cases/ledger", undefined, {
      status: "NEW,SUBMITTED",
    });

    expect(payload.rows.map((row: { caseId: string }) => row.caseId)).toEqual(["case_1"]);
    expect(payload.appliedQuery.statuses).toEqual(["NEW", "SUBMITTED"]);
  });

  it("400s an unknown status rather than quietly returning everything", async () => {
    const router = buildRouter(buildTestContext());

    const { statusCode, payload } = await call(
      router,
      "GET",
      "/api/v1/admin/crm/cases/ledger",
      undefined,
      { status: "NEW,SUBMITTTED" },
    );

    expect(statusCode).toBe(400);
    expect(payload.message).toContain("SUBMITTTED");
  });

  it("400s a limit outside the allowed range", async () => {
    const router = buildRouter(buildTestContext());

    expect(
      (await call(router, "GET", "/api/v1/admin/crm/cases/ledger", undefined, { limit: "0" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(router, "GET", "/api/v1/admin/crm/cases/ledger", undefined, { limit: "5000" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(router, "GET", "/api/v1/admin/crm/cases/ledger", undefined, { limit: "many" }))
        .statusCode,
    ).toBe(400);
  });

  it("says in appliedQuery that partner mode is not filtering by status", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "CLOSED", "partner_a");
    const router = buildRouter(context);

    const { payload } = await call(router, "GET", "/api/v1/admin/crm/cases/ledger", undefined, {
      partnerId: "partner_a",
      status: "NEW",
    });

    expect(payload.rows).toHaveLength(1);
    expect(payload.appliedQuery.partnerId).toBe("partner_a");
    expect(payload.appliedQuery.statuses).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    const { statusCode } = await callUnauthenticated(
      buildRouter(buildTestContext()),
      "GET",
      "/api/v1/admin/crm/cases/ledger",
    );

    expect(statusCode).toBe(403);
  });
});
```

Add the seed helper beside the file's other helpers:

```ts
async function seedLedgerCase(
  context: ReturnType<typeof buildTestContext>,
  caseId: string,
  caseStatus: crm.CaseStatus,
  partnerId = "partner_1",
): Promise<void> {
  await writeCase(
    context,
    crm.CrmCaseSchema.parse({
      tenantId: "rgs",
      caseId,
      caseRef: `RGS-${caseId}`,
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId,
      destinationCountry: "AE",
      caseStatus,
      billingStatus: "UNBILLED",
      receivedDate: "2026-03-04",
      totalInr: 12000,
      applicants: [
        { applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" },
      ],
      createdAt: "2026-03-04T10:00:00.000Z",
      updatedAt: "2026-03-04T10:00:00.000Z",
    }),
  );
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/crmApi.test.ts -t "ledger"`
Expected: FAIL — 404 `No route for GET /api/v1/admin/crm/cases/ledger`, and the ordering test fails on `indexOf(...) === -1`.

- [ ] **Step 3: Register the route**

In `crmApi.ts`, add the parsers near the other body schemas:

```ts
/**
 * API Gateway v2 collapses a repeated query parameter into one comma-joined
 * string, and RequestContext.queryParams is Record<string, string> -- so
 * "repeatable status" is `?status=NEW,SUBMITTED`, split here. An unrecognised
 * value is a 400 naming it, never a quiet fall back to "all": a typo that
 * silently widens the filter shows an operator rows they filtered out.
 */
function parseLedgerStatuses(rawStatuses: string | undefined): crm.CaseStatus[] {
  if (rawStatuses === undefined || rawStatuses.trim() === "") return [...crm.CASE_STATUSES];
  const requestedStatuses = rawStatuses.split(",").map((statusName) => statusName.trim());
  const parsedStatuses: crm.CaseStatus[] = [];
  for (const requestedStatus of requestedStatuses) {
    const matchedStatus = crm.CASE_STATUSES.find((caseStatus) => caseStatus === requestedStatus);
    if (matchedStatus === undefined) throw badRequest(`Unknown case status ${requestedStatus}`);
    if (!parsedStatuses.includes(matchedStatus)) parsedStatuses.push(matchedStatus);
  }
  return parsedStatuses;
}

const LedgerLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LEDGER_PAGE_LIMIT)
  .default(DEFAULT_LEDGER_PAGE_LIMIT);
```

and the route itself, **immediately before** the existing `.add("GET", "/api/v1/admin/crm/cases/{caseId}", ...)`:

```ts
    // BEFORE "/api/v1/admin/crm/cases/{caseId}", and it must stay that way:
    // Router.match returns the first route whose segment count and literals
    // match, both paths are six segments, and registered after it this route
    // would be answered by getCase with caseId="ledger" -- a 404 that looks
    // like a missing case. A test in crmApi.test.ts asserts the order.
    .add("GET", "/api/v1/admin/crm/cases/ledger", async (requestContext) => {
      requireAdmin(requestContext);
      const partnerId = requestContext.queryParams["partnerId"];
      const statuses = parseLedgerStatuses(requestContext.queryParams["status"]);
      const limit = parseQueryParam(
        LedgerLimitSchema,
        "limit",
        requestContext.queryParams["limit"],
      );
      const cursor = requestContext.queryParams["cursor"];

      const ledgerPage = await listLedgerRows(context, tenantId, {
        statuses,
        ...(partnerId !== undefined ? { partnerId } : {}),
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      return {
        ...ledgerPage,
        // What ran, not what was asked for. In partner mode the status filter
        // is not applied server-side (domain/crm/ledger.ts, decision 3), and a
        // client that could not see that would draw a filter chip for a filter
        // nothing is enforcing.
        appliedQuery: {
          statuses: partnerId !== undefined ? [] : statuses,
          ...(partnerId !== undefined ? { partnerId } : {}),
          limit,
        },
      };
    })
```

Add the imports: `listLedgerRows`, `DEFAULT_LEDGER_PAGE_LIMIT`, `MAX_LEDGER_PAGE_LIMIT` from `../domain/crm/ledger`, and `parseQueryParam` from `./router`.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/crmApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the ordering test fails**

Move the `.add("GET", ".../cases/ledger", ...)` call to after `{caseId}`. The ordering test AND "answers rows, not a case" must both go red. Move it back.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @rgs/api test && pnpm -r typecheck
git add services/api/src/http/crmApi.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(crm): GET /crm/cases/ledger"
```

---

### Task 5: The open-review summary, so the Ledger can mark a dirty row

**Files:**
- Modify: `packages/shared/src/crm/reviewItem.ts`
- Modify: `services/api/src/domain/crm/reviewQueue.ts`
- Modify: `services/api/src/http/crmApi.ts` (register **before** `GET .../review/{reviewItemId}`)
- Test: `services/api/test/crm/reviewQueue.test.ts` (extend)
- Test: `services/api/test/crm/crmApi.test.ts` (extend)

**Interfaces:**
- Consumes: `QueryOptions.projection` (Task 2); `reviewQueueGsi1Pk`, `REVIEW_ITEM_SORT_KEY` (`keys.ts`).
- Produces:
  - `crm.MERGE_REVIEW_REASONS: readonly ReviewReason[]` = `["PROPOSED_GROUP", "DUPLICATE_REF"]`
  - `crm.isMergeReviewReason(reason: ReviewReason): boolean`
  - `interface OpenReviewSummaryEntry { caseRef: string; fieldItemIds: string[]; mergeItemIds: string[] }`
  - `summariseOpenReviewItems(context, tenantId): Promise<{ entries: OpenReviewSummaryEntry[]; unreadableReviewItemIds: string[] }>`
  - `GET /api/v1/admin/crm/review/summary`

**Why a summary route and not a per-case query.** `crm.ReviewItem` is keyed on `caseRef`, and GSI1 partitions review items by *status*, not by ref — so "does this case have open items" has no index to answer it. Three options were weighed: add a GSI2 on review items (needs all 3,958 existing rows rewritten before it answers anything), scan per row (7,156 queries to draw one screen), or read the OPEN partition once with a narrow projection. The third is what this task builds: about 3,958 rows × ~120 bytes ≈ 480 KB, read once per Ledger load, and it carries the item ids so opening a marker needs only `GET .../review/{reviewItemId}` for the handful actually opened.

**Why merge candidates are a separate list.** Spec §7: "a case with a merge candidate is marked distinctly from one with a field-level problem." `PROPOSED_GROUP` and `DUPLICATE_REF` are the two reasons that say *this row may be the same work as another row*; every other reason is about one cell. They need different marks because they need different work.

- [ ] **Step 1: Write the failing domain test**

Append to `services/api/test/crm/reviewQueue.test.ts`:

```ts
describe("summariseOpenReviewItems", () => {
  it("groups open items by caseRef, keeping merge candidates apart from field problems", async () => {
    const context = buildTestContext();
    const unmapped = await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "2026",
      sourceRow: 12,
      caseRef: "RGS-1001",
      fieldName: "Status",
      rawValue: "pend.",
    });
    const merge = await recordReviewItem(context, "rgs", {
      reason: "PROPOSED_GROUP",
      sourceSheet: "2026",
      sourceRow: 13,
      caseRef: "RGS-1001",
      fieldName: "REF NO",
      rawValue: "RGS-1001",
    });
    await recordReviewItem(context, "rgs", {
      reason: "UNPARSEABLE_DATE",
      sourceSheet: "2026",
      sourceRow: 40,
      caseRef: "RGS-1002",
      fieldName: "Received",
      rawValue: "31/02/26",
    });

    const summary = await summariseOpenReviewItems(context, "rgs");

    const firstEntry = summary.entries.find((entry) => entry.caseRef === "RGS-1001");
    expect(firstEntry?.fieldItemIds).toEqual([unmapped.reviewItemId]);
    expect(firstEntry?.mergeItemIds).toEqual([merge.reviewItemId]);
    expect(summary.entries.map((entry) => entry.caseRef).sort()).toEqual(["RGS-1001", "RGS-1002"]);
  });

  it("forgets a resolved item, because a cleaned row must lose its marker", async () => {
    const context = buildTestContext();
    const item = await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "2026",
      sourceRow: 12,
      caseRef: "RGS-1001",
      fieldName: "Status",
      rawValue: "pend.",
    });
    await resolveReviewItem(context, "rgs", item.reviewItemId, { reviewStatus: "DISMISSED" }, "ops@rgs.test");

    const summary = await summariseOpenReviewItems(context, "rgs");

    expect(summary.entries).toEqual([]);
  });

  it("names an item it could not read rather than dropping it from the count", async () => {
    const context = buildTestContext();
    await context.table.put({
      PK: reviewItemPartitionKey("rgs", "rev_broken"),
      SK: REVIEW_ITEM_SORT_KEY,
      GSI1PK: reviewQueueGsi1Pk("rgs", "OPEN"),
      GSI1SK: "2026-03-04T10:00:00.000Z",
      reviewItemId: "rev_broken",
      // No caseRef at all: the one attribute this summary is a join on.
      reason: "UNMAPPED_STATUS",
    });

    const summary = await summariseOpenReviewItems(context, "rgs");

    expect(summary.entries).toEqual([]);
    expect(summary.unreadableReviewItemIds).toEqual(["rev_broken"]);
  });

  it("reads the partition once, projected, rather than reassembling every item", async () => {
    const context = buildTestContext();
    const projectionsAsked: (readonly string[] | undefined)[] = [];
    const spyingTable = {
      ...context.table,
      queryGsi: async (
        indexName: "GSI1" | "GSI2" | "GSI3",
        partitionKey: string,
        options?: { projection?: readonly string[] },
      ) => {
        projectionsAsked.push(options?.projection);
        return context.table.queryGsi(indexName, partitionKey, options);
      },
      queryGsiPage: context.table.queryGsiPage.bind(context.table),
      get: context.table.get.bind(context.table),
      query: context.table.query.bind(context.table),
      put: context.table.put.bind(context.table),
      delete: context.table.delete.bind(context.table),
    };

    await summariseOpenReviewItems({ ...context, table: spyingTable }, "rgs");

    expect(projectionsAsked).toHaveLength(1);
    expect(projectionsAsked[0]).toContain("caseRef");
    expect(projectionsAsked[0]).not.toContain("detail");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/reviewQueue.test.ts -t "summariseOpenReviewItems"`
Expected: FAIL — `summariseOpenReviewItems is not exported`.

- [ ] **Step 3: Add the shared reason split**

In `packages/shared/src/crm/reviewItem.ts`, after `REVIEW_REASONS`:

```ts
/**
 * The two reasons that say "this row may be the same work as another row"
 * rather than "this cell could not be read". Spec §7 marks a case carrying one
 * of these differently from a case with a field-level problem, because
 * resolving them is different work: one is a judgement about two cases, the
 * other is a correction to one value.
 */
export const MERGE_REVIEW_REASONS: readonly ReviewReason[] = ["PROPOSED_GROUP", "DUPLICATE_REF"];

export function isMergeReviewReason(reason: ReviewReason): boolean {
  return MERGE_REVIEW_REASONS.includes(reason);
}
```

- [ ] **Step 4: Add the domain function**

In `services/api/src/domain/crm/reviewQueue.ts`:

```ts
/**
 * Which cases have unresolved import problems, cheaply enough to draw on every
 * Ledger load.
 *
 * `listReviewItems` cannot answer this: it caps at 200 of 3,958 OPEN items and
 * has no cursor, so a marker built on it would appear on 5% of the dirty rows
 * and nowhere else -- which reads as "the rest are clean". This reads the whole
 * OPEN partition with a four-attribute projection instead, and carries the item
 * ids so opening a marker is a `get` per item actually opened rather than a
 * second sweep.
 */
export const OPEN_REVIEW_SUMMARY_ATTRIBUTES: readonly string[] = [
  "PK",
  "SK",
  "reviewItemId",
  "caseRef",
  "reason",
];

export interface OpenReviewSummaryEntry {
  caseRef: string;
  /** Items about one cell: a value that could not be read or mapped. */
  fieldItemIds: string[];
  /** Items about two rows: PROPOSED_GROUP, DUPLICATE_REF. */
  mergeItemIds: string[];
}

export interface OpenReviewSummary {
  entries: OpenReviewSummaryEntry[];
  unreadableReviewItemIds: string[];
}

export async function summariseOpenReviewItems(
  context: AppContext,
  tenantId: string,
): Promise<OpenReviewSummary> {
  const storedItems = await context.table.queryGsi("GSI1", reviewQueueGsi1Pk(tenantId, "OPEN"), {
    scanForward: true,
    projection: OPEN_REVIEW_SUMMARY_ATTRIBUTES,
  });

  const entriesByCaseRef = new Map<string, OpenReviewSummaryEntry>();
  const unreadableReviewItemIds: string[] = [];

  for (const storedItem of storedItems) {
    const reviewItemId = storedItem["reviewItemId"];
    const caseRef = storedItem["caseRef"];
    const reason = storedItem["reason"];
    const isUsable =
      typeof reviewItemId === "string" &&
      reviewItemId.length > 0 &&
      typeof caseRef === "string" &&
      caseRef.length > 0 &&
      typeof reason === "string" &&
      (crm.REVIEW_REASONS as readonly string[]).includes(reason);
    if (!isUsable) {
      // Named, not dropped: an item missing from this summary is a dirty row
      // that renders as clean, which is the one thing the marker exists to
      // prevent. The storage key is the fallback id because it is all an
      // operator has to find the row with.
      unreadableReviewItemIds.push(
        typeof reviewItemId === "string" && reviewItemId.length > 0 ? reviewItemId : storedItem.PK,
      );
      console.warn(`CRM review item in tenant ${tenantId} could not be summarised: ${storedItem.PK}`);
      continue;
    }

    const entry = entriesByCaseRef.get(caseRef) ?? { caseRef, fieldItemIds: [], mergeItemIds: [] };
    if (crm.isMergeReviewReason(reason as crm.ReviewReason)) {
      entry.mergeItemIds.push(reviewItemId);
    } else {
      entry.fieldItemIds.push(reviewItemId);
    }
    entriesByCaseRef.set(caseRef, entry);
  }

  return { entries: [...entriesByCaseRef.values()], unreadableReviewItemIds };
}
```

- [ ] **Step 5: Add the route, before its parameterised sibling**

In `crmApi.ts`, **immediately before** `.add("GET", "/api/v1/admin/crm/review/{reviewItemId}", ...)`:

```ts
    // BEFORE "/api/v1/admin/crm/review/{reviewItemId}" -- same six-segment
    // collision as the ledger route above, same consequence: registered after
    // it, this answers `getReviewItemOrThrow("summary")` and 404s.
    .add("GET", "/api/v1/admin/crm/review/summary", async (requestContext) => {
      requireAdmin(requestContext);
      return summariseOpenReviewItems(context, tenantId);
    })
```

- [ ] **Step 6: Write the route test**

Append to `services/api/test/crm/crmApi.test.ts`:

```ts
describe("GET /api/v1/admin/crm/review/summary", () => {
  it("is matched before the {reviewItemId} route", async () => {
    const router = buildRouter(buildTestContext());
    const registeredPaths = router.registeredRoutes
      .filter((route) => route.method === "GET")
      .map((route) => route.path);

    expect(registeredPaths.indexOf("/api/v1/admin/crm/review/summary")).toBeLessThan(
      registeredPaths.indexOf("/api/v1/admin/crm/review/{reviewItemId}"),
    );
  });

  it("answers the caseRefs with open items", async () => {
    const context = buildTestContext();
    await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "2026",
      sourceRow: 12,
      caseRef: "RGS-1001",
      fieldName: "Status",
      rawValue: "pend.",
    });

    const { statusCode, payload } = await call(
      buildRouter(context),
      "GET",
      "/api/v1/admin/crm/review/summary",
    );

    expect(statusCode).toBe(200);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].caseRef).toBe("RGS-1001");
  });

  it("refuses an unauthenticated caller", async () => {
    const { statusCode } = await callUnauthenticated(
      buildRouter(buildTestContext()),
      "GET",
      "/api/v1/admin/crm/review/summary",
    );
    expect(statusCode).toBe(403);
  });
});
```

- [ ] **Step 7: Run, prove it can fail, commit**

Run: `pnpm --filter @rgs/api test && pnpm --filter @rgs/shared test && pnpm -r typecheck`
Then move the summary route after `{reviewItemId}` and confirm both new route tests go red; move it back.

```bash
git add packages/shared/src/crm/reviewItem.ts services/api/src/domain/crm/reviewQueue.ts services/api/src/http/crmApi.ts services/api/test/crm/reviewQueue.test.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(crm): summarise open review items by caseRef"
```

---

### Task 6: Backfill the roll-up onto the 7,156 imported cases

**Files:**
- Create: `services/migration/src/backfillApplicantSummary.ts`
- Create: `services/migration/src/backfillCli.ts`
- Modify: `services/migration/package.json` (add `"backfill:summary": "tsx src/backfillCli.ts"`)
- Test: `services/migration/test/backfillApplicantSummary.test.ts` (create)

**Interfaces:**
- Consumes: `readCase`, `writeCase` (`caseStore.ts`); `listCaseRefsByStatus` (`cases.ts`) for the case-id sweep; `crm.CASE_STATUSES`.
- Produces: `backfillApplicantSummary(context, tenantId, options?): Promise<BackfillReport>` where
  `BackfillReport = { scanned: number; written: number; alreadyCurrent: number; unreadableCaseIds: string[] }`.

**Why this task exists, when the spec does not mention it.** Task 1 makes `writeCase` compute the roll-up, and every future write gets one. The 7,156 cases already in the table were written before it, so their META items carry no `applicantSummary` — and the Ledger would show "not summarised" on every row of the real ledger, which is the whole product. `LedgerRowSchema` makes the field optional so the screen degrades honestly rather than reporting 7,156 unreadable rows; this task is what removes the degradation.

**Why `readCase` → `writeCase` rather than a targeted attribute update.** `writeCase` is the only thing that knows how to compute the summary, and round-tripping a case through it changes nothing else: `readCase` parses through `CrmCaseSchema` and `writeCase` writes exactly those fields back, with the same `updatedAt`. No event is recorded because nothing about the case changed — a backfill that filled the timeline with 7,156 phantom edits would corrupt the audit surface the Case screen is built on.

**Four rules, each of which has bitten a real backfill:**

1. **Re-runnable.** A case whose META item already carries a summary equal to the computed one is counted in `alreadyCurrent` and not rewritten.
2. **One bad case does not stop the run.** `readCase` throws `CorruptRecordError` on a partition holding META with no applicant items — which `writeCase`, being non-transactional, produces on any timeout. Those ids go in `unreadableCaseIds` and the run continues.
3. **It never invents applicants.** If `readCase` cannot reassemble a case, the backfill does not write a `count: 0` summary over it. A fabricated roll-up is worse than a missing one.
4. **The case-id sweep is `listCaseRefsByStatus`, not `listCasesByStatus`.** The latter reassembles every case (14,312 round-trips) just to hand back ids this function is about to read anyway, and it silently drops the corrupt cases rule 2 exists to name.

- [ ] **Step 1: Write the failing test**

Create `services/migration/test/backfillApplicantSummary.test.ts`:

```ts
import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillApplicantSummary } from "../src/backfillApplicantSummary";

function buildContext(): AppContext & { table: InMemoryTableClient } {
  const table = new InMemoryTableClient();
  return {
    table,
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-11T10:00:00.000Z"),
  };
}

function buildCase(caseId: string): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
    tenantId: "rgs",
    caseId,
    caseRef: `RGS-${caseId}`,
    caseType: "VISA",
    visaType: "TOURIST",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "NEW",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    applicants: [
      { applicantRef: "A1", travellerId: "t1", custody: "WITH_RGS", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "t2", custody: "NOT_HELD", outcome: "PENDING" },
    ],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
  });
}

describe("backfillApplicantSummary", () => {
  it("gives a pre-existing case the roll-up it was written without", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));
    // Simulate the real stored state: written before Task 1 existed.
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { applicantSummary: _dropped, ...metaWithoutSummary } = metaItem!;
    await context.table.put(metaWithoutSummary as typeof metaItem & { PK: string; SK: string });

    const report = await backfillApplicantSummary(context, "rgs");

    const backfilled = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilled?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, NOT_HELD: 1 },
      outcome: { PENDING: 2 },
    });
    expect(report).toMatchObject({ scanned: 1, written: 1, alreadyCurrent: 0 });
  });

  it("leaves updatedAt alone, so a backfilled case does not jump the ledger's sort", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));

    await backfillApplicantSummary(context, "rgs");

    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(metaItem?.["updatedAt"]).toBe("2026-03-04T10:00:00.000Z");
  });

  it("is re-runnable: a second run writes nothing", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));

    await backfillApplicantSummary(context, "rgs");
    const secondReport = await backfillApplicantSummary(context, "rgs");

    expect(secondReport).toMatchObject({ scanned: 1, written: 0, alreadyCurrent: 1 });
  });

  it("names a case it cannot reassemble and keeps going", async () => {
    const context = buildContext();
    await writeCase(context, buildCase("case_1"));
    await writeCase(context, buildCase("case_2"));
    // A partition holding META with no applicant items -- exactly what a
    // timeout between writeCase's two writes leaves behind.
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#00");
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#01");

    const report = await backfillApplicantSummary(context, "rgs");

    expect(report.unreadableCaseIds).toEqual(["case_1"]);
    expect(report.written).toBe(0);
    expect(report.alreadyCurrent).toBe(1);
    // The half-written case keeps whatever it had. A fabricated count: 0
    // summary would say, on the Ledger, that this case has no applicants.
    const brokenMeta = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(brokenMeta?.["applicantSummary"]).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, NOT_HELD: 1 },
      outcome: { PENDING: 2 },
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @rgs/migration exec vitest run test/backfillApplicantSummary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the backfill**

```ts
// services/migration/src/backfillApplicantSummary.ts
import { crm } from "@rgs/shared";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";

export interface BackfillReport {
  scanned: number;
  written: number;
  alreadyCurrent: number;
  unreadableCaseIds: string[];
}

export interface BackfillOptions {
  /** Called once per case so a 7,156-row run is not silent. */
  onProgress?: (scanned: number) => void;
}

/**
 * Gives every already-stored case the `applicantSummary` that `writeCase` now
 * computes (Plan 5 Task 1). Re-runnable, and it never writes a summary it had
 * to invent.
 *
 * Round-tripping through readCase/writeCase rather than patching the attribute
 * directly: writeCase is the only thing that knows how to compute the summary,
 * and a second computation here would be a second place to get it wrong. The
 * round trip changes nothing else -- same fields, same `updatedAt`, and no CRM
 * event, because nothing about the case changed and 7,156 phantom edits in the
 * timeline would corrupt the audit surface the Case screen is built on.
 */
export async function backfillApplicantSummary(
  context: AppContext,
  tenantId: string,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const report: BackfillReport = { scanned: 0, written: 0, alreadyCurrent: 0, unreadableCaseIds: [] };

  for (const caseStatus of crm.CASE_STATUSES) {
    // The ref listing, not listCasesByStatus: that one reassembles every case
    // to hand back ids this loop is about to read anyway, and it drops the
    // corrupt cases this run most needs to name. `limit: undefined` drains the
    // partition -- a capped sweep would leave part of the ledger unbackfilled
    // with nothing saying so.
    const { storedCaseRefs, unreadableCaseIds } = await listCaseRefsByStatus(
      context,
      tenantId,
      caseStatus,
      Number.MAX_SAFE_INTEGER,
    );
    report.unreadableCaseIds.push(...unreadableCaseIds);

    for (const { caseId } of storedCaseRefs) {
      report.scanned += 1;
      options.onProgress?.(report.scanned);

      let loadedCase;
      try {
        loadedCase = await readCase(context, tenantId, caseId);
      } catch (error) {
        // A partition holding META with no applicant items. Named and left
        // exactly as it is: writing a count: 0 summary over it would tell the
        // Ledger this case has no applicants, which is a stronger and falser
        // claim than "not summarised".
        if (!(error instanceof CorruptRecordError)) throw error;
        report.unreadableCaseIds.push(caseId);
        continue;
      }
      if (loadedCase === undefined) {
        report.unreadableCaseIds.push(caseId);
        continue;
      }

      const storedMetaItem = await context.table.get(
        casePartitionKey(tenantId, caseId),
        META_SORT_KEY,
        { consistentRead: true },
      );
      const expectedSummary = crm.summariseApplicants(loadedCase.applicants);
      if (
        JSON.stringify(storedMetaItem?.["applicantSummary"] ?? null) ===
        JSON.stringify(expectedSummary)
      ) {
        report.alreadyCurrent += 1;
        continue;
      }

      await writeCase(context, loadedCase);
      report.written += 1;
    }
  }

  return report;
}
```

`services/migration/src/backfillCli.ts` follows `cli.ts` exactly — a bin shim and nothing else:

```ts
#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import { backfillApplicantSummary } from "./backfillApplicantSummary";

const context = await buildProductionContext();
const report = await backfillApplicantSummary(context, DEFAULT_TENANT_ID, {
  onProgress: (scanned) => {
    if (scanned % 250 === 0) console.log(`...${scanned} cases scanned`);
  },
});

console.table({
  scanned: report.scanned,
  written: report.written,
  alreadyCurrent: report.alreadyCurrent,
  unreadable: report.unreadableCaseIds.length,
});
if (report.unreadableCaseIds.length > 0) {
  console.error(`Cases that could not be reassembled: ${report.unreadableCaseIds.join(", ")}`);
}
// Unreadable cases are a finding, not a failure: the run did everything it
// could and said what it could not do.
process.exitCode = 0;
```

Check `buildProductionContext`'s real signature in `services/api/src/http/handler.ts` before writing this file and match it; if it is not exported, export it the way `cli.ts` already consumes it.

- [ ] **Step 4: Run, prove it can fail, commit**

Run: `pnpm --filter @rgs/migration test && pnpm -r typecheck`
Then delete the `alreadyCurrent` short-circuit and confirm "is re-runnable" goes red. Restore it.

```bash
git add services/migration/src/backfillApplicantSummary.ts services/migration/src/backfillCli.ts services/migration/package.json services/migration/test/backfillApplicantSummary.test.ts
git commit -m "feat(migration): backfill applicantSummary onto imported cases"
```

**Operator note to carry into the handoff:** this must be run against the real table (`pnpm --filter @rgs/migration backfill:summary`) before the Ledger is shown to RGS, and the plan's Manual Verification section says so again.

---

### Task 7: The case-details route a human edit needs

**Files:**
- Modify: `services/api/src/http/crmApi.ts`
- Test: `services/api/test/crm/crmApi.test.ts` (extend)

**Interfaces:**
- Consumes: `updateCaseDetails`, `UpdateCaseDetailsInput` (`services/api/src/domain/crm/cases.ts:140`).
- Produces: `PUT /api/v1/admin/crm/cases/{caseId}` accepting `{ visaType?, entryType?, processing?, submissionDate?, appointmentDate?, expectedCollectionDate? }` and answering the updated `crm.CrmCase`.

**Why this is a task and not an oversight in the spec.** Spec §4 says Ledger cells are edited inline and commit straight to the REST routes. Of the ten Ledger columns, exactly two have a route today — `caseStatus` and `billingStatus`. `appointmentDate` and `visaType` do not: `updateCaseDetails` exists in the domain and is reachable **only** through the agent's `update_case` write tool (`agent/tools/writeTools.ts:216`). A human editing the appointment date would have to ask the agent to propose it and then approve their own click — which spec §4 explicitly rules out as "ceremony without safety". Measured at `main` = `88b5c46`: `crmApi.ts` registers thirteen routes and none of them is a `PUT /crm/cases/{caseId}`.

**What it must not become.** `UpdateCaseDetailsInput` is an allow-list of six plain fields precisely so no caller can walk around the four state machines. The body schema here is the same six names written out, never a passthrough of `requestContext.body` — the domain function picks its fields by name, and this route must not be the place someone later adds a seventh.

- [ ] **Step 1: Write the failing test**

```ts
describe("PUT /api/v1/admin/crm/cases/{caseId}", () => {
  it("updates an appointment date", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "NEW");

    const { statusCode, payload } = await call(
      buildRouter(context),
      "PUT",
      "/api/v1/admin/crm/cases/case_1",
      { appointmentDate: "2026-04-01" },
    );

    expect(statusCode).toBe(200);
    expect(payload.appointmentDate).toBe("2026-04-01");
  });

  it("refuses to move caseStatus through this route", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "NEW");

    const { payload } = await call(buildRouter(context), "PUT", "/api/v1/admin/crm/cases/case_1", {
      appointmentDate: "2026-04-01",
      caseStatus: "CLOSED",
      billingStatus: "PAID",
    });

    // Both halves: the legal field moved AND the smuggled ones did not. Zod's
    // strip mode drops them before the handler sees them, and the domain
    // function picks its six fields by name -- this asserts the outcome, not
    // the mechanism, so it survives either one being changed.
    expect(payload.appointmentDate).toBe("2026-04-01");
    expect(payload.caseStatus).toBe("NEW");
    expect(payload.billingStatus).toBe("UNBILLED");
  });

  it("400s a date that is not a date", async () => {
    const context = buildTestContext();
    await seedLedgerCase(context, "case_1", "NEW");

    const { statusCode } = await call(buildRouter(context), "PUT", "/api/v1/admin/crm/cases/case_1", {
      appointmentDate: "01/04/2026",
    });

    expect(statusCode).toBe(400);
  });

  it("404s an unknown case", async () => {
    const { statusCode } = await call(
      buildRouter(buildTestContext()),
      "PUT",
      "/api/v1/admin/crm/cases/case_nope",
      { appointmentDate: "2026-04-01" },
    );

    expect(statusCode).toBe(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const { statusCode } = await callUnauthenticated(
      buildRouter(buildTestContext()),
      "PUT",
      "/api/v1/admin/crm/cases/case_1",
      { appointmentDate: "2026-04-01" },
    );

    expect(statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `pnpm --filter @rgs/api exec vitest run test/crm/crmApi.test.ts -t "PUT /api/v1/admin/crm/cases"`. Expected: 404 `No route for PUT`.

- [ ] **Step 3: Add the route**

Beside the other case bodies:

```ts
const isoDateBody = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * The six fields `updateCaseDetails` is allowed to touch, written out by name.
 * NOT a passthrough of the request body: `caseStatus`, per-applicant `custody`,
 * per-applicant `outcome` and `billingStatus` each have a state machine and
 * their own route, and a general "update any field" body is one forgotten key
 * away from walking around all four. Typed as the domain's own interface below
 * so a drift between the two fails to compile.
 */
const UpdateCaseDetailsBody = z.object({
  visaType: z.enum(crm.VISA_TYPES).optional(),
  entryType: z.enum(crm.ENTRY_TYPES).optional(),
  processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
  submissionDate: isoDateBody.optional(),
  appointmentDate: isoDateBody.optional(),
  expectedCollectionDate: isoDateBody.optional(),
});
```

Registered after `GET /crm/cases/{caseId}` (different method, so order is irrelevant here — but keep it beside its siblings for readability):

```ts
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireAdmin(requestContext);
      const input: UpdateCaseDetailsInput = parseBody(UpdateCaseDetailsBody, requestContext.body);
      return updateCaseDetails(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        input,
        requestContext.callerEmail,
      );
    })
```

Import `updateCaseDetails` and `type UpdateCaseDetailsInput` from `../domain/crm/cases`.

- [ ] **Step 4: Run, prove it can fail, commit**

Run the suite. Then widen `UpdateCaseDetailsBody` with `caseStatus: z.enum(crm.CASE_STATUSES).optional()` and confirm "refuses to move caseStatus through this route" still passes — it must, because the domain function picks by name; that is the belt-and-suspenders this design has. Then make `updateCaseDetails` spread `input` wholesale and confirm the test goes red. Restore both.

```bash
pnpm --filter @rgs/api test && pnpm -r typecheck
git add services/api/src/http/crmApi.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(crm): PUT /crm/cases/{caseId} for the six plain detail fields"
```

---

## The frontend half

Everything from here lives in `apps/admin/src/crm/` and touches no existing visa-platform page.

### Task 8: Test harness, design tokens, labels and chips

**Files:**
- Modify: `apps/admin/package.json`
- Create: `apps/admin/vitest.config.ts`
- Create: `apps/admin/test/setup.ts`
- Create: `apps/admin/src/crm/theme.css`
- Create: `apps/admin/src/crm/labels.ts`
- Create: `apps/admin/src/crm/components/Chip.tsx`
- Test: `apps/admin/test/crm/labels.test.ts`, `apps/admin/test/crm/Chip.test.tsx`

**Interfaces:**
- Consumes: `crm.CASE_STATUSES`, `CUSTODY_STATUSES`, `APPLICANT_OUTCOMES`, `BILLING_STATUSES`, `CASE_TYPES`, `VISA_TYPES`, `COURIER_MODES`, `ENTRY_TYPES`, `PROCESSING_SPEEDS`, `LIVE_CASE_STATUSES` from `@rgs/shared`.
- Produces:
  - `CASE_STATUS_LABELS`, `CUSTODY_LABELS`, `OUTCOME_LABELS`, `BILLING_LABELS`, `CASE_TYPE_LABELS`, `VISA_TYPE_LABELS`, `COURIER_LABELS` — each a total `Record<Enum, string>`.
  - `describeCustodyRollUp(summary: crm.ApplicantSummary): string` and `describeOutcomeRollUp(summary)`.
  - `<AxisChip axis="caseStatus" | "custody" | "outcome" | "billing" value={...} />`

**Why the labels are total records and not lookups with a fallback.** `Record<CaseStatus, string>` fails to compile the day someone adds a tenth case status; `labels[value] ?? value` compiles forever and ships `NOT_SUBMITTED` to a desk agent. Spec §4: enum values are never shown raw, and this is the mechanism that makes forgetting impossible.

- [ ] **Step 1: Install the test harness**

```bash
pnpm --filter @rgs/admin add -D vitest@^2.1.0 jsdom@^25.0.0 @testing-library/react@^16.1.0 @testing-library/user-event@^14.5.0 @testing-library/jest-dom@^6.6.0 @vitest/coverage-v8@^2.1.0
pnpm --filter @rgs/admin add @tanstack/react-virtual@^3.10.0
```

Change the `test` script in `apps/admin/package.json` from the `echo` placeholder to `"vitest run"`. That placeholder is why `pnpm -r test` has been green on this app while nothing ran.

`apps/admin/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
```

`apps/admin/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom has no layout engine: every element reports a zero-sized rect and
 * zero client dimensions. TanStack Virtual measures its scroll container to
 * decide what to mount, so under jsdom it mounts NOTHING -- and a test that
 * queries for a row then passes on `expect(rows).toHaveLength(0)` has tested
 * nothing at all. This is spec §10's first named trap.
 *
 * Giving the JSDOM element prototypes a real size is what makes the
 * virtualizer mount a real window of rows, so an assertion about row content
 * is an assertion about something that exists. `installVirtualViewport` in
 * test/crm/virtual.ts is the per-test knob; this is the floor.
 */
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(): number {
    return Number(this.dataset?.["testHeight"] ?? 800);
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(): number {
    return Number(this.dataset?.["testWidth"] ?? 1400);
  },
});
```

- [ ] **Step 2: Write the failing label and chip tests**

`apps/admin/test/crm/labels.test.ts`:

```ts
import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
  describeCustodyRollUp,
} from "../../src/crm/labels";

describe("display labels", () => {
  it("names every value of every axis, so no enum can reach a screen raw", () => {
    for (const caseStatus of crm.CASE_STATUSES) expect(CASE_STATUS_LABELS[caseStatus]).toBeTruthy();
    for (const custody of crm.CUSTODY_STATUSES) expect(CUSTODY_LABELS[custody]).toBeTruthy();
    for (const outcome of crm.APPLICANT_OUTCOMES) expect(OUTCOME_LABELS[outcome]).toBeTruthy();
    for (const billing of crm.BILLING_STATUSES) expect(BILLING_LABELS[billing]).toBeTruthy();
  });

  it("uses RGS's own words, reviewable in one place", () => {
    expect(CUSTODY_LABELS.NOT_HELD).toBe("Not held");
    expect(CUSTODY_LABELS.WITH_RGS).toBe("With us");
    expect(CUSTODY_LABELS.AT_EMBASSY).toBe("At embassy");
    expect(CUSTODY_LABELS.IN_TRANSIT).toBe("In transit");
    expect(CUSTODY_LABELS.RETURNED).toBe("Returned");
  });
});

describe("describeCustodyRollUp", () => {
  it("states the single value when every applicant agrees", () => {
    expect(describeCustodyRollUp({ count: 3, custody: { AT_EMBASSY: 3 }, outcome: {} })).toBe(
      "At embassy",
    );
  });

  it("counts each value when they disagree, commonest first", () => {
    expect(
      describeCustodyRollUp({ count: 3, custody: { AT_EMBASSY: 2, WITH_RGS: 1 }, outcome: {} }),
    ).toBe("2 at embassy · 1 with us");
  });

  it("says so when the case has never been summarised, rather than inventing a zero", () => {
    expect(describeCustodyRollUp(undefined)).toBe("Not summarised");
  });
});
```

`apps/admin/test/crm/Chip.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AxisChip } from "../../src/crm/components/Chip";

describe("AxisChip", () => {
  it("renders the label, never the enum", () => {
    render(<AxisChip axis="custody" value="AT_EMBASSY" />);
    expect(screen.getByText("At embassy")).toBeInTheDocument();
    expect(screen.queryByText("AT_EMBASSY")).not.toBeInTheDocument();
  });

  it("tints a live case status differently from a decided one", () => {
    const { container: liveChip } = render(<AxisChip axis="caseStatus" value="IN_PROGRESS" />);
    const { container: decidedChip } = render(<AxisChip axis="caseStatus" value="DECIDED" />);
    expect(liveChip.firstElementChild?.className).not.toBe(decidedChip.firstElementChild?.className);
  });

  it("marks an UNKNOWN billing status as data debt, with a dashed border", () => {
    render(<AxisChip axis="billing" value="UNKNOWN" />);
    const chip = screen.getByText("Unknown");
    // Spec §3: UNKNOWN is not a state the business chose, it is what the
    // importer wrote when it could not read the sheet. It must not look like
    // a value someone decided on.
    expect(chip.className).toContain("border-dashed");
    expect(chip).toHaveAttribute("title", expect.stringContaining("import"));
  });

  it("gives UNBILLED a solid border, so debt and a real state are told apart", () => {
    render(<AxisChip axis="billing" value="UNBILLED" />);
    expect(screen.getByText("Unbilled").className).not.toContain("border-dashed");
  });
});
```

- [ ] **Step 3: Run and watch them fail** — `pnpm --filter @rgs/admin test`. Expected: FAIL on the missing modules.

- [ ] **Step 4: Write `theme.css`**

```css
/*
 * Notion's brand tokens (spec §3), as Tailwind 4 theme variables so they
 * generate utilities: --color-crm-canvas becomes bg-crm-canvas, text-crm-ink,
 * border-crm-rule-row and so on. The spec writes these as --crm-canvas; the
 * --color- prefix is what Tailwind 4 keys its colour utilities off, and is the
 * only change to the names.
 *
 * Two departures from the fetched Notion DESIGN.md, both from spec §3, both
 * deliberate: body type is 14px/1.45 rather than 16px/1.55 (that document
 * describes Notion's MARKETING site and carries no guidance on dense database
 * views; a desk agent must see ~30 cases without scrolling), and buttons are
 * 8px rectangles, never pills -- which is kept from the document verbatim and
 * is the easiest thing here to get wrong by habit.
 */
@theme {
  --color-crm-canvas: #ffffff;
  --color-crm-surface: #f6f5f4;
  --color-crm-ink: #1a1a1a;
  --color-crm-charcoal: #37352f;
  --color-crm-steel: #787671;
  --color-crm-rule-row: #ede9e4;
  --color-crm-rule-box: #e5e3df;
  /* Reserved. One control in the entire product: Approve on a proposal card. */
  --color-crm-primary: #5645d4;
  /* Inline links only. Never a button. */
  --color-crm-link: #0075de;

  --color-crm-lavender: #e6e0f5;
  --color-crm-mint: #d9f3e1;
  --color-crm-rose: #fde0ec;
  --color-crm-peach: #ffe8d4;
  --color-crm-yellow: #f9e79f;

  --radius-crm-chip: 4px;
  --radius-crm-badge: 6px;
  --radius-crm-control: 8px;
  --radius-crm-card: 12px;

  --spacing-crm-row: 32px;
}

.crm-root {
  font-size: 14px;
  line-height: 1.45;
  color: var(--color-crm-ink);
  background: var(--color-crm-canvas);
}
```

Import it from `apps/admin/src/crm/CrmLayout.tsx` (Task 10) — not from the app's global `styles.css`, so the CRM tokens cannot leak into the visa-platform pages.

- [ ] **Step 5: Write `labels.ts`**

```ts
import { crm } from "@rgs/shared";

/**
 * The single display-label map. RGS reviews these in their own words, and a
 * wording change happens here and nowhere else.
 *
 * Every map is a TOTAL Record, not a lookup with a fallback: a total record
 * stops compiling the day a tenth case status is added to the shared package,
 * whereas `labels[value] ?? value` compiles forever and ships NOT_SUBMITTED to
 * a desk agent's screen.
 */
export const CASE_STATUS_LABELS: Record<crm.CaseStatus, string> = {
  NEW: "New",
  IN_PROGRESS: "In progress",
  APPOINTMENT_SET: "Appointment set",
  SUBMITTED: "Submitted",
  DECIDED: "Decided",
  CLOSED: "Closed",
  NOT_SUBMITTED: "Not submitted",
  WITHDRAWN: "Withdrawn",
  DUPLICATE: "Duplicate",
};

export const CUSTODY_LABELS: Record<crm.CustodyStatus, string> = {
  NOT_HELD: "Not held",
  WITH_RGS: "With us",
  AT_EMBASSY: "At embassy",
  IN_TRANSIT: "In transit",
  RETURNED: "Returned",
};

export const OUTCOME_LABELS: Record<crm.ApplicantOutcome, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

export const BILLING_LABELS: Record<crm.BillingStatus, string> = {
  UNBILLED: "Unbilled",
  BILL_SENT: "Bill sent",
  PAID: "Paid",
  PART_PAID: "Part paid",
  WRITTEN_OFF: "Written off",
  UNKNOWN: "Unknown",
};

export const CASE_TYPE_LABELS: Record<crm.CaseType, string> = {
  VISA: "Visa",
  ATTESTATION: "Attestation",
  APOSTILLE: "Apostille",
  PASSPORT: "Passport",
  OTHER: "Other",
};

export const COURIER_LABELS: Record<crm.CourierMode, string> = {
  DTDC: "DTDC",
  SPEEDPOST: "Speed Post",
  BLUEDART: "Blue Dart",
  PORTER: "Porter",
  HANDOVER: "Handover",
  PICKUP: "Pickup",
};

/** VISA_TYPES has twenty members; write all twenty out. Sentence case, and the
 *  acronyms RGS actually says: "B1/B2", "e-Visa (tourist)", "MDAC", "VEVO". */
export const VISA_TYPE_LABELS: Record<crm.VisaType, string> = {
  TOURIST: "Tourist",
  BUSINESS: "Business",
  EVISA_TOURIST: "e-Visa (tourist)",
  B1_B2: "B1/B2",
  FAMILY_VISIT: "Family visit",
  DEPENDENT: "Dependent",
  STUDY: "Study",
  WORK: "Work",
  SEAMAN: "Seaman",
  RELATIVE: "Relative",
  TRADE_FAIR: "Trade fair",
  SPORTS: "Sports",
  TRANSIT: "Transit",
  MDAC: "MDAC",
  STP: "STP",
  STR: "STR",
  F_VISA: "F visa",
  VEVO: "VEVO",
  E_VISA: "e-Visa",
  OTHER: "Other",
};

/**
 * The collapsed parent row's whole job (spec §4): carry enough per-applicant
 * signal that expanding is rarely needed. One value when every applicant
 * agrees; counts, commonest first, when they do not.
 *
 * `undefined` is a real and different answer: a case imported before the
 * roll-up existed has no summary, and "Not summarised" is the honest thing to
 * show. A zero would claim the case has no applicants.
 */
export function describeCustodyRollUp(summary: crm.ApplicantSummary | undefined): string {
  return describeRollUp(summary?.custody, CUSTODY_LABELS);
}

export function describeOutcomeRollUp(summary: crm.ApplicantSummary | undefined): string {
  return describeRollUp(summary?.outcome, OUTCOME_LABELS);
}

function describeRollUp<StateType extends string>(
  counts: Partial<Record<StateType, number>> | undefined,
  labels: Record<StateType, string>,
): string {
  if (counts === undefined) return "Not summarised";
  const presentStates = (Object.entries(counts) as [StateType, number][])
    .filter(([, stateCount]) => stateCount > 0)
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount);
  if (presentStates.length === 0) return "Not summarised";
  const [firstState] = presentStates;
  if (presentStates.length === 1) return labels[firstState![0]];
  return presentStates
    .map(([stateName, stateCount]) => `${stateCount} ${labels[stateName].toLowerCase()}`)
    .join(" · ");
}
```

- [ ] **Step 6: Write `Chip.tsx`**

```tsx
import { crm } from "@rgs/shared";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CUSTODY_LABELS,
  OUTCOME_LABELS,
} from "../labels";

/**
 * The four state axes as Notion property chips (spec §3). The tint mapping is
 * PRINCIPLED, not per-value taste, and each rule is written next to the values
 * it governs so a fifth value added later has an obvious home.
 */
const LAVENDER = "bg-crm-lavender text-crm-charcoal";
const MINT = "bg-crm-mint text-crm-charcoal";
const ROSE = "bg-crm-rose text-crm-charcoal";
const PEACH = "bg-crm-peach text-crm-charcoal";
const YELLOW = "bg-crm-yellow text-crm-charcoal";
const STEEL = "bg-crm-surface text-crm-steel";

/** live → lavender; decided → mint; abandoned → rose; inert → steel. */
const CASE_STATUS_TINTS: Record<crm.CaseStatus, string> = {
  NEW: LAVENDER,
  IN_PROGRESS: LAVENDER,
  APPOINTMENT_SET: LAVENDER,
  SUBMITTED: LAVENDER,
  DECIDED: MINT,
  NOT_SUBMITTED: ROSE,
  WITHDRAWN: ROSE,
  DUPLICATE: ROSE,
  CLOSED: STEEL,
};

/** RGS holds something → peach; in motion → yellow; settled → mint; nothing held → steel. */
const CUSTODY_TINTS: Record<crm.CustodyStatus, string> = {
  WITH_RGS: PEACH,
  AT_EMBASSY: PEACH,
  IN_TRANSIT: YELLOW,
  RETURNED: MINT,
  NOT_HELD: STEEL,
};

/** good → mint; bad → rose; needs action → yellow; waiting → steel. */
const OUTCOME_TINTS: Record<crm.ApplicantOutcome, string> = {
  APPROVED: MINT,
  REJECTED: ROSE,
  SENT_BACK: YELLOW,
  PENDING: STEEL,
};

/** paid → mint; owed → yellow; partial → peach; written off → rose; unbilled → steel. */
const BILLING_TINTS: Record<crm.BillingStatus, string> = {
  PAID: MINT,
  BILL_SENT: YELLOW,
  PART_PAID: PEACH,
  WRITTEN_OFF: ROSE,
  UNBILLED: STEEL,
  UNKNOWN: STEEL,
};

/**
 * UNKNOWN is not a state the business chose -- it is what the importer wrote
 * when it could not read the sheet (spec §3). Making data debt visibly
 * different from a real value is the point: those rows should look unresolved,
 * because seven questions are open with RGS about exactly them.
 */
const DATA_DEBT_BORDER = "border border-dashed border-crm-steel";
const SOLID_BORDER = "border border-transparent";

export type ChipAxis = "caseStatus" | "custody" | "outcome" | "billing";

interface AxisChipProps {
  axis: "caseStatus";
  value: crm.CaseStatus;
}
type AnyAxisChipProps =
  | { axis: "caseStatus"; value: crm.CaseStatus }
  | { axis: "custody"; value: crm.CustodyStatus }
  | { axis: "outcome"; value: crm.ApplicantOutcome }
  | { axis: "billing"; value: crm.BillingStatus };

export function AxisChip(props: AnyAxisChipProps) {
  const { label, tint, isDataDebt } = describeChip(props);
  return (
    <span
      className={`inline-flex h-5 items-center rounded-crm-chip px-1.5 text-[12px] leading-none ${tint} ${
        isDataDebt ? DATA_DEBT_BORDER : SOLID_BORDER
      }`}
      {...(isDataDebt
        ? { title: "The import could not read a billing state for this case" }
        : {})}
    >
      {label}
    </span>
  );
}

function describeChip(props: AnyAxisChipProps): {
  label: string;
  tint: string;
  isDataDebt: boolean;
} {
  switch (props.axis) {
    case "caseStatus":
      return {
        label: CASE_STATUS_LABELS[props.value],
        tint: CASE_STATUS_TINTS[props.value],
        isDataDebt: false,
      };
    case "custody":
      return {
        label: CUSTODY_LABELS[props.value],
        tint: CUSTODY_TINTS[props.value],
        isDataDebt: false,
      };
    case "outcome":
      return {
        label: OUTCOME_LABELS[props.value],
        tint: OUTCOME_TINTS[props.value],
        isDataDebt: false,
      };
    case "billing":
      return {
        label: BILLING_LABELS[props.value],
        tint: BILLING_TINTS[props.value],
        isDataDebt: props.value === "UNKNOWN",
      };
  }
}
```

(Delete the unused `AxisChipProps`/`ChipAxis` declarations if the implementation does not need them — they are listed above only to show the discriminated shape.)

- [ ] **Step 7: Run, prove they can fail, commit**

Run: `pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck`
Then remove the `IN_TRANSIT` entry from `CUSTODY_TINTS` and confirm `typecheck` fails (that is the total-record guarantee doing its job), and remove the `border-dashed` from the UNKNOWN branch and confirm the chip test goes red. Restore both.

```bash
git add apps/admin/package.json apps/admin/vitest.config.ts apps/admin/test apps/admin/src/crm pnpm-lock.yaml
git commit -m "feat(crm-ui): test harness, Notion tokens, labels and axis chips"
```

---

### Task 9: The CRM API client and its query hooks

**Files:**
- Create: `apps/admin/src/crm/api/crmClient.ts`
- Create: `apps/admin/src/crm/api/hooks.ts`
- Test: `apps/admin/test/crm/crmClient.test.ts`

**Interfaces:**
- Consumes: `ApiRequestError` and the `apiFetch` shape from `apps/admin/src/lib/adminApi.ts` (copy the helper into `crmClient.ts` rather than exporting it — see below); `unwrapListingResponse` from `@rgs/shared`; `useAuth()` for `idToken`.
- Produces (`crmClient.ts`), every one typed against the real route:

```ts
export interface LedgerPageResponse {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  nextCursor?: string;
  appliedQuery: { statuses: crm.CaseStatus[]; partnerId?: string; limit: number };
}
export interface LedgerLoad {
  rows: crm.LedgerRow[];
  unreadableCaseIds: string[];
  /** True when the page cap stopped the walk before the cursor ran out. */
  truncated: boolean;
  appliedQuery: LedgerPageResponse["appliedQuery"];
}

export const crmClient = {
  fetchLedgerPage(idToken, params: { statuses?: crm.CaseStatus[]; partnerId?: string; limit?: number; cursor?: string }): Promise<LedgerPageResponse>,
  loadLedger(idToken, params: { statuses?: crm.CaseStatus[]; partnerId?: string }): Promise<LedgerLoad>,
  getCase(idToken, caseId: string): Promise<crm.CrmCase>,
  listCaseEvents(idToken, caseId: string): Promise<CrmEventView[]>,
  updateCaseDetails(idToken, caseId: string, input: UpdateCaseDetailsBody): Promise<crm.CrmCase>,
  setCaseStatus(idToken, caseId: string, toStatus: crm.CaseStatus): Promise<crm.CrmCase>,
  setBillingStatus(idToken, caseId: string, toBillingStatus: crm.BillingStatus): Promise<crm.CrmCase>,
  setCustody(idToken, caseId: string, applicantRef: string, toCustody: crm.CustodyStatus): Promise<crm.CrmCase>,
  setOutcome(idToken, caseId: string, applicantRef: string, toOutcome: crm.ApplicantOutcome): Promise<crm.CrmCase>,
  listPartners(idToken): Promise<crm.Partner[]>,
  fetchReviewSummary(idToken): Promise<{ entries: OpenReviewSummaryEntry[]; unreadableReviewItemIds: string[] }>,
  getReviewItem(idToken, reviewItemId: string): Promise<crm.ReviewItem>,
  resolveReviewItem(idToken, reviewItemId: string, resolution: { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string }): Promise<crm.ReviewItem>,
  runAgentTurn(idToken, body: { userMessage: string; conversation: AgentMessageWire[] }): Promise<AgentTurnResponse>,
  listProposals(idToken): Promise<{ proposals: ProposalView[]; unreadableProposalIds: string[] }>,
  approveProposal(idToken, proposalId: string, editedInput?: Record<string, unknown>): Promise<ApprovalResult>,
  discardProposal(idToken, proposalId: string, reason: string): Promise<ProposalView>,
  listMemories(idToken, scope: "ORG" | "PARTNER" | "USER", partnerId?: string): Promise<{ memories: crm.CrmMemory[] }>,
  forgetMemory(idToken, memoryKey: string, scope: "ORG" | "PARTNER" | "USER", partnerId?: string): Promise<{ forgotten: boolean }>,
};
```

**Methods, verified against the route table at `main` = `88b5c46`. Get these wrong and the screen 404s in production while every mocked test passes:**

| Operation | Method | Path |
|---|---|---|
| Ledger page | GET | `/api/v1/admin/crm/cases/ledger` |
| Case detail | GET | `/api/v1/admin/crm/cases/{caseId}` |
| Case timeline | GET | `/api/v1/admin/crm/cases/{caseId}/events` → `{ events }` |
| Case details edit | **PUT** | `/api/v1/admin/crm/cases/{caseId}` (Task 7) |
| Case status | **PUT** | `/api/v1/admin/crm/cases/{caseId}/status` body `{ toStatus }` |
| Billing | **PUT** | `/api/v1/admin/crm/cases/{caseId}/billing` body `{ toBillingStatus }` |
| Custody | **PUT** | `/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/custody` body `{ toCustody }` |
| Outcome | **PUT** | `/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/outcome` body `{ toOutcome }` |
| Partners | GET | `/api/v1/admin/crm/partners` → `{ partners, unreadablePartnerIds }` |
| Review summary | GET | `/api/v1/admin/crm/review/summary` (Task 5) |
| One review item | GET | `/api/v1/admin/crm/review/{reviewItemId}` |
| Resolve | **PUT** | `/api/v1/admin/crm/review/{reviewItemId}/resolve` body `{ reviewStatus, resolvedValue? }` |
| Agent turn | POST | `/api/v1/admin/crm/agent/turn` |
| Proposals | GET | `/api/v1/admin/crm/agent/proposals` |
| Approve | **PUT** | `/api/v1/admin/crm/agent/proposals/{proposalId}/approve` body `{ editedInput? }` |
| Discard | **PUT** | `/api/v1/admin/crm/agent/proposals/{proposalId}/discard` body `{ reason }` |
| Memories | GET / POST / DELETE | `/api/v1/admin/crm/agent/memories[/{memoryKey}]?scope=…` |

Spec §2 and §6 say POST for resolve, approve and discard. **The code says PUT, and the deployed API Gateway admin route declares no PATCH but does declare PUT.** The code wins; this table is the record of that decision.

**Why `apiFetch` is copied rather than imported.** `adminApi.ts`'s copy is module-private and its listing helper is shaped around the visa-platform payloads. Copying ~20 lines keeps the CRM directory independent of a file this plan otherwise never touches, which is the separation spec §2 asks for. It is the one duplication in this plan and it is deliberate.

**Why `loadLedger` walks the cursor to the end.** The Ledger's filtering, sorting and text search are client-side over the loaded window (spec §2.1), and the window is the whole ledger: ~1.4 MB for 7,156 rows. `loadLedger` follows `nextCursor` until it is absent, capped at `MAX_LEDGER_PAGES = 40` (20,000 rows at the default page size). Hitting the cap sets `truncated: true` and the screen says so — a silently short ledger is a desk agent concluding a case does not exist.

- [ ] **Step 1: Write the failing client test**

`apps/admin/test/crm/crmClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { crmClient } from "../../src/crm/api/crmClient";

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

function stubFetch(responses: unknown[]): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  let responseIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      recorded.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const payload = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
  return recorded;
}

const oneRow = {
  caseId: "case_1",
  caseRef: "RGS-1001",
  partnerId: "partner_1",
  destinationCountry: "AE",
  caseType: "VISA",
  caseStatus: "NEW",
  billingStatus: "UNBILLED",
  receivedDate: "2026-03-04",
  totalInr: 12000,
  updatedAt: "2026-03-04T10:00:00.000Z",
};

describe("crmClient.loadLedger", () => {
  it("follows the cursor to the end and concatenates every page", async () => {
    const recorded = stubFetch([
      { rows: [oneRow], unreadableCaseIds: [], nextCursor: "cursor-2", appliedQuery: { statuses: [], limit: 500 } },
      { rows: [{ ...oneRow, caseId: "case_2" }], unreadableCaseIds: ["case_bad"], appliedQuery: { statuses: [], limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", {});

    expect(load.rows.map((row) => row.caseId)).toEqual(["case_1", "case_2"]);
    expect(load.unreadableCaseIds).toEqual(["case_bad"]);
    expect(load.truncated).toBe(false);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.url).toContain("cursor=cursor-2");
    expect(recorded[0]!.authorization).toBe("Bearer token-1");
  });

  it("stops at the page cap and says it stopped", async () => {
    // A server that always returns a cursor. Without a cap this loops until
    // the tab dies; without the flag the screen shows part of the ledger and
    // looks complete.
    const recorded = stubFetch([
      { rows: [oneRow], unreadableCaseIds: [], nextCursor: "always", appliedQuery: { statuses: [], limit: 500 } },
    ]);

    const load = await crmClient.loadLedger("token-1", {});

    expect(load.truncated).toBe(true);
    expect(recorded.length).toBeLessThanOrEqual(40);
  });

  it("joins repeated statuses with commas, the way API Gateway delivers them", async () => {
    const recorded = stubFetch([{ rows: [], unreadableCaseIds: [], appliedQuery: { statuses: [], limit: 500 } }]);

    await crmClient.loadLedger("token-1", { statuses: ["NEW", "SUBMITTED"] });

    expect(recorded[0]!.url).toContain("status=NEW%2CSUBMITTED");
  });
});

describe("crmClient write methods", () => {
  it("PUTs a case status to the status route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setCaseStatus("token-1", "case_1", "SUBMITTED");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/status"),
      method: "PUT",
      body: { toStatus: "SUBMITTED" },
    });
  });

  it("PUTs custody to the per-applicant route", async () => {
    const recorded = stubFetch([{ caseId: "case_1" }]);

    await crmClient.setCustody("token-1", "case_1", "A1", "AT_EMBASSY");

    expect(recorded[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/admin/crm/cases/case_1/applicants/A1/custody"),
      method: "PUT",
      body: { toCustody: "AT_EMBASSY" },
    });
  });

  it("PUTs a review resolution, not POSTs it", async () => {
    // Spec §7 says POST; crmApi.ts registers PUT and the API Gateway admin
    // route declares no PATCH. A POST here is a 404 in production that no
    // mocked test would catch, so the method is asserted explicitly.
    const recorded = stubFetch([{ reviewItemId: "rev_1" }]);

    await crmClient.resolveReviewItem("token-1", "rev_1", { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" });

    expect(recorded[0]!.method).toBe("PUT");
    expect(recorded[0]!.url).toContain("/api/v1/admin/crm/review/rev_1/resolve");
  });

  it("PUTs a proposal approval, not POSTs it", async () => {
    const recorded = stubFetch([{ proposalId: "prop_1" }]);

    await crmClient.approveProposal("token-1", "prop_1");

    expect(recorded[0]!.method).toBe("PUT");
    expect(recorded[0]!.url).toContain("/api/v1/admin/crm/agent/proposals/prop_1/approve");
  });

  it("surfaces the API's own error code and message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: "CONFLICT", message: "Cannot move a case from CLOSED to NEW" }),
      }) as Response),
    );

    await expect(crmClient.setCaseStatus("token-1", "case_1", "NEW")).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
      message: "Cannot move a case from CLOSED to NEW",
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail.** `pnpm --filter @rgs/admin test crmClient`

- [ ] **Step 3: Write `crmClient.ts`**

Start from `adminApi.ts:15-49`: the same `API_BASE_URL` from `import.meta.env.VITE_API_URL`, the same `ApiRequestError` (import it from `../../lib/adminApi`, which already exports it — only the private `apiFetch` is copied), the same `content-type` + `authorization` headers, the same `response.json().catch(() => ({}))`. Then:

```ts
const CRM_BASE = "/api/v1/admin/crm";
export const MAX_LEDGER_PAGES = 40;

async function fetchLedgerPage(
  idToken: string,
  params: { statuses?: crm.CaseStatus[]; partnerId?: string; limit?: number; cursor?: string },
): Promise<LedgerPageResponse> {
  const queryParams = new URLSearchParams();
  // Comma-joined, because API Gateway v2 collapses a repeated parameter into
  // exactly this and the route splits on commas (crmApi.ts parseLedgerStatuses).
  if (params.statuses !== undefined && params.statuses.length > 0) {
    queryParams.set("status", params.statuses.join(","));
  }
  if (params.partnerId !== undefined) queryParams.set("partnerId", params.partnerId);
  if (params.limit !== undefined) queryParams.set("limit", String(params.limit));
  if (params.cursor !== undefined) queryParams.set("cursor", params.cursor);
  const queryString = queryParams.toString();
  return apiFetch<LedgerPageResponse>(
    `${CRM_BASE}/cases/ledger${queryString ? `?${queryString}` : ""}`,
    { idToken },
  );
}

/**
 * Every row of the ledger, in as many requests as the cursor takes.
 *
 * The Ledger filters, sorts and searches client-side over the rows it holds
 * (spec §2.1 fixes the split), so "the rows it holds" has to be all of them --
 * about 1.4 MB projected, against 7-21 MB of full case records.
 *
 * Capped, and honest when the cap bites: a server bug that always answers with
 * a cursor would otherwise spin until the tab dies, and a ledger that quietly
 * stops at row 5,000 is a desk agent concluding a case does not exist.
 */
async function loadLedger(
  idToken: string,
  params: { statuses?: crm.CaseStatus[]; partnerId?: string },
): Promise<LedgerLoad> {
  const rows: crm.LedgerRow[] = [];
  const unreadableCaseIds: string[] = [];
  let cursor: string | undefined;
  let appliedQuery: LedgerPageResponse["appliedQuery"] = {
    statuses: params.statuses ?? [],
    ...(params.partnerId !== undefined ? { partnerId: params.partnerId } : {}),
    limit: 0,
  };
  let pagesRead = 0;

  do {
    const page = await fetchLedgerPage(idToken, { ...params, ...(cursor !== undefined ? { cursor } : {}) });
    rows.push(...page.rows);
    unreadableCaseIds.push(...page.unreadableCaseIds);
    appliedQuery = page.appliedQuery;
    cursor = page.nextCursor;
    pagesRead += 1;
  } while (cursor !== undefined && pagesRead < MAX_LEDGER_PAGES);

  return { rows, unreadableCaseIds, truncated: cursor !== undefined, appliedQuery };
}
```

The remaining methods are one line each over `apiFetch`, following the table above exactly.

- [ ] **Step 4: Write `hooks.ts`**

```ts
/**
 * Query keys are namespaced under "crm" so nothing here can collide with the
 * visa-platform pages sharing this QueryClient.
 */
export const crmQueryKeys = {
  ledger: (statuses: crm.CaseStatus[], partnerId: string | undefined) =>
    ["crm", "ledger", statuses.join(","), partnerId ?? ""] as const,
  case: (caseId: string) => ["crm", "case", caseId] as const,
  caseEvents: (caseId: string) => ["crm", "case", caseId, "events"] as const,
  partners: () => ["crm", "partners"] as const,
  reviewSummary: () => ["crm", "review", "summary"] as const,
  reviewItem: (reviewItemId: string) => ["crm", "review", reviewItemId] as const,
  proposals: () => ["crm", "proposals"] as const,
  memories: (scope: string, partnerId: string | undefined) =>
    ["crm", "memories", scope, partnerId ?? ""] as const,
};

export function useLedgerRows(statuses: crm.CaseStatus[], partnerId?: string) {
  const { idToken } = useAuth();
  return useQuery({
    queryKey: crmQueryKeys.ledger(statuses, partnerId),
    queryFn: () => crmClient.loadLedger(idToken!, { statuses, ...(partnerId ? { partnerId } : {}) }),
    enabled: idToken !== null,
    // The ledger is a 1.4 MB read; the app's 30s default would re-fetch it
    // every time a desk agent tabs back. Five minutes, and every mutation
    // invalidates it explicitly, so staleness is never how a change appears.
    staleTime: 5 * 60_000,
  });
}
```

`useCase`, `useCaseEvents`, `usePartners`, `useReviewSummary`, `useReviewItem`, `useProposals`, `useMemories` follow the same shape with the app's default `staleTime`. The mutation hooks land in Task 12, where the optimistic-update contract is defined and tested.

- [ ] **Step 5: Run, prove it can fail, commit**

Run: `pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck`
Then change `setCaseStatus` to POST and confirm the method test goes red; change `loadLedger`'s cap to `Infinity` and confirm the cap test hangs or fails. Restore both.

```bash
git add apps/admin/src/crm/api apps/admin/test/crm/crmClient.test.ts
git commit -m "feat(crm-ui): typed CRM API client and query hooks"
```

---

### Task 10: The virtualized Ledger table

**Files:**
- Create: `apps/admin/src/crm/CrmLayout.tsx`
- Create: `apps/admin/src/crm/ledger/columns.ts`
- Create: `apps/admin/src/crm/ledger/LedgerTable.tsx`
- Create: `apps/admin/src/crm/ledger/LedgerPage.tsx`
- Modify: `apps/admin/src/main.tsx` (mount `/crm` and `/crm/cases/:caseId`)
- Create: `apps/admin/test/crm/virtual.ts` (the virtualization-aware test helper)
- Test: `apps/admin/test/crm/LedgerTable.test.tsx`

**Interfaces:**
- Consumes: `useLedgerRows`, `usePartners` (Task 9); `AxisChip` (Task 8); `describeCustodyRollUp`, `describeOutcomeRollUp`, label maps (Task 8); `crm.LedgerRow`.
- Produces:
  - `LEDGER_COLUMNS: readonly LedgerColumn[]` where
    `interface LedgerColumn { key: string; header: string; width: number; sticky?: boolean; editable?: "caseStatus" | "billingStatus" | "appointmentDate" | "visaType"; render(row: crm.LedgerRow, partnerName: string): ReactNode }`
  - `LEDGER_ROW_HEIGHT = 32`
  - `<LedgerTable rows={...} partnerNamesById={...} ... />` with `data-testid="ledger-row"` and `data-case-id` on every mounted row.
  - `renderLedgerTable(...)` / `mountedCaseIds(...)` in the test helper.

**The columns, left to right, from spec §4 — this order is the spec's and is not the implementer's to improve:**

`caseRef` (sticky) · partner canonical name · `destinationCountry` · `caseType` (with `visaType` when present) · applicants (count + custody roll-up) · `caseStatus` · `billingStatus` · `receivedDate` · `appointmentDate` · `totalInr`.

The header row is sticky. The REF column is sticky-left. Row height is exactly 32px so ~30 cases are visible without scrolling — this is the density argument in spec §3 and it is why the type scale departs from the fetched Notion doc.

**Spec §10's first named trap, and how this task closes it.** Under jsdom every element has a zero-sized rect, so TanStack Virtual mounts no rows at all — and `expect(screen.queryAllByTestId("ledger-row")).toHaveLength(0)` passes triumphantly against a table that renders nothing. Two mechanisms, both required:

1. `test/setup.ts` (Task 8) gives `HTMLElement.prototype` a non-zero `offsetHeight`/`offsetWidth`.
2. `test/crm/virtual.ts` below exposes `mountedCaseIds(...)` and **every assertion about row content in this plan goes through it**, plus a guard test that fails loudly if the virtualizer mounted nothing.

- [ ] **Step 1: Write the virtualization test helper**

`apps/admin/test/crm/virtual.ts`:

```ts
import { render, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";
import type { ReactElement } from "react";

/**
 * Rows the virtualizer ACTUALLY mounted, with a guard.
 *
 * A query for a row that was never rendered passes trivially, which is spec
 * §10's first named trap. Every assertion about row content must be made
 * against this function's output, and this function refuses to hand back an
 * empty list without saying why -- so a test that stops seeing rows fails as
 * "the virtualizer mounted nothing" rather than as a quietly true assertion
 * about an empty set.
 */
export function mountedCaseIds(container: HTMLElement, options: { allowEmpty?: boolean } = {}): string[] {
  const rowElements = [...container.querySelectorAll("[data-testid='ledger-row']")];
  if (rowElements.length === 0 && options.allowEmpty !== true) {
    throw new Error(
      "The virtualizer mounted no ledger rows. Either the scroll container measured zero " +
        "(check test/setup.ts's offsetHeight shim) or the table rendered nothing. Pass " +
        "{ allowEmpty: true } if an empty table is what this test is asserting.",
    );
  }
  return rowElements.map((rowElement) => rowElement.getAttribute("data-case-id") ?? "");
}

/** The cell of one mounted row, by column key. Throws if the row is not mounted. */
export function mountedCell(container: HTMLElement, caseId: string, columnKey: string): HTMLElement {
  const rowElement = container.querySelector(`[data-testid='ledger-row'][data-case-id='${caseId}']`);
  if (rowElement === null) {
    throw new Error(
      `Case ${caseId} is not among the mounted rows (${mountedCaseIds(container, { allowEmpty: true }).join(", ") || "none"}). ` +
        "Scroll it into the window before asserting on it.",
    );
  }
  const cellElement = rowElement.querySelector(`[data-column='${columnKey}']`);
  if (cellElement === null) throw new Error(`Row ${caseId} has no column ${columnKey}`);
  return cellElement as HTMLElement;
}

/** Scrolls the table's own scroll container and lets the virtualizer re-measure. */
export async function scrollLedgerTo(container: HTMLElement, scrollTop: number): Promise<void> {
  const scrollContainer = container.querySelector("[data-testid='ledger-scroll']");
  if (scrollContainer === null) throw new Error("No ledger scroll container in this render");
  scrollContainer.scrollTop = scrollTop;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function renderLedger(element: ReactElement): RenderResult {
  const result = render(element);
  // Fail fast, once, at the render rather than at the first confusing
  // assertion three lines later.
  expect(result.container.querySelector("[data-testid='ledger-scroll']")).not.toBeNull();
  return result;
}
```

- [ ] **Step 2: Write the failing table test**

`apps/admin/test/crm/LedgerTable.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { mountedCaseIds, mountedCell, renderLedger, scrollLedgerTo } from "./virtual";

function buildRows(rowCount: number): crm.LedgerRow[] {
  return Array.from({ length: rowCount }, (_unused, rowIndex) => ({
    caseId: `case_${String(rowIndex).padStart(4, "0")}`,
    caseRef: `RGS-${1000 + rowIndex}`,
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA" as const,
    visaType: "TOURIST" as const,
    caseStatus: "IN_PROGRESS" as const,
    billingStatus: "UNKNOWN" as const,
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-04T10:00:00.000Z",
    applicantSummary: { count: 3, custody: { AT_EMBASSY: 2, WITH_RGS: 1 }, outcome: { PENDING: 3 } },
  }));
}

const partnerNames = { partner_1: "Skyline Travels" };

describe("LedgerTable", () => {
  it("mounts a window of rows, not all 7,156", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );

    const mounted = mountedCaseIds(container);
    expect(mounted.length).toBeGreaterThan(5);
    // The whole reason for virtualizing. If this ever passes with 7,156, the
    // virtualizer has been bypassed and the screen will die on real data.
    expect(mounted.length).toBeLessThan(200);
    expect(mounted[0]).toBe("case_0000");
  });

  it("renders the spec's columns, in the spec's order", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(10)} partnerNamesById={partnerNames} />,
    );

    const headerKeys = [...container.querySelectorAll("[data-testid='ledger-header'] [data-column]")].map(
      (cell) => cell.getAttribute("data-column"),
    );
    expect(headerKeys).toEqual([
      "caseRef",
      "partner",
      "destinationCountry",
      "caseType",
      "applicants",
      "caseStatus",
      "billingStatus",
      "receivedDate",
      "appointmentDate",
      "totalInr",
    ]);
  });

  it("shows the partner's canonical name, not the partner id", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "partner").textContent).toBe("Skyline Travels");
  });

  it("carries the custody roll-up on the collapsed parent row", () => {
    // Spec §4: the collapsed parent must carry enough per-applicant signal
    // that expanding is rarely needed, and the roll-up comes from the META
    // item's summary -- the row never reads applicant records.
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    const applicantsCell = mountedCell(container, "case_0000", "applicants");
    expect(applicantsCell.textContent).toContain("3");
    expect(applicantsCell.textContent).toContain("2 at embassy · 1 with us");
  });

  it("says 'Not summarised' for a case imported before the roll-up existed", () => {
    const [rowWithoutSummary] = buildRows(1);
    const { applicantSummary: _dropped, ...bareRow } = rowWithoutSummary!;
    const { container } = renderLedger(
      <LedgerTable rows={[bareRow]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "applicants").textContent).toContain("Not summarised");
  });

  it("marks an UNKNOWN billing status as import debt", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(3)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "billingStatus").innerHTML).toContain("border-dashed");
  });

  it("mounts a different window after scrolling, and the far row really is there", async () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );
    expect(mountedCaseIds(container)).not.toContain("case_3000");

    await scrollLedgerTo(container, 3000 * 32);

    // Asserted against a row the virtualizer actually mounted -- this is the
    // mechanism spec §10 asks the plan to name.
    expect(mountedCaseIds(container)).toContain("case_3000");
    expect(mountedCell(container, "case_3000", "caseRef").textContent).toBe("RGS-4000");
  });

  it("renders an empty ledger as an empty state rather than a broken table", () => {
    const { container, getByText } = renderLedger(
      <LedgerTable rows={[]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCaseIds(container, { allowEmpty: true })).toEqual([]);
    expect(getByText(/no cases/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run and watch it fail.** `pnpm --filter @rgs/admin test LedgerTable`

- [ ] **Step 4: Write `columns.ts`**

```ts
import type { ReactNode } from "react";
import { crm } from "@rgs/shared";

/** Exactly 32px. Spec §3: a desk agent must see ~30 cases without scrolling. */
export const LEDGER_ROW_HEIGHT = 32;

export interface LedgerColumn {
  key: string;
  header: string;
  /** px. The table is a CSS grid, not a <table>: a virtualizer needs fixed track widths. */
  width: number;
  /** REF only. Sticky-left, so the row a desk agent is editing never loses its name. */
  sticky?: boolean;
  /**
   * Which axis an inline edit on this column writes to, or absent for a
   * read-only column. Only the four with a REST route are editable
   * (Task 7 + the three axis routes) -- a column with no route is not made
   * editable "for later", because the failure mode is a desk agent typing a
   * value that silently never saves.
   */
  editable?: "caseStatus" | "billingStatus" | "appointmentDate" | "visaType";
  render(row: crm.LedgerRow, partnerName: string): ReactNode;
}

export const LEDGER_COLUMNS: readonly LedgerColumn[] = [
  { key: "caseRef", header: "REF", width: 120, sticky: true, render: (row) => row.caseRef },
  { key: "partner", header: "Partner", width: 200, render: (_row, partnerName) => partnerName },
  { key: "destinationCountry", header: "Country", width: 80, render: (row) => row.destinationCountry },
  { key: "caseType", header: "Type", width: 150, render: (row) => describeCaseType(row) },
  { key: "applicants", header: "Applicants", width: 220, render: (row) => renderApplicants(row) },
  { key: "caseStatus", header: "Status", width: 140, editable: "caseStatus", render: (row) => <AxisChip axis="caseStatus" value={row.caseStatus} /> },
  { key: "billingStatus", header: "Billing", width: 120, editable: "billingStatus", render: (row) => <AxisChip axis="billing" value={row.billingStatus} /> },
  { key: "receivedDate", header: "Received", width: 110, render: (row) => row.receivedDate },
  { key: "appointmentDate", header: "Appointment", width: 120, editable: "appointmentDate", render: (row) => row.appointmentDate ?? "—" },
  { key: "totalInr", header: "Total", width: 110, render: (row) => formatInr(row.totalInr) },
];
```

with `describeCaseType` returning `CASE_TYPE_LABELS[row.caseType]` plus ` · ${VISA_TYPE_LABELS[row.visaType]}` when `visaType` is present, `renderApplicants` returning the count and `describeCustodyRollUp(row.applicantSummary)`, and `formatInr` using `new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })`.

(`columns.ts` contains JSX, so name it `columns.tsx`.)

- [ ] **Step 5: Write `LedgerTable.tsx`**

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { crm } from "@rgs/shared";
import { LEDGER_COLUMNS, LEDGER_ROW_HEIGHT } from "./columns";

interface LedgerTableProps {
  rows: crm.LedgerRow[];
  partnerNamesById: Record<string, string>;
}

export function LedgerTable({ rows, partnerNamesById }: LedgerTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => LEDGER_ROW_HEIGHT,
    // Enough rows above and below the window that a fast scroll does not show
    // blank bands, and few enough that the DOM stays small.
    overscan: 12,
  });

  const gridTemplateColumns = LEDGER_COLUMNS.map((column) => `${column.width}px`).join(" ");

  return (
    <div className="crm-root flex h-full flex-col border border-crm-rule-box rounded-crm-card overflow-hidden">
      <div
        data-testid="ledger-header"
        className="sticky top-0 z-20 grid bg-crm-surface text-crm-steel text-[12px] uppercase tracking-wide"
        style={{ gridTemplateColumns, height: LEDGER_ROW_HEIGHT }}
      >
        {LEDGER_COLUMNS.map((column) => (
          <div
            key={column.key}
            data-column={column.key}
            className={`flex items-center px-2 ${column.sticky ? "sticky left-0 z-30 bg-crm-surface" : ""}`}
          >
            {column.header}
          </div>
        ))}
      </div>

      <div data-testid="ledger-scroll" ref={scrollContainerRef} className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="p-6 text-crm-steel">No cases match these filters.</p>
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div
                  key={row.caseId}
                  data-testid="ledger-row"
                  data-case-id={row.caseId}
                  className="absolute left-0 grid w-full border-b border-crm-rule-row bg-crm-canvas hover:bg-crm-surface"
                  style={{
                    gridTemplateColumns,
                    height: LEDGER_ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {LEDGER_COLUMNS.map((column) => (
                    <div
                      key={column.key}
                      data-column={column.key}
                      className={`flex items-center gap-1.5 px-2 truncate ${
                        column.sticky ? "sticky left-0 z-10 bg-inherit font-medium" : ""
                      }`}
                    >
                      {column.render(row, partnerNamesById[row.partnerId] ?? row.partnerId)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write `LedgerPage.tsx` and `CrmLayout.tsx`, and mount the routes**

`CrmLayout.tsx` imports `./theme.css`, renders the existing `AdminShell`'s header area or its own slim header, and lays out `[main | agent panel]` as a two-column grid with a draggable splitter (the panel itself arrives in Task 15; until then the right column renders a placeholder with the trust indicator). `LedgerPage.tsx` reads `useLedgerRows(selectedStatuses, selectedPartnerId)` and `usePartners()`, builds `partnerNamesById`, renders the filter bar and `<LedgerTable>`, and — when `load.truncated` or `load.unreadableCaseIds.length > 0` — renders a visible banner saying exactly how many rows are missing and why. A silent partial ledger is the one thing this screen must never be.

In `main.tsx`, beside the existing routes:

```tsx
            <Route
              path="/crm"
              element={
                <RequireAuth>
                  <LedgerPage />
                </RequireAuth>
              }
            />
            <Route
              path="/crm/cases/:caseId"
              element={
                <RequireAuth>
                  <CasePage />
                </RequireAuth>
              }
            />
```

and add `{ label: "CRM", to: "/crm" }` to `NAV_LINKS` in `AdminShell.tsx`.

- [ ] **Step 7: Run, prove the trap test can fail, commit**

Run: `pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck`

Then delete the `offsetHeight` shim from `test/setup.ts`. **The row tests must fail with the helper's "virtualizer mounted no ledger rows" message, not pass on an empty query.** That is the proof this plan's answer to spec §10's first trap actually works. Restore it.

```bash
git add apps/admin/src/crm apps/admin/src/main.tsx apps/admin/src/components/AdminShell.tsx apps/admin/test/crm
git commit -m "feat(crm-ui): the virtualized Ledger table"
```

---

### Task 11: Grid keyboard and selection

**Files:**
- Create: `apps/admin/src/crm/ledger/useGridKeyboard.ts`
- Modify: `apps/admin/src/crm/ledger/LedgerTable.tsx`
- Test: `apps/admin/test/crm/useGridKeyboard.test.ts`, `apps/admin/test/crm/LedgerKeyboard.test.tsx`

**Interfaces:**
- Consumes: `LEDGER_COLUMNS` (Task 10).
- Produces:

```ts
export interface GridPosition { rowIndex: number; columnIndex: number }
export interface GridState {
  focus: GridPosition;
  /** Row indexes, in selection order. Space toggles; Shift extends. */
  selectedRowIndexes: number[];
  /** The row whose applicants are disclosed, if any. */
  expandedRowIndexes: number[];
  editing: GridPosition | undefined;
}
export type GridAction =
  | { kind: "move"; direction: "up" | "down" | "left" | "right" }
  | { kind: "beginEdit" }
  | { kind: "cancelEdit" }
  | { kind: "commitAndStay" }
  | { kind: "toggleSelection" }
  | { kind: "extendSelection"; direction: "up" | "down" }
  | { kind: "clickSelect"; rowIndex: number; withShift: boolean };

export function gridReducer(state: GridState, action: GridAction, bounds: { rowCount: number; columnCount: number }): GridState;
export function useGridKeyboard(bounds): { state: GridState; onKeyDown: (event: KeyboardEvent) => void; dispatch: (action: GridAction) => void };
```

**The keymap is fixed and never adaptive**, per spec §4 and the AX Handbook's "generative within guardrails": navigation and the grid are used hundreds of times a month and muscle memory is the point. Content and secondary affordances may adapt; this may not.

| Key | Action |
|---|---|
| `↑` `↓` `←` `→` | Move the focused cell |
| `Enter` | Begin editing the focused cell |
| `Esc` | Cancel the edit, restore the previous value |
| `Cmd/Ctrl+Enter` | Commit and stay |
| `Space` | Toggle row selection |
| `Shift+Click`, `Shift+↑↓` | Extend selection |
| `→` on a collapsed parent | Expand applicants |
| `←` on an expanded parent | Collapse |

**Why a pure reducer with its own test file.** Every one of those rows is a behaviour a desk agent will notice the day it is wrong, and driving all of them through rendered DOM makes for slow, flaky tests that mostly exercise Testing Library. The reducer is tested directly, key by key; the component test proves the reducer is actually wired to `keydown` and that focus lands on a real mounted cell.

**The one rule that needs stating:** `→` is overloaded — it expands a collapsed parent when the focus is on the REF column, and moves right everywhere else. Resolve it in the reducer, not in the component, and test both branches.

- [ ] **Step 1: Write the failing reducer test**

```ts
import { describe, expect, it } from "vitest";
import { gridReducer, type GridState } from "../../src/crm/ledger/useGridKeyboard";

const bounds = { rowCount: 10, columnCount: 10 };
const initialState: GridState = {
  focus: { rowIndex: 0, columnIndex: 0 },
  selectedRowIndexes: [],
  expandedRowIndexes: [],
  editing: undefined,
};

describe("gridReducer", () => {
  it("moves the focus and stops at the edges rather than wrapping", () => {
    const movedDown = gridReducer(initialState, { kind: "move", direction: "down" }, bounds);
    expect(movedDown.focus).toEqual({ rowIndex: 1, columnIndex: 0 });
    // Wrapping would move a desk agent from the last row to the first without
    // them noticing which case they are now editing.
    expect(gridReducer(initialState, { kind: "move", direction: "up" }, bounds).focus).toEqual({
      rowIndex: 0,
      columnIndex: 0,
    });
    const atLastRow = { ...initialState, focus: { rowIndex: 9, columnIndex: 0 } };
    expect(gridReducer(atLastRow, { kind: "move", direction: "down" }, bounds).focus.rowIndex).toBe(9);
  });

  it("expands a collapsed parent on right-arrow from the REF column, instead of moving", () => {
    const expanded = gridReducer(initialState, { kind: "move", direction: "right" }, bounds);
    expect(expanded.expandedRowIndexes).toEqual([0]);
    expect(expanded.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
  });

  it("moves right on right-arrow once the row is already expanded", () => {
    const alreadyExpanded = { ...initialState, expandedRowIndexes: [0] };
    const moved = gridReducer(alreadyExpanded, { kind: "move", direction: "right" }, bounds);
    expect(moved.focus).toEqual({ rowIndex: 0, columnIndex: 1 });
  });

  it("collapses on left-arrow from the REF column of an expanded row", () => {
    const alreadyExpanded = { ...initialState, expandedRowIndexes: [0] };
    const collapsed = gridReducer(alreadyExpanded, { kind: "move", direction: "left" }, bounds);
    expect(collapsed.expandedRowIndexes).toEqual([]);
  });

  it("moves right from a non-REF column without touching expansion", () => {
    const inMiddle = { ...initialState, focus: { rowIndex: 0, columnIndex: 4 } };
    const moved = gridReducer(inMiddle, { kind: "move", direction: "right" }, bounds);
    expect(moved.focus.columnIndex).toBe(5);
    expect(moved.expandedRowIndexes).toEqual([]);
  });

  it("toggles selection with Space and extends it with Shift+arrow", () => {
    const selected = gridReducer(initialState, { kind: "toggleSelection" }, bounds);
    expect(selected.selectedRowIndexes).toEqual([0]);
    expect(gridReducer(selected, { kind: "toggleSelection" }, bounds).selectedRowIndexes).toEqual([]);

    const extended = gridReducer(selected, { kind: "extendSelection", direction: "down" }, bounds);
    expect(extended.selectedRowIndexes).toEqual([0, 1]);
    expect(extended.focus.rowIndex).toBe(1);
  });

  it("selects a contiguous range on shift-click", () => {
    const anchored = gridReducer(initialState, { kind: "toggleSelection" }, bounds);
    const ranged = gridReducer(anchored, { kind: "clickSelect", rowIndex: 4, withShift: true }, bounds);
    expect(ranged.selectedRowIndexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("begins and cancels an edit without moving the focus", () => {
    const editing = gridReducer(initialState, { kind: "beginEdit" }, bounds);
    expect(editing.editing).toEqual({ rowIndex: 0, columnIndex: 0 });
    const cancelled = gridReducer(editing, { kind: "cancelEdit" }, bounds);
    expect(cancelled.editing).toBeUndefined();
    expect(cancelled.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
  });

  it("ignores a move while a cell is being edited, so arrow keys reach the input", () => {
    const editing = gridReducer(initialState, { kind: "beginEdit" }, bounds);
    const stillEditing = gridReducer(editing, { kind: "move", direction: "down" }, bounds);
    expect(stillEditing.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
    expect(stillEditing.editing).toEqual({ rowIndex: 0, columnIndex: 0 });
  });
});
```

- [ ] **Step 2: Write the failing wiring test**

`apps/admin/test/crm/LedgerKeyboard.test.tsx` renders the table with 50 rows, focuses the grid, and drives real keys with `userEvent.keyboard`. Every assertion about which cell is focused is made through `mountedCell(container, caseId, columnKey)` and `toHaveFocus()` / `aria-selected`, never against a row query that could be trivially empty:

```tsx
it("moves the focused cell with the arrow keys", async () => {
  const user = userEvent.setup();
  const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
  await user.click(mountedCell(container, "case_0000", "caseRef"));

  await user.keyboard("{ArrowDown}");

  expect(mountedCell(container, "case_0001", "caseRef")).toHaveFocus();
});

it("toggles row selection with Space and shows it", async () => {
  const user = userEvent.setup();
  const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
  await user.click(mountedCell(container, "case_0000", "caseRef"));

  await user.keyboard(" ");

  expect(
    container.querySelector("[data-testid='ledger-row'][data-case-id='case_0000']"),
  ).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 3: Run both and watch them fail.**

- [ ] **Step 4: Implement `useGridKeyboard.ts` as a pure reducer plus a thin hook.** The hook owns `useReducer`, maps a `KeyboardEvent` to a `GridAction` (and calls `preventDefault()` for every key it consumes — `Space` scrolling the page under a desk agent is the bug this prevents), and returns `state`, `onKeyDown`, `dispatch`. `LedgerTable` puts `role="grid"`, `tabIndex={0}` and `onKeyDown` on the scroll container, `role="row"` + `aria-selected` on each row, `role="gridcell"` + `tabIndex={isFocused ? 0 : -1}` on each cell, and a `useEffect` that calls `.focus()` on the focused cell when it is mounted.

**Focus and virtualization together:** moving the focus to a row outside the mounted window must first scroll it in. `rowVirtualizer.scrollToIndex(rowIndex)` before the focus effect runs; without it, `↓` held down walks the focus off the mounted window and focus silently falls back to `document.body`. Test it: press `↓` 40 times from row 0 and assert `mountedCell(container, "case_0040", "caseRef")` has focus.

- [ ] **Step 5: Run, prove it can fail, commit**

Delete the `preventDefault()` on `ArrowDown` and confirm nothing breaks (it is about page scroll, not the reducer) — then delete the `scrollToIndex` call and confirm the 40-press test goes red. Restore.

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck
git add apps/admin/src/crm/ledger apps/admin/test/crm
git commit -m "feat(crm-ui): fixed grid keymap and row selection"
```

---

### Task 12: Inline editing — optimistic, reversible, and honest about a conflict

**Files:**
- Create: `apps/admin/src/crm/ledger/EditableCell.tsx`
- Create: `apps/admin/src/crm/UndoToast.tsx`
- Create: `apps/admin/src/crm/api/mutations.ts`
- Modify: `apps/admin/src/crm/ledger/LedgerTable.tsx`
- Test: `apps/admin/test/crm/EditableCell.test.tsx`, `apps/admin/test/crm/mutations.test.tsx`

**Interfaces:**
- Consumes: `crmClient.setCaseStatus`/`setBillingStatus`/`updateCaseDetails` (Task 9), `crmQueryKeys` (Task 9), `gridReducer` (Task 11).
- Produces:
  - `useLedgerEdit()` → `{ commitEdit(edit: LedgerEdit): Promise<void>, pendingConflict: LedgerConflict | undefined, resolveConflict(choice: "keepMine" | "keepTheirs"): void }`
  - `interface LedgerEdit { caseId: string; column: "caseStatus" | "billingStatus" | "appointmentDate" | "visaType"; previousValue: string | undefined; nextValue: string }`
  - `<UndoToast>` with `showUndo(message: string, undo: () => Promise<void>)`

**The four rules, from spec §4, §8 and §9, each of which a test pins:**

1. **Direct human edits are NOT staged behind the approval gate.** They go straight to the REST routes. The gate governs what the *agent* writes; making a human approve their own click is ceremony without safety.
2. **Optimistic, with rollback.** `onMutate` cancels in-flight ledger queries, snapshots the cached rows, writes the new value into the cache; `onError` restores the snapshot; `onSettled` invalidates. TanStack Query's standard shape, and the snapshot is the row array, not the row — restoring one row into a list that has since been refetched is how a rollback resurrects a deleted case.
3. **An undo toast on every committed edit, and it is not optional.** A desk agent who edited the wrong row of 7,156 must be able to take it back without knowing what a case id is. The toast's undo is a real inverse write through the same mutation, so it is itself optimistic and itself rollback-safe.
4. **A `409` shows both values and asks. It never picks.** `changeCaseStatus` and `changeBillingStatus` answer 409 `CONFLICT` when the transition is illegal for the *stored* state — which is exactly the case where the row changed underneath. Showing "your value" and "the stored value" side by side, with a button for each, is the spec's rule; auto-retrying with the stored value would apply an edit the agent never made.

**Undo has a limit, and it is stated rather than hidden:** an undo of a status change is a transition back, and the state machines do not allow every reverse move — `DECIDED → SUBMITTED` is legal (an outcome went back to `SENT_BACK`), `CLOSED → anything` is not. When the inverse transition is illegal the toast says so instead of offering an Undo that will 409: *"This change cannot be undone from here — the case is now CLOSED."* Check it with `crm.canTransitionCaseStatus(nextValue, previousValue)` before rendering the button.

- [ ] **Step 1: Write the failing mutation tests**

```tsx
describe("useLedgerEdit", () => {
  it("writes the new value into the cache before the request resolves", async () => {
    // The whole point of optimistic: the cell must not wait for a round trip.
    const { queryClient, resolveRequest } = renderLedgerWithDeferredApi();
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });

    expect(cachedRow(queryClient, "case_1").caseStatus).toBe("IN_PROGRESS");
    resolveRequest({ caseStatus: "IN_PROGRESS" });
  });

  it("puts the old value back when the request fails", async () => {
    const { queryClient, rejectRequest } = renderLedgerWithDeferredApi();
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    rejectRequest(new ApiRequestError(500, "INTERNAL", "Something went wrong"));

    await waitFor(() => expect(cachedRow(queryClient, "case_1").caseStatus).toBe("NEW"));
  });

  it("restores the whole row list, not one row, so a rollback cannot resurrect a case", async () => {
    const { queryClient, rejectRequest } = renderLedgerWithDeferredApi({ rowCount: 3 });
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    rejectRequest(new ApiRequestError(500, "INTERNAL", "boom"));

    await waitFor(() => expect(cachedRows(queryClient)).toHaveLength(3));
  });

  it("shows both values on a 409 and writes nothing until the human picks", async () => {
    const { rejectRequest, requestLog } = renderLedgerWithDeferredApi();
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "CLOSED" });
    rejectRequest(new ApiRequestError(409, "CONFLICT", "Cannot move a case from SUBMITTED to CLOSED"));

    await screen.findByText(/changed underneath/i);
    expect(screen.getByText(/Cannot move a case from SUBMITTED to CLOSED/)).toBeInTheDocument();
    // The second half of the claim, asserted separately against the request
    // log rather than inferred from the dialog being on screen. Spec §10's
    // second named trap.
    expect(requestLog.filter((entry) => entry.method === "PUT")).toHaveLength(1);
  });

  it("offers undo, and the undo is a real inverse write", async () => {
    const { resolveRequest, requestLog } = renderLedgerWithDeferredApi();
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "NEW", nextValue: "IN_PROGRESS" });
    resolveRequest({ caseStatus: "IN_PROGRESS" });

    await userEvent.click(await screen.findByRole("button", { name: /undo/i }));

    await waitFor(() => {
      const writes = requestLog.filter((entry) => entry.method === "PUT");
      expect(writes).toHaveLength(2);
      expect(writes[1]!.body).toEqual({ toStatus: "NEW" });
    });
  });

  it("says an undo is impossible rather than offering one that will 409", async () => {
    const { resolveRequest } = renderLedgerWithDeferredApi();
    await commitEdit({ caseId: "case_1", column: "caseStatus", previousValue: "SUBMITTED", nextValue: "CLOSED" });
    resolveRequest({ caseStatus: "CLOSED" });

    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
  });
});
```

Write `renderLedgerWithDeferredApi` in the test file: a real `QueryClient` (with `retry: false`), a stubbed `fetch` that records `{ method, url, body }` into `requestLog` and hands back a promise the test resolves or rejects by hand. Deferring the response is what makes "before the request resolves" a real assertion rather than a race.

- [ ] **Step 2: Write the failing cell test**

```tsx
describe("EditableCell", () => {
  it("opens on Enter and closes on Escape with the old value intact", async () => { /* ... */ });
  it("commits on blur", async () => { /* ... */ });
  it("commits and stays open on Cmd+Enter", async () => { /* ... */ });
  it("offers only the transitions the state machine allows from here", async () => {
    // A dropdown listing every CASE_STATUS invites a desk agent to pick one
    // that 409s. crm.canTransitionCaseStatus is the same rule the server
    // enforces, so the list and the server agree by construction.
    render(<EditableCell column="caseStatus" row={{ ...row, caseStatus: "DECIDED" }} onCommit={noop} isEditing />);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Closed");
    expect(options).not.toContain("New");
  });
  it("renders a date input for appointmentDate and a select for the two axes", async () => { /* ... */ });
});
```

- [ ] **Step 3: Run and watch them fail.**

- [ ] **Step 4: Implement.** `mutations.ts` holds one `useMutation` per axis, each with the `onMutate`/`onError`/`onSettled` triple over `crmQueryKeys.ledger(...)` **and** `crmQueryKeys.case(caseId)` — the Case screen and the Ledger show the same case and must not disagree after an edit. `EditableCell` renders a `<select>` of allowed transitions for the two axis columns (built from `crm.canTransitionCaseStatus` / `crm.canTransitionBilling`), a `<input type="date">` for `appointmentDate`, and a `<select>` of `VISA_TYPES` for `visaType` (disabled with a title when `caseType !== "VISA"`, because `CrmCaseSchema` refuses a `visaType` on a non-VISA case and the 400 would otherwise arrive as a mystery).

`UndoToast` is a context provider mounted in `CrmLayout`, holding at most three toasts, each auto-dismissing after 10 seconds — long enough to notice, short enough not to accumulate.

- [ ] **Step 5: Run, prove the tests can fail, commit**

Delete the `onError` rollback and confirm two tests go red. Delete the `canTransitionCaseStatus` guard on the undo button and confirm "says an undo is impossible" goes red. Restore both.

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck
git add apps/admin/src/crm apps/admin/test/crm
git commit -m "feat(crm-ui): optimistic inline editing with undo and a conflict prompt"
```

---

### Task 13: Applicant sub-rows and saved views

**Files:**
- Create: `apps/admin/src/crm/ledger/ApplicantSubRows.tsx`
- Create: `apps/admin/src/crm/ledger/views.ts`
- Create: `apps/admin/src/crm/ledger/ViewChips.tsx`
- Create: `apps/admin/src/crm/ledger/filters.ts`
- Modify: `apps/admin/src/crm/ledger/LedgerTable.tsx`, `LedgerPage.tsx`
- Test: `apps/admin/test/crm/ApplicantSubRows.test.tsx`, `views.test.ts`, `filters.test.ts`

**Interfaces:**
- Consumes: `useCase` (Task 9), `gridReducer`'s `expandedRowIndexes` (Task 11), `crm.CaseApplicant`.
- Produces:
  - `<ApplicantSubRows caseId={...} />` rendering traveller name · `passportNumber` · `custody` · `outcome` · `courierMode` + `trackingNumber`.
  - `interface LedgerView { viewId: string; name: string; filters: LedgerFilters; sort: LedgerSort }`
  - `loadViews(userEmail: string): LedgerView[]`, `saveView(userEmail, view)`, `deleteView(userEmail, viewId)`
  - `interface LedgerFilters { statuses: crm.CaseStatus[]; partnerId?: string; destinationCountry?: string; caseType?: crm.CaseType; search?: string }`
  - `applyFilters(rows, filters): crm.LedgerRow[]`, `applySort(rows, sort): crm.LedgerRow[]`

**Where each filter runs, fixed by spec §2.1 and not re-litigated here:** `statuses` and `partnerId` go to the server (an index answers them). `destinationCountry`, `caseType` and the text search over `caseRef`/traveller name run client-side over the loaded rows. Anything else server-side would be a table scan.

**The text search has a limit that must be visible.** A Ledger row carries no traveller name — the columns are case-level, and the name lives on applicant records the projection deliberately does not read. So the search box matches `caseRef` and partner name over all rows, and matches traveller name **only within cases whose applicants have been loaded** (by expanding, or by having been opened). The placeholder says so: *"Search REF or partner"*. Claiming to search names it cannot see is worse than not offering it.

**Expanding fetches.** `applicantSummary` is a roll-up; the applicant records are not on the Ledger row. `<ApplicantSubRows>` calls `useCase(caseId)` on mount, shows a one-line skeleton while it loads, and renders an error line — never an empty list — if the fetch fails. An empty applicant list is indistinguishable from a case whose applicants failed to load, and `CrmCaseSchema` requires at least one, so "no applicants" is always a bug being hidden.

**Views are per-user and live in `localStorage`** under `rgs.crm.views.<userEmail>`. There is no server route for user views: `CrmUserPrefs.defaultFilters` exists in the schema but nothing in production writes prefs (`agentApi.ts` only bumps a counter), and adding a prefs write route is a backend decision outside this slice. The storage key is namespaced by email so two admins sharing a browser do not inherit each other's views. Reads are wrapped in try/catch and fall back to the built-in views — a `localStorage` that throws (private window, cleared site data) must not take the Ledger down.

**Three built-in views ship, and cannot be deleted:** *Live work* (`LIVE_CASE_STATUSES`, sorted by `receivedDate` desc), *Awaiting payment* (all statuses, `billingStatus` in `BILL_SENT`/`PART_PAID`), *Everything* (all nine statuses). They are what a desk agent lands on before anyone has saved anything.

- [ ] **Step 1: Write the failing tests**

```ts
describe("applyFilters", () => {
  it("matches caseRef case-insensitively and ignores surrounding space", () => { /* "  rgs-10 " matches RGS-1001 */ });
  it("filters by destination country and case type together", () => { /* both applied, AND not OR */ });
  it("returns every row for an empty filter set rather than none", () => { /* the empty-filter trap */ });
});

describe("views", () => {
  it("round-trips a saved view", () => { /* save then load */ });
  it("keeps two users' views apart", () => { /* two emails, two key spaces */ });
  it("falls back to the built-in views when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("access denied");
    });
    expect(loadViews("ops@rgs.test").map((view) => view.name)).toEqual([
      "Live work",
      "Awaiting payment",
      "Everything",
    ]);
  });
  it("refuses to delete a built-in view", () => { /* deleteView on a built-in id leaves it */ });
});

describe("ApplicantSubRows", () => {
  it("lists each applicant's name, passport, custody and outcome", async () => { /* ... */ });
  it("shows a loading line, not an empty list, while the case is fetching", async () => { /* ... */ });
  it("says the applicants could not be loaded when the fetch fails", async () => {
    // Never an empty list: CrmCaseSchema requires at least one applicant, so
    // "no applicants" can only ever be a failure being hidden.
  });
  it("renders courier mode and tracking number together when both are present", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run and watch them fail. Step 3: Implement. Step 4: Run and watch them pass.**

- [ ] **Step 5: Wire the sub-rows into the virtualizer**

This is the part that goes wrong quietly: an expanded row is taller than 32px, so the virtualizer's `estimateSize` must become a function of the row's expanded state and `rowVirtualizer.measure()` must run when a row expands. Get this wrong and rows overlap. Pin it:

```tsx
it("keeps rows from overlapping when one is expanded", async () => {
  const { container } = renderLedger(<LedgerTable rows={buildRows(50)} partnerNamesById={{}} />);
  await userEvent.click(mountedCell(container, "case_0000", "caseRef"));
  await userEvent.keyboard("{ArrowRight}");

  const rowTops = mountedCaseIds(container).map((caseId) =>
    Number(
      /translateY\((\d+)px\)/
        .exec(
          (container.querySelector(`[data-case-id='${caseId}']`) as HTMLElement).style.transform,
        )?.[1] ?? 0,
    ),
  );
  // Strictly increasing: two rows sharing a translateY is the overlap bug.
  expect(rowTops).toEqual([...rowTops].sort((left, right) => left - right));
  expect(new Set(rowTops).size).toBe(rowTops.length);
});
```

- [ ] **Step 6: Commit**

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck
git add apps/admin/src/crm apps/admin/test/crm
git commit -m "feat(crm-ui): applicant sub-rows, client-side filters and saved views"
```

---

### Task 14: The Case screen

**Files:**
- Create: `apps/admin/src/crm/case/CasePage.tsx`
- Create: `apps/admin/src/crm/case/Timeline.tsx`
- Create: `apps/admin/src/crm/case/eventCopy.ts`
- Test: `apps/admin/test/crm/CasePage.test.tsx`, `apps/admin/test/crm/Timeline.test.tsx`

**Interfaces:**
- Consumes: `useCase`, `useCaseEvents` (Task 9); the mutation hooks (Task 12); `AxisChip`, label maps (Task 8).
- Produces: `<CasePage>` at `/crm/cases/:caseId`, and `describeCrmEvent(event: CrmEventView): { title: string; detail: string; isAutoApplied: boolean }`.

**Layout, from spec §5:** shared case fields once at the top (REF, partner, country, type + visa type, the four dates, case status, billing status); applicants below as a small table carrying `custody` and `outcome`, each editable through the per-applicant routes; line items with `totalInr`; notes; and the timeline.

**The timeline is the audit surface and this is the one rule that must not be flattened.** `PROPOSAL_APPROVED` events carry `meta.autoApplied`. The backend went to real trouble to keep "a human approved this" and "the trust ladder applied this" distinguishable — `applyApprovedChange` takes the flag explicitly and the HTTP approve route leaves it at `false` precisely so the two cannot be confused. An interface that renders them identically throws that away. A human-approved entry reads *"Approved by ops@rgs.test"*; an auto-applied one reads *"Applied automatically (trust level 2) — ops@rgs.test was the actor"* and carries a distinct marker.

**A second honesty rule for the same surface:** `meta` values are scalars only, and `CASE_UPDATED` carries `changedFields` as a comma-joined string (`cases.ts:210`). Render it as the list it is — *"Changed appointment date and visa type"* — rather than printing the raw `"appointmentDate,visaType"`.

- [ ] **Step 1: Write the failing timeline test**

```tsx
describe("Timeline", () => {
  it("tells a human-approved change from an auto-applied one", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "PROPOSAL_APPROVED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { autoApplied: false, toolName: "set_custody" }, createdAt: "2026-03-04T10:00:00.000Z" },
          { eventId: "e2", eventType: "PROPOSAL_APPROVED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { autoApplied: true, toolName: "set_custody" }, createdAt: "2026-03-04T11:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/Approved by ops@rgs.test/)).toBeInTheDocument();
    expect(screen.getByText(/Applied automatically/)).toBeInTheDocument();
    // Both halves: the words differ AND the entries are visually distinct.
    const [humanEntry, autoEntry] = screen.getAllByTestId("timeline-entry");
    expect(humanEntry!.className).not.toBe(autoEntry!.className);
  });

  it("reads a comma-joined changedFields list as a sentence", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "CASE_UPDATED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { changedFields: "appointmentDate,visaType" }, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/appointment date and visa type/i)).toBeInTheDocument();
    expect(screen.queryByText("appointmentDate,visaType")).not.toBeInTheDocument();
  });

  it("names an event type it does not recognise instead of rendering a blank row", () => {
    // CrmEventType is widened by backend plans; an unknown type must degrade
    // to something an operator can report, never to an empty line.
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "WATCHDOG_FIRED" as never, caseId: "case_1", actorEmail: "system", meta: {}, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText(/WATCHDOG_FIRED/)).toBeInTheDocument();
  });

  it("orders oldest first, the order the API returns", () => { /* ... */ });
});
```

- [ ] **Step 2: Write the failing case-screen test**

```tsx
describe("CasePage", () => {
  it("shows the shared case fields once, not repeated down the applicants", async () => { /* REF appears exactly once */ });
  it("lists line items with their quantity, unit price and the case total", async () => {
    // LineItem.amountInr is a UNIT price and totalInr is the sum of
    // amountInr × quantity across items (schemas.ts). Rendering amountInr as
    // a line total is wrong for any quantity above one.
  });
  it("edits one applicant's custody without touching its sibling", async () => { /* asserts the request path carries the right applicantRef */ });
  it("shows a case that could not be loaded as an error, not as an empty case", async () => { /* ... */ });
});
```

- [ ] **Step 3: Run, implement, run, prove they fail, commit**

Delete the `autoApplied` branch in `eventCopy.ts` and confirm the first timeline test goes red. Restore.

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck
git add apps/admin/src/crm/case apps/admin/test/crm
git commit -m "feat(crm-ui): the Case screen and its audit timeline"
```

---

### Task 15: The agent panel

**Files:**
- Create: `apps/admin/src/crm/agent/transcript.ts`
- Create: `apps/admin/src/crm/agent/AgentPanel.tsx`
- Create: `apps/admin/src/crm/agent/ProposalCard.tsx`
- Create: `apps/admin/src/crm/agent/MemoryCitations.tsx`
- Modify: `apps/admin/src/crm/CrmLayout.tsx` (the resizable right column)
- Modify: `services/api/src/http/agentApi.ts` (export `RunTurnBody`)
- Modify: `apps/admin/package.json` (add `"@rgs/api": "workspace:*"` as a **devDependency**)
- Test: `apps/admin/test/crm/transcript.test.ts`, `AgentPanel.test.tsx`, `ProposalCard.test.tsx`

**Interfaces:**
- Consumes: `crmClient.runAgentTurn`, `listProposals`, `approveProposal`, `discardProposal`, `listMemories`, `forgetMemory` (Task 9).
- Produces:

```ts
/** Mirrors AgentMessage (services/api/src/agent/providers/types.ts) exactly. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolCalls?: { toolCallId: string; toolName: string; input: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
}
export function appendUserTurn(transcript: TranscriptMessage[], userMessage: string): TranscriptMessage[];
export function appendTurnResult(transcript: TranscriptMessage[], userMessage: string, result: AgentTurnResponse): TranscriptMessage[];
export function transcriptCost(transcript: TranscriptMessage[]): number;
export function trimTranscriptToBudget(transcript: TranscriptMessage[]): TranscriptMessage[];
```

**This is the task spec §8 singles out, and the reason is a defect that already happened.** `POST .../agent/turn` validates the replayed conversation strictly, and the rules are not suggestions:

- an assistant turn that made calls **must** carry them in `toolCalls`;
- a `tool_result` **must** name a `toolCallId` that the **immediately preceding** assistant message carries (a run of `tool_result`s all answer the same assistant turn; any other message resets the set);
- only an assistant message may carry `toolCalls`;
- an assistant message must carry text, tool calls, or both — never neither;
- a `tool_result` must carry `toolName` (the Gemini adapter attributes a result by name, not by id);
- ids cap at 256 characters;
- the whole replay caps at **100,000** characters, counted per message as `content.length + Σ(toolCallId + toolName + JSON.stringify(input)) + (toolCallId?.length ?? 0)`;
- at most **200** messages, and at most **32** tool calls on one message.

A client that drops the assistant turn reproduces branch-review defect **C1** exactly — the one that made the agent unusable against both real providers — but from the client side, where no backend test covers it.

**What the route's answer does and does not give the panel.** `AgentTurnResult` carries `reply`, `proposals`, `appliedChanges`, `toolCallsMade` and `stoppedAtIterationCap` — but `toolCallsMade` is `{ toolName, kind }[]` with **no call ids and no results**. So the panel **cannot** reconstruct the loop's internal `assistant → tool_result` pairs, and must not try: a fabricated `toolCallId` is a 400 on the next turn at best and a provider error at worst. The transcript the panel keeps is therefore the **user/assistant text turns only** — `{ role: "user", content }` and `{ role: "assistant", content: result.reply }` — which satisfies every rule above by construction, because it contains no tool calls to pair. `appendTurnResult` is where that decision lives, and its tests are what stop someone "improving" it later by synthesising tool messages.

**`stoppedAtIterationCap` must be rendered.** Both loop exits return the last completion's text, and for a tool-calling turn that is `""` — so without this flag a user who hit the cap gets a blank reply indistinguishable from a model with nothing to say. The panel shows *"The agent stopped after 8 rounds of tool calls and may not have finished."*

- [ ] **Step 1: Export the route's own schema and wire the dev dependency**

In `services/api/src/http/agentApi.ts`, change `const RunTurnBody = …` to `export const RunTurnBody = …` and leave everything else alone. Then:

```bash
pnpm --filter @rgs/admin add -D @rgs/api@workspace:*
```

A **dev** dependency: the admin bundle must not pull the API in. It exists so the panel's transcript is validated against the route's real schema instead of a copy of its rules, which would pass while the route refused the request.

- [ ] **Step 2: Write the failing transcript test**

`apps/admin/test/crm/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RunTurnBody } from "@rgs/api/src/http/agentApi";
import {
  appendTurnResult,
  appendUserTurn,
  transcriptCost,
  trimTranscriptToBudget,
  type TranscriptMessage,
} from "../../src/crm/agent/transcript";

function buildTurnResult(reply: string) {
  return {
    reply,
    proposals: [],
    appliedChanges: [],
    toolCallsMade: [{ toolName: "get_case", kind: "read" as const }],
    stoppedAtIterationCap: false,
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
  };
}

/** The route's own validator, not a restatement of its rules. */
function assertRouteAccepts(conversation: TranscriptMessage[], userMessage = "and then?"): void {
  expect(() => RunTurnBody.parse({ userMessage, conversation })).not.toThrow();
}

describe("the panel's transcript satisfies the turn route", () => {
  it("is accepted after one exchange", () => {
    let transcript: TranscriptMessage[] = [];
    transcript = appendTurnResult(transcript, "how many cases are open?", buildTurnResult("412 are open."));

    assertRouteAccepts(transcript);
    expect(transcript).toEqual([
      { role: "user", content: "how many cases are open?" },
      { role: "assistant", content: "412 are open." },
    ]);
  });

  it("is accepted after five exchanges, including turns that called tools", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 5; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, `question ${exchangeIndex}`, buildTurnResult(`answer ${exchangeIndex}`));
    }

    assertRouteAccepts(transcript);
  });

  it("never synthesises a tool_result, because it has no call id to pair one with", () => {
    // toolCallsMade carries { toolName, kind } and NOTHING else -- no call id,
    // no result. A panel that invented a toolCallId to look complete
    // reproduces branch-review defect C1 from the client side: a tool_result
    // answering a call that was never transmitted, which both providers
    // refuse. This is the test that stops that "improvement".
    const transcript = appendTurnResult([], "do something", buildTurnResult("done"));

    expect(transcript.some((message) => message.role === "tool_result")).toBe(false);
    expect(transcript.some((message) => message.toolCalls !== undefined)).toBe(false);
  });

  it("never appends an assistant turn with neither text nor calls", () => {
    // An iteration-capped turn returns reply: "". An empty assistant message
    // maps to an empty content block, which both vendors refuse -- and the
    // route refuses it first, as a 400 naming `conversation`.
    const transcript = appendTurnResult([], "do something", buildTurnResult(""));

    expect(transcript.filter((message) => message.role === "assistant")).toHaveLength(0);
    assertRouteAccepts(transcript);
  });

  it("keeps the replay inside the route's 100,000-character budget", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 60; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, "x".repeat(4_000), buildTurnResult("y".repeat(4_000)));
    }

    const trimmed = trimTranscriptToBudget(transcript);

    expect(transcriptCost(trimmed)).toBeLessThanOrEqual(100_000);
    assertRouteAccepts(trimmed);
    // Trimmed from the OLD end: the recent exchange is the context the next
    // turn needs, and dropping it to keep the greeting is backwards.
    expect(trimmed.at(-1)).toEqual(transcript.at(-1));
  });

  it("keeps the replay inside the 200-message cap", () => {
    let transcript: TranscriptMessage[] = [];
    for (let exchangeIndex = 0; exchangeIndex < 150; exchangeIndex += 1) {
      transcript = appendTurnResult(transcript, "hi", buildTurnResult("hello"));
    }

    const trimmed = trimTranscriptToBudget(transcript);

    expect(trimmed.length).toBeLessThanOrEqual(200);
    assertRouteAccepts(trimmed);
  });

  it("keeps a user turn on screen while its answer is in flight, without sending it twice", () => {
    // appendUserTurn is for rendering. The request sends `userMessage`
    // separately from `conversation`, and a panel that put the pending turn
    // in BOTH would replay it to the model twice.
    const forDisplay = appendUserTurn([], "how many?");
    expect(forDisplay).toHaveLength(1);
    assertRouteAccepts([], "how many?");
  });
});

describe("the transcript survives a real turn through the real route", () => {
  it("is accepted by the router, not just by the schema", async () => {
    // The schema is the contract; the router is where the contract is
    // enforced in production. Driving the panel's transcript through
    // registerAgentRoutes with a scripted provider is what makes this test
    // about the system rather than about a zod object.
    const { router, context } = await buildAgentRouterForTest();
    let transcript: TranscriptMessage[] = [];

    const firstResponse = await dispatch(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "how many cases are open?",
      conversation: transcript,
    });
    expect(firstResponse.statusCode).toBe(200);
    transcript = appendTurnResult(transcript, "how many cases are open?", firstResponse.payload);

    const secondResponse = await dispatch(router, "POST", "/api/v1/admin/crm/agent/turn", {
      userMessage: "and how many are overdue?",
      conversation: transcript,
    });

    expect(secondResponse.statusCode).toBe(200);
  });
});
```

`buildAgentRouterForTest` lives at the bottom of the test file: an `InMemoryTableClient`, a `now` that returns a fixed date, an `llm` stub whose `complete` returns `{ text: "412 are open.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }`, and `registerAgentRoutes(new Router(), context)`. `dispatch` builds the same `APIGatewayProxyEventV2` shape `services/api/test/crm/crmApi.test.ts` already uses, with `authorizer.jwt.claims = { sub: "admin_1", email: "ops@rgs.test" }` — the turn route needs a non-empty email or it answers 403.

- [ ] **Step 3: Run and watch it fail.**

- [ ] **Step 4: Write `transcript.ts`**

```ts
/**
 * The panel's replayed conversation, in exactly the shape
 * POST /api/v1/admin/crm/agent/turn validates (agentApi.ts's AgentMessageBody
 * and RunTurnBody).
 *
 * The shape is deliberately narrow: user text turns and assistant text turns,
 * and nothing else. The route's pairing rules are strict for a reason -- a
 * tool_result whose toolCallId was not on the immediately preceding assistant
 * message is refused, and both real providers refuse the same thing -- and the
 * turn response gives the panel `toolCallsMade: { toolName, kind }[]` with NO
 * call ids and NO results. There is therefore nothing the panel could pair
 * correctly, so it pairs nothing. What the agent did with its tools is shown
 * from `toolCallsMade` as a rendered footnote, never replayed as transcript.
 */
export const MAX_REPLAY_CHARACTERS = 100_000;
export const MAX_REPLAY_MESSAGES = 200;

/** The route's own cost function, mirrored so trimming targets the same number. */
export function transcriptCost(transcript: TranscriptMessage[]): number {
  return transcript.reduce((runningTotal, message) => {
    const toolCallsLength = (message.toolCalls ?? []).reduce(
      (callTotal, toolCall) =>
        callTotal + toolCall.toolCallId.length + toolCall.toolName.length + JSON.stringify(toolCall.input).length,
      0,
    );
    return runningTotal + message.content.length + toolCallsLength + (message.toolCallId?.length ?? 0);
  }, 0);
}

export function appendTurnResult(
  transcript: TranscriptMessage[],
  userMessage: string,
  result: AgentTurnResponse,
): TranscriptMessage[] {
  const withUserTurn: TranscriptMessage[] = [...transcript, { role: "user", content: userMessage }];
  // An assistant turn with neither text nor calls is refused by the route and
  // by both vendors. A capped turn returns reply: "" -- so there is genuinely
  // no assistant turn to record, and recording one would be a 400 on the next
  // message. The cap itself is surfaced in the UI from stoppedAtIterationCap.
  if (result.reply.trim() === "") return trimTranscriptToBudget(withUserTurn);
  return trimTranscriptToBudget([...withUserTurn, { role: "assistant", content: result.reply }]);
}

/**
 * Drops whole exchanges from the OLD end until the replay fits both caps.
 *
 * Whole exchanges, never a half: dropping an assistant turn and keeping the
 * user turn that prompted it leaves the model answering a question whose
 * answer it can no longer see, and dropping a user turn while keeping its
 * answer is worse.
 */
export function trimTranscriptToBudget(transcript: TranscriptMessage[]): TranscriptMessage[] {
  let trimmed = [...transcript];
  while (
    (transcriptCost(trimmed) > MAX_REPLAY_CHARACTERS || trimmed.length > MAX_REPLAY_MESSAGES) &&
    trimmed.length > 1
  ) {
    const dropCount = trimmed[1]?.role === "assistant" ? 2 : 1;
    trimmed = trimmed.slice(dropCount);
  }
  return trimmed;
}
```

- [ ] **Step 5: Write the failing proposal-card tests**

`ProposalCard.tsx` renders the four AX patterns concretely (spec §6):

```tsx
describe("ProposalCard", () => {
  it("plays back the goal and the change before anything is written (Intent Handshake)", () => {
    render(<ProposalCard proposals={[proposalFor("set_custody", [{ field: "custody", from: "WITH_RGS", to: "AT_EMBASSY" }])]} />);
    expect(screen.getByText(/With us/)).toBeInTheDocument();
    expect(screen.getByText(/At embassy/)).toBeInTheDocument();
  });

  it("puts the one purple control in the product on Approve, and nowhere else", () => {
    const { container } = render(<ProposalCard proposals={[proposalFor("set_custody", [])]} />);
    const purpleElements = [...container.querySelectorAll("[class*='crm-primary']")];
    expect(purpleElements).toHaveLength(1);
    expect(purpleElements[0]!.textContent).toMatch(/approve/i);
  });

  it("lets the human edit the proposal before approving it (Generative Momentum)", async () => {
    const approve = vi.fn();
    render(<ProposalCard proposals={[proposalFor("set_custody", [])]} onApprove={approve} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    await userEvent.selectOptions(screen.getByLabelText(/custody/i), "IN_TRANSIT");
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));

    // editedInput, not a second proposal: the route rebuilds its own audit
    // summary from the edit, and an edited approval is deliberately NOT
    // counted as a confirm-without-edit.
    expect(approve).toHaveBeenCalledWith("prop_1", { toCustody: "IN_TRANSIT" });
  });

  it("groups N proposals into one card and approves them with N calls", async () => {
    const approve = vi.fn().mockResolvedValue({});
    render(<ProposalCard proposals={[proposalFor("set_custody", [], "prop_1"), proposalFor("set_custody", [], "prop_2")]} onApprove={approve} />);
    await userEvent.click(screen.getByRole("button", { name: /approve all 2/i }));

    // The backend has no bulk write tool and spec §6 deliberately does not add
    // one: each case keeps its own PROPOSAL_APPROVED event, which is a better
    // audit trail for a business billing real clients than one record covering
    // twelve.
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
  });

  it("reports a partial failure per item, never as success", async () => {
    const approve = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ApiRequestError(409, "CONFLICT", "Cannot move custody from RETURNED to AT_EMBASSY"));
    render(<ProposalCard proposals={[proposalFor("set_custody", [], "prop_1"), proposalFor("set_custody", [], "prop_2")]} onApprove={approve} />);
    await userEvent.click(screen.getByRole("button", { name: /approve all 2/i }));

    expect(await screen.findByText(/1 applied, 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Cannot move custody from RETURNED to AT_EMBASSY/)).toBeInTheDocument();
    // The failed one is still there to retry or discard -- not silently gone.
    expect(screen.getByTestId("proposal-prop_2")).toBeInTheDocument();
  });

  it("offers Discard on every proposal (Escape Hatch)", () => { /* ... */ });
});
```

- [ ] **Step 6: Write the failing panel tests**

```tsx
describe("AgentPanel", () => {
  it("says the trust level and that auto-apply is off, truthfully", () => {
    // Nothing in production writes CrmUserPrefs: trustLevel is 0 and
    // autoApplyOptIn is false for every user, and the panel says exactly that
    // rather than implying a ladder that has been climbed.
    render(<AgentPanel />);
    expect(screen.getByText(/level 0/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-apply is off/i)).toBeInTheDocument();
  });

  it("shows which remembered facts it used, each deletable in place (Memory in Motion)", async () => {
    /* cited memory renders; clicking its × calls DELETE /agent/memories/{key}?scope=… */
  });

  it("says the turn was cut short when the loop hit its cap", () => {
    render(<AgentPanel initialResult={{ ...buildTurnResult(""), stoppedAtIterationCap: true }} />);
    expect(screen.getByText(/stopped after 8 rounds/i)).toBeInTheDocument();
  });

  it("shows what the agent was attempting when a turn fails, not a bare error", async () => {
    /* the failed turn renders the user's message and the tools already called */
  });

  it("is never a modal: the ledger stays interactive while the panel is open", () => {
    /* no role="dialog", no aria-modal, no inert on the main column */
  });

  it("inherits the current selection", () => {
    render(<AgentPanel selectedCaseIds={["case_1", "case_2"]} />);
    expect(screen.getByText(/2 cases selected/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Implement, run, prove they can fail, commit**

Make `appendTurnResult` synthesise a `tool_result` from `toolCallsMade` with a made-up id and confirm **both** the "never synthesises" test and the real-router test go red — the second is the one that proves the contract, not the shape. Restore.

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/api test && pnpm -r typecheck
git add apps/admin services/api/src/http/agentApi.ts
git commit -m "feat(crm-ui): the persistent agent panel and its transcript contract"
```

---

### Task 16: Review markers in the Ledger

**Files:**
- Create: `apps/admin/src/crm/ledger/ReviewMarker.tsx`
- Modify: `apps/admin/src/crm/ledger/columns.tsx` (the REF cell carries the marker)
- Modify: `apps/admin/src/crm/ledger/LedgerPage.tsx` (load the summary once)
- Test: `apps/admin/test/crm/ReviewMarker.test.tsx`

**Interfaces:**
- Consumes: `useReviewSummary` (Task 9), `crmClient.getReviewItem`, `crmClient.resolveReviewItem` (Task 9).
- Produces: `<ReviewMarker caseRef={...} entry={...} />`.

**From spec §7, and the reason it is not a sixth screen:** the import produced 3,958 review items and 1,480 merge proposals and has no interface at all, so RGS cannot clean their own data through the product. Putting the work *in* the Ledger makes cleaning ordinary daily work rather than a separate chore nobody schedules.

- a case with unresolved review items carries a marker on its row, joined on `caseRef`;
- the marker opens the items inline, each resolvable in place via `PUT .../review/{reviewItemId}/resolve`;
- **a merge candidate is marked distinctly from a field-level problem** — different mark, different words, because they are different work.

**What resolving does and does not do.** `resolveReviewItem` closes the review item. It does **not** write the resolved value onto the case — `reviewQueue.ts` has no case write in it, by design. So a marker offering "apply this value" would be lying about what the button does. The inline resolver offers exactly two actions, named for what they are: **Dismiss** (`reviewStatus: "DISMISSED"`) and **Record the correct value** (`reviewStatus: "APPLIED"` with `resolvedValue`), and the second says in the UI that it records the decision for the record, and that changing the case itself is a separate edit in the row above. Anything else would be a promise the backend does not keep.

- [ ] **Step 1: Write the failing test**

```tsx
describe("ReviewMarker", () => {
  it("marks a case with field-level problems", () => {
    render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", fieldItemIds: ["rev_1", "rev_2"], mergeItemIds: [] }} />);
    expect(screen.getByRole("button", { name: /2 import problems/i })).toBeInTheDocument();
  });

  it("marks a merge candidate differently from a field problem", () => {
    const { container: fieldMarker } = render(<ReviewMarker caseRef="RGS-1001" entry={{ caseRef: "RGS-1001", fieldItemIds: ["rev_1"], mergeItemIds: [] }} />);
    const { container: mergeMarker } = render(<ReviewMarker caseRef="RGS-1002" entry={{ caseRef: "RGS-1002", fieldItemIds: [], mergeItemIds: ["rev_9"] }} />);

    expect(mergeMarker.textContent).toMatch(/may be a duplicate/i);
    expect(mergeMarker.firstElementChild?.className).not.toBe(fieldMarker.firstElementChild?.className);
  });

  it("renders no marker at all for a clean case", () => {
    const { container } = render(<ReviewMarker caseRef="RGS-1001" entry={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the items inline, fetching each one only when opened", async () => {
    /* getReviewItem called on open, not on render -- 3,958 gets on page load
       is the thing the summary route exists to avoid */
  });

  it("resolves an item in place and drops it from the marker", async () => {
    /* PUT .../review/rev_1/resolve, then the count falls from 2 to 1 */
  });

  it("says plainly that recording a value does not change the case", async () => {
    render(/* an open marker with one UNMAPPED_STATUS item */);
    expect(screen.getByText(/records the decision.*does not change the case/i)).toBeInTheDocument();
  });

  it("reports a failed resolution rather than closing the item on screen", async () => {
    /* a 409 (someone else resolved it first) leaves the item visible and says so */
  });
});
```

- [ ] **Step 2: Run, implement, run, prove it can fail, commit**

Remove the `mergeItemIds` branch and confirm the distinct-mark test goes red. Restore.

```bash
pnpm --filter @rgs/admin test && pnpm --filter @rgs/admin typecheck
git add apps/admin/src/crm apps/admin/test/crm
git commit -m "feat(crm-ui): inline import-review markers on the Ledger"
```

---

## Manual verification, before this is shown to RGS

Unit tests cannot cover these. Do them in order.

1. **Run the backfill against the real table.** `pnpm --filter @rgs/migration backfill:summary`. Expect `scanned ≈ 7156`. Any `unreadable` count is a finding to report, not a failure to retry — those cases are half-written partitions and need a decision, not another run.
2. **Load the Ledger against real data.** Every row must show an applicant count and a custody roll-up, not "Not summarised". If a band of rows still says it, the backfill did not finish and the count in step 1 says so.
3. **Scroll from the first row to the last.** No blank bands, no overlapping rows, no growth in memory that does not level off. 7,156 rows is the real number.
4. **Time the first paint.** The Ledger is a walk of ~15 pages at 500 rows. If it is slower than a few seconds, raise `DEFAULT_LEDGER_PAGE_LIMIT` — do not add a second index.
5. **Edit a status on a row near the bottom, then undo it.** The undo toast must reach the same row and the value must return.
6. **Force a 409.** Open the same case in two tabs, move its status in one, then move it in the other. Both values must appear and neither must be picked for you.
7. **Run one agent turn, then a second in the same panel session.** The second is the one that exercises the replay. A 400 naming `conversation` here means the transcript contract broke and Task 15's tests did not catch it — that is a plan defect worth reporting.
8. **Check the purple.** `--crm-primary` must appear on exactly one control on screen: Approve. Not Save, not Create Case, not Resolve.
9. **Open a case with review items and resolve one.** The marker count must fall, and the case itself must be unchanged — which is what the copy says will happen.

---

## Self-review

Run against the spec with fresh eyes after the plan was written.

**1. Spec coverage.**

| Spec section | Where it lands |
|---|---|
| §2 (lives in `apps/admin/src/crm`, routed `/crm/*`, no second login) | Tasks 8, 10 |
| §2.1 (applicant summary; row projection + route; full detail stays put) | Tasks 1, 2, 3, 4 |
| §3 (Notion tokens, the two departures, the purple rule, the four axes' tints, UNKNOWN as data debt) | Task 8, pinned again in Task 15's purple test |
| §4 rows (one row per case, applicants nested, roll-ups on the parent, the label map) | Tasks 8, 10, 13 |
| §4 columns (the ten, in order, REF and header sticky) | Task 10 |
| §4 scale (virtualized over a windowed range) | Task 10 |
| §4 keyboard (the eight bindings, fixed) | Task 11 |
| §4 inline editing (commit on blur, optimistic, undo toast, not staged behind the gate) | Task 12 |
| §4 views (named filter sets, per user) | Task 13 |
| §5 (Case screen: shared fields, applicants, line items, notes, timeline, the autoApplied distinction) | Task 14 |
| §6 (persistent panel, never modal, the four AX patterns, trust level, N proposals in one card, per-item partial failure) | Task 15 |
| §7 (review markers inline, merge marked distinctly, resolve in place) | Tasks 5, 16 |
| §8 (TanStack Query, optimistic with rollback, **the transcript contract**) | Tasks 9, 12, 15 |
| §9 (optimistic + rollback + undo, 409 shows both, per-item partial failure, a failed turn says what it was attempting) | Tasks 12, 15 |
| §10 (Vitest + Testing Library, the two named traps, no Playwright) | Tasks 8, 10 (trap 1), 12 and 15 (trap 2) |
| §11 (everything deferred) | The Scope table; nothing in any task touches them |

**Gaps found while writing this, and what was done about each:**

- **`updateCaseDetails` has no HTTP route.** Spec §4 makes `appointmentDate` an editable column and §2 lists no route for it, because none exists. Added as Task 7, with the measurement that put it there.
- **Review resolve, proposal approve and proposal discard are `PUT`, not `POST`.** Spec §2 and §6 say POST. The code says PUT, the deployed admin route declares PUT and no PATCH. Recorded in Task 9's method table and asserted by two tests, because a POST here is a 404 that no mocked test would catch.
- **The 7,156 imported cases have no `applicantSummary`.** Not mentioned in the spec at all; without a backfill, every row of the real ledger reads "Not summarised". Added as Task 6, and `LedgerRowSchema` makes the field optional so the screen degrades honestly instead of reporting 7,156 unreadable rows.
- **`sort` cannot be honoured server-side.** Spec §2.1 asks for it; no index orders all cases by `receivedDate`. Dropped from the route with the reason written into Task 3, and replaced by client-side sorting over the fully loaded window — which is the same 1.4 MB the spec itself sizes.
- **The review queue is capped at 200 with no cursor**, so §7's markers could not have been built on it. Task 5 adds a projected summary read instead of a GSI that would need 3,958 rows rewritten before it answered anything.
- **`toolCallsMade` carries no call ids**, so the panel cannot replay tool pairs even if it wanted to. Turned into an explicit design decision and two tests in Task 15, rather than left for an implementer to discover by getting a 400.
- **Adding a method to `TableClient` silently breaks production** unless `tableRetry.ts` delegates it. Called out in the Global Constraints and given its own test in Task 2.
- **`/crm/cases/ledger` and `/crm/review/summary` both collide with a parameterised sibling.** Registration order is the only defence, so both have an explicit ordering test.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Tasks 13, 14 and 16 give test names with bodies elided where the body is mechanical (a render and a query); every test whose *content* is the point — the transcript contract, the virtualization traps, the rollback, the 409, the partial failure, the cursor walk — is written out in full.

**3. Type consistency.** `ApplicantSummary`, `LedgerRow` and `LedgerRowSchema` are defined once in Task 1 and consumed unchanged in Tasks 3, 4, 9, 10 and 13. `QueryPage`, `PagedQueryOptions` and `TableItemKey` are defined once in Task 2 and used in Tasks 3 and 5. `LedgerPage`/`LedgerPageResponse` deliberately differ: the domain type has no `appliedQuery` and the wire type does, because `appliedQuery` is the route's statement about what it ran. `LedgerFilters` (Task 13) is the client's superset of `LedgerQuery` (Task 3) and the two are joined only in `LedgerPage.tsx`, which is the one file allowed to know both. `TranscriptMessage` (Task 15) mirrors `AgentMessage` field for field and is validated against the route's own `RunTurnBody` rather than against a restatement of it.

**4. One thing a reviewer should push on.** Task 10 and Task 13 both touch `LedgerTable.tsx`, and Task 13's expanded-row measurement is the kind of change that can quietly break Task 10's windowing. The overlap test at the end of Task 13 exists for exactly that, and it is the test to run first if rows ever look wrong.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-11-crm-plan-5-ledger-ui.md`.

**Branch:** `crm-plan-5`, off `main` at `88b5c46`.

**Order matters in one place only:** Tasks 1 → 2 → 3 → 4 are a chain (the summary feeds the projection, which feeds the route). Task 5, Task 6 and Task 7 are independent of each other and of the chain after Task 2. Task 8 gates every frontend task. Tasks 10 → 11 → 12 → 13 are a chain on the same files. Tasks 14, 15 and 16 are independent of each other once Task 9 lands.

Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
