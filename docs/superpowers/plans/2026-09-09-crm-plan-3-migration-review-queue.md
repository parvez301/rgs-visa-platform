# CRM Migration Importer and Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the 7,157-importable-row RGS Excel workbook into the CRM built by Plans 1-2, deterministically where the mapping tables allow and into a human review queue where they do not.

**Architecture:** A new `services/migration` workspace package reads the workbook by column *position* (headers are unreliable), converts Excel serial dates at the reader boundary, and maps each row through the Plan 1 normalizers. Rows that map cleanly are written through the Plan 2 domain functions; rows that do not become `ReviewItem` rows the admin API exposes for human resolution. The importer is idempotent on `caseRef` (the Excel REF NO), so it can be re-run against staging until the review queue is boring. Pass 2 of spec §9 — LLM resolution of the residue — is a **named seam** in this plan (`ResidueResolver`, with a deterministic no-op implementation) that Plan 4's agent layer fills in without restructuring anything.

**Tech Stack:** pnpm 10 workspace, Node ≥22, TypeScript strict (ESM, no file extensions on local imports), Zod 3, Vitest 2, `exceljs` (new, isolated to `services/migration`), DynamoDB via the existing `TableClient` port.

**Spec:** `docs/superpowers/specs/2026-09-09-rgs-crm-design.md` — §9 Migration is the section this plan implements; §6 Normalization supplies the mapping tables (already implemented in Plan 1); §5 Data model supplies the key shapes.

## Global Constraints

- TypeScript strict; **no `any`**. `tsconfig.base.json` sets `noUncheckedIndexedAccess: true` — every indexed access needs `!` or `?.`.
- ESM only: local imports carry **no file extension** (`from "./mapRow"`, never `"./mapRow.js"`).
- Descriptive variable names throughout. Never `cfg`, `res`, `idx`, `val`, `i`, `e`.
- **`packages/shared` and `services/api` take no new runtime dependency.** `exceljs` is added to `services/migration` only, which is never imported by the Lambda bundle.
- **`services/api/src/domain/crm/keys.ts` is the only file permitted to write a CRM DynamoDB key as a string literal.**
- Every rejected operation throws a typed error from `services/api/src/lib/errors` (`notFound`, `badRequest`, `conflict`, `forbidden`) — never a bare `Error`. A bare `Error` becomes a 500 where the caller deserves a 4xx.
- All timestamps come from `context.now()`. Never `new Date()` or `Date.now()` in domain or importer code.
- Every admin route calls `requireAdmin(requestContext)` as its first statement.
- **Only GET, POST and PUT.** The CDK route `/api/v1/admin/{proxy+}` declares GET/POST/PUT/DELETE and **no PATCH**; a PATCH route passes every unit test and then 404s in deployment.
- **Nothing is discarded.** Every imported record keeps `sourceSheet` and `sourceRow`; unmappable columns land in `legacyRaw`.
- **Migrated cases are never dragged by the derived-status rules.** The importer writes through `caseStore.writeCase` directly and never calls `changeCaseStatus` / `changeApplicantCustody` / `changeBillingStatus` / `changeApplicantOutcome`.
- Blank cells mean **"not recorded"**, not "needs review" (spec §6). Only a value that is present and unmappable goes to the queue.

---

## Established facts this plan depends on

These were measured against the real workbook. Do not re-derive them; do not contradict them.

| Fact | Value | Why it matters |
|---|---|---|
| Workbook sheets | `Mini CRM`, `REQURIED INFORMATION`, `2025 YEAR`, `CHECKLIST` | Only `Mini CRM` and `2025 YEAR` are imported |
| `Mini CRM` size | `rowCount` 7,553 · `actualRowCount` 7,162 · **7,157 rows carry a REF NO** | The primary ledger. The three numbers differ and the difference is explained in the two rows below — do not "fix" the reader to make them agree. |
| `2025 YEAR` size | `rowCount` 6,549 · `actualRowCount` 6,547 · **6,546 rows carry a REF NO** | Supplies `Phone` and `TRACKING NO.`, which `Mini CRM` lacks |
| 391 blank rows sit inside `Mini CRM`'s used range | `rowCount` runs to 7,553 but only 7,162 rows hold anything | `eachRow` without `{includeEmpty:true}` skips them. Never iterate `1..rowCount` — you would map 391 empty rows into 391 junk cases. |
| 4 `Mini CRM` rows are non-blank but have **no REF NO** | Rows 5984, 6308, 6615, 6900 hold only a date in column C (`APPLICANTS NAME`): Jun/Jul/Aug/Sep 2026 | They are **month divider rows** someone typed into the name column, not data. The reader's `if (caseRef === "") return;` drops them, which is correct — they must NOT become cases and must NOT raise review items. This is also why the sheet yields 7,157 and not 7,161. |
| `Mini CRM` columns | A=`C`(received date) B=`REF NO.` C=`APPLICANTS NAME` D=`No.` E=`REFRENCE`(partner) F=`Country` G=`DOB` H=`Sub Date` I=`Collection` J=`Passport No.` K=`Entries` L=`Visa Type` M=`Status` N=`Additional Items` | Read by position |
| `2025 YEAR` columns | A=`DATE` B=`REF NO.` C=`APPLICANTS NAME` D=`REFRENCE` E=**header literally says `China`** F=`DOB` G=`No.` H=`Sub Date` I=`Collection` J=`Phone` K=`TRACKING NO.` L=`Passport No.` M=`Visa Type` N=`Entries` | Column E's header is a country someone typed into the header cell. **Never key on header text for this sheet — use position.** |
| Date encoding differs per sheet | `Mini CRM` dates are **text**; `2025 YEAR` dates are **numeric Excel serials** | Feeding serials to `normalizeExcelDate` sends all 6,546 rows to review — it explicitly refuses serials |
| The workbook is **live**, not a frozen export | Its last month-divider row reads September 2026 — the current month | RGS is still typing into this sheet daily. The import will be run more than once and must pick up rows added since the last run: this is the evidence behind Task 9's idempotency requirement, not a hypothetical. |
| Excel epoch | **1900 system, base `1899-12-30`** | Determined empirically, not guessed: REF NO 31376 has `Sub Date` serial `45657` on `2025 YEAR` and text `12/31/2024` on `Mini CRM`; `1899-12-30 + 45657 days = 2024-12-31`. The 1904 system yields 2029-01-01 and is wrong. |
| `Sub Date` convention | **Day-first.** Unambiguous rows split 3,261 day-first vs 15 month-first (99.5%) | Separator does NOT predict convention — both appear with `/`. Parse day-first; the ~11 ambiguous rows that are truly month-first are accepted losses, and land in review only if the day-first reading is not a real calendar date. |
| `Sub Date` blanks | 1,552 (21.7%) | Blank = not recorded. Not a review item. |
| `Sub Date` unparseable | 27, e.g. `"aposttile"`, `"Passport"`, `"21/4//2025"`, `"29/04/2025."` | Present-but-unmappable → review queue |
| `REF NO.` / `No.` formatting | Floats: `31376.0`, `3.0` | Must be normalised to `"31376"` / `3` before use as an identity key |
| `Phone` formatting | Scientific notation: `7.23001238E8` | Must be expanded to digits; a result that is not 10 digits starting 6-9 is recorded but flagged |
| Plan 1 normalizers | `normalizeCountry`, `normalizeEntries`, `normalizeStatus`, `normalizeVisaType`, `normalizePartnerName`, `normalizeExcelDate`, `buildLookupKey` — all exported from `@rgs/shared` under the `crm` namespace | Pass 1 composes these. **Do not write new matching logic.** |

### Normalizer result shapes (Plan 1, already shipped)

```ts
interface CountryNormalizationResult   { countryCode: string | null; visaTypeHint: VisaType | null; needsReview: boolean; rawValue: string }
interface EntriesNormalizationResult   { entryType: EntryType | null; processing: ProcessingSpeed | null; validity: string | null; needsReview: boolean; rawValue: string }
interface VisaTypeNormalizationResult  { caseType: CaseType | null; visaType: VisaType | null; needsReview: boolean; rawValue: string }
interface PartnerNormalizationResult   { canonicalKey: string | null; partnerType: PartnerType; needsReview: boolean; rawValue: string }
interface DateNormalizationResult      { isoDate: string | null; needsReview: boolean; rawValue: string }
interface StatusNormalizationResult {
  caseStatus: CaseStatus | null; custody: CustodyStatus | null; outcome: ApplicantOutcome | null;
  courierMode: CourierMode | null; caseTypeHint: CaseType | null; lineItemHint: string | null;
  note: string | null; needsReview: boolean; rawValue: string;
}
```

### Plan 2 domain functions this plan calls

```ts
// services/api/src/domain/crm/partners
createPartner(context, tenantId, input, actorEmail): Promise<crm.Partner>   // throws conflict(409) on duplicate canonical key
findPartnerByName(context, tenantId, rawName): Promise<crm.Partner | undefined>
// services/api/src/domain/crm/travellers
upsertTraveller(context, tenantId, input): Promise<crm.CrmTraveller>
findTravellerByPassport(context, tenantId, passportNumber): Promise<crm.CrmTraveller | undefined>
findTravellerByName(context, tenantId, fullName): Promise<crm.CrmTraveller | undefined>
// services/api/src/domain/crm/caseStore
writeCase(context, crmCase): Promise<void>
readCase(context, tenantId, caseId): Promise<crm.CrmCase | undefined>
```

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/crm/reviewItem.ts` | `ReviewItemSchema`, `REVIEW_REASONS`, `REVIEW_STATUSES`. Shared because both the importer and the API validate it. |
| `services/api/src/domain/crm/keys.ts` (modify) | Review-item key builders. The only file allowed to write CRM key literals. |
| `services/api/src/domain/crm/reviewQueue.ts` | Review-queue domain: create, list by status, resolve. Lives in the API because the admin screen reads it. |
| `services/api/src/http/crmApi.ts` (modify) | Three review-queue routes. |
| `services/migration/src/excelSerial.ts` | Excel serial → ISO date, 1900 epoch. One job, because getting it wrong silently shifts every date on a sheet. |
| `services/migration/src/readWorkbook.ts` | `.xlsx` → typed raw rows, by column position, serials already converted. Owns the mislabeled-header problem. |
| `services/migration/src/joinPhones.ts` | REF NO join from `2025 YEAR` → phone + tracking number. |
| `services/migration/src/mapRow.ts` | Pass 1. One raw row → `MappedRow` or `ReviewItem`. Pure; no I/O. |
| `services/migration/src/residueResolver.ts` | The Plan 4 seam. Interface + deterministic no-op implementation. |
| `services/migration/src/groupCases.ts` | Group detection. Proposes only; never auto-applies. |
| `services/migration/src/importRun.ts` | Orchestration and idempotency. The only file that writes. |
| `services/migration/src/cli.ts` | Entry point. Flags, dry-run, summary report. |

**Task order rationale:** Tasks 1-3 build the shared contract and the review queue (no workbook involved, fully unit-testable). Tasks 4-6 build the reader and the pure mapper. Tasks 7-9 assemble, group, and expose. Every task is independently testable; a reviewer can reject any one without blocking its neighbour.

---

### Task 1: Review-item schema in the shared package

**Files:**
- Create: `packages/shared/src/crm/reviewItem.ts`
- Modify: `packages/shared/src/crm/index.ts`
- Test: `packages/shared/test/crm/reviewItem.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `REVIEW_REASONS: readonly ["UNMAPPED_STATUS","UNMAPPED_ENTRIES","UNMAPPED_VISA_TYPE","UNMAPPED_COUNTRY","UNMAPPED_PARTNER","UNPARSEABLE_DATE","COLUMN_SHIFT_JUNK","SUSPECT_PHONE","PROPOSED_GROUP","DUPLICATE_REF"]`
  - `type ReviewReason = (typeof REVIEW_REASONS)[number]`
  - `REVIEW_STATUSES: readonly ["OPEN","APPLIED","DISMISSED"]`
  - `type ReviewStatus = (typeof REVIEW_STATUSES)[number]`
  - `ReviewItemSchema` (Zod) and `type ReviewItem`

**Context for the implementer:** This is the contract for spec §9's pass 3. `proposedValue` is what pass 1 (or later, Plan 4's LLM) suggests; `rawValue` is what the sheet actually said. Both are kept because a reviewer needs to compare them side by side — that is the whole point of the screen. `confidence` exists now, unused by this plan, because Plan 4's pass 2 writes a score there and the field must not require a schema migration later; it is optional so pass 1 simply omits it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";

describe("ReviewItemSchema", () => {
  const validItem = {
    tenantId: "rgs",
    reviewItemId: "rev_01",
    reason: "UNMAPPED_STATUS" as const,
    reviewStatus: "OPEN" as const,
    sourceSheet: "Mini CRM",
    sourceRow: 42,
    caseRef: "31376",
    fieldName: "Status",
    rawValue: "DEU/DEL/190126/",
    createdAt: "2026-07-23T10:00:00.000Z",
  };

  it("accepts a minimal open item and defaults the optional fields", () => {
    const parsed = crm.ReviewItemSchema.parse(validItem);
    expect(parsed.reviewStatus).toBe("OPEN");
    expect(parsed.proposedValue).toBeUndefined();
    expect(parsed.confidence).toBeUndefined();
  });

  it("keeps a proposed value and a confidence score when pass 2 supplies them", () => {
    const parsed = crm.ReviewItemSchema.parse({ ...validItem, proposedValue: "IN_PROGRESS", confidence: 0.82 });
    expect(parsed.proposedValue).toBe("IN_PROGRESS");
    expect(parsed.confidence).toBe(0.82);
  });

  it("rejects a reason that is not in the enum", () => {
    expect(() => crm.ReviewItemSchema.parse({ ...validItem, reason: "VIBES" })).toThrow();
  });

  it("rejects a confidence outside 0..1", () => {
    expect(() => crm.ReviewItemSchema.parse({ ...validItem, confidence: 1.4 })).toThrow();
  });

  it("requires sourceSheet and sourceRow so every item traces back to the workbook", () => {
    const { sourceRow: _omitted, ...withoutRow } = validItem;
    expect(() => crm.ReviewItemSchema.parse(withoutRow)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/shared test reviewItem`
Expected: FAIL — `crm.ReviewItemSchema` is undefined.

- [ ] **Step 3: Write the implementation**

```ts
import { z } from "zod";

/** Why a row could not be applied deterministically. Spec §9 pass 3. */
export const REVIEW_REASONS = [
  "UNMAPPED_STATUS",
  "UNMAPPED_ENTRIES",
  "UNMAPPED_VISA_TYPE",
  "UNMAPPED_COUNTRY",
  "UNMAPPED_PARTNER",
  "UNPARSEABLE_DATE",
  "COLUMN_SHIFT_JUNK",
  "SUSPECT_PHONE",
  "PROPOSED_GROUP",
  "DUPLICATE_REF",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_STATUSES = ["OPEN", "APPLIED", "DISMISSED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ReviewItemSchema = z.object({
  tenantId: z.string().min(1),
  reviewItemId: z.string().min(1),
  reason: z.enum(REVIEW_REASONS),
  reviewStatus: z.enum(REVIEW_STATUSES).default("OPEN"),
  /** Provenance: every item traces back to a workbook cell. Spec §9. */
  sourceSheet: z.string().min(1),
  sourceRow: z.number().int().positive(),
  caseRef: z.string().min(1),
  /** The workbook column this item is about, e.g. "Status". */
  fieldName: z.string().min(1),
  /** Exactly what the sheet said, before any normalization. */
  rawValue: z.string(),
  /** What pass 1 or pass 2 suggests. Absent when nothing could be suggested. */
  proposedValue: z.string().optional(),
  /** Written by Plan 4's pass 2 only. Pass 1 omits it. */
  confidence: z.number().min(0).max(1).optional(),
  /** Free-text explanation shown beside the row on the review screen. */
  detail: z.string().optional(),
  resolvedValue: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
```

Then add to `packages/shared/src/crm/index.ts`, alongside the existing re-exports:

```ts
export * from "./reviewItem";
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/shared test reviewItem`
Expected: PASS, 5 tests.

Then confirm nothing regressed: `pnpm --filter @rgs/shared test` (baseline 167) and `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/reviewItem.ts packages/shared/src/crm/index.ts packages/shared/test/crm/reviewItem.test.ts
git commit -m "feat(crm): add the review-item schema for the migration queue"
```

---

### Task 2: Review-queue key builders

**Files:**
- Modify: `services/api/src/domain/crm/keys.ts`
- Test: `services/api/test/crm/keys.test.ts`

**Interfaces:**
- Consumes: the existing key-builder conventions in that file.
- Produces:
  - `reviewItemPartitionKey(tenantId: string, reviewItemId: string): string`
  - `reviewQueueGsi1Pk(tenantId: string, reviewStatus: string): string`
  - `REVIEW_ITEM_SORT_KEY: "META"` — reuse the existing `CASE_META_SORT_KEY` constant rather than adding a second `"META"` literal.

**Context for the implementer:** Read the whole file first and copy its existing idiom exactly — segment order, separator, and the `TENANT#<t>#` prefix. This file is the only place in the repo permitted to write a CRM key format as a string literal, and every other module depends on these strings being right. The GSI1 partition groups review items by status so the screen can list every `OPEN` item in one query; `OPEN` is the only status the screen loads by default.

- [ ] **Step 1: Write the failing test**

Add to `services/api/test/crm/keys.test.ts`:

```ts
  it("builds tenant-scoped review-item keys", () => {
    expect(reviewItemPartitionKey("rgs", "rev_01")).toBe("TENANT#rgs#REVIEW#rev_01");
  });

  it("partitions the review queue by status so the screen loads OPEN in one query", () => {
    expect(reviewQueueGsi1Pk("rgs", "OPEN")).toBe("TENANT#rgs#REVIEW_STATUS#OPEN");
    expect(reviewQueueGsi1Pk("rgs", "APPLIED")).toBe("TENANT#rgs#REVIEW_STATUS#APPLIED");
  });

  it("keeps review items in a different keyspace from cases", () => {
    expect(reviewItemPartitionKey("rgs", "x")).not.toBe(casePartitionKey("rgs", "x"));
  });

  it("scopes review keys per tenant", () => {
    expect(reviewItemPartitionKey("rgs", "rev_01")).not.toBe(reviewItemPartitionKey("other", "rev_01"));
    expect(reviewQueueGsi1Pk("rgs", "OPEN")).not.toBe(reviewQueueGsi1Pk("other", "OPEN"));
  });
```

Update the import at the top of the file to include `reviewItemPartitionKey` and `reviewQueueGsi1Pk`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/api test keys`
Expected: FAIL — the two builders are not exported.

- [ ] **Step 3: Write the implementation**

Append to `services/api/src/domain/crm/keys.ts`, matching the surrounding style:

```ts
export function reviewItemPartitionKey(tenantId: string, reviewItemId: string): string {
  return `TENANT#${tenantId}#REVIEW#${reviewItemId}`;
}

export function reviewQueueGsi1Pk(tenantId: string, reviewStatus: string): string {
  return `TENANT#${tenantId}#REVIEW_STATUS#${reviewStatus}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/api test keys` — PASS.
Then `pnpm --filter @rgs/api test` (baseline from Plan 2's close) and `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/keys.ts services/api/test/crm/keys.test.ts
git commit -m "feat(crm): add review-queue key builders"
```

---

### Task 3: Review-queue domain module

**Files:**
- Create: `services/api/src/domain/crm/reviewQueue.ts`
- Test: `services/api/test/crm/reviewQueue.test.ts`

**Interfaces:**
- Consumes: `reviewItemPartitionKey`, `reviewQueueGsi1Pk`, `CASE_META_SORT_KEY` from `./keys`; `crm.ReviewItemSchema`, `crm.ReviewItem`, `crm.ReviewReason` from `@rgs/shared`; `newId` from `../../lib/ids`; `notFound`, `conflict` from `../../lib/errors`.
- Produces:
  - `recordReviewItem(context: AppContext, tenantId: string, input: RecordReviewItemInput): Promise<crm.ReviewItem>`
  - `interface RecordReviewItemInput { reason: crm.ReviewReason; sourceSheet: string; sourceRow: number; caseRef: string; fieldName: string; rawValue: string; proposedValue?: string; confidence?: number; detail?: string }`
  - `listReviewItems(context: AppContext, tenantId: string, reviewStatus: crm.ReviewStatus, limit?: number): Promise<crm.ReviewItem[]>`
  - `getReviewItemOrThrow(context: AppContext, tenantId: string, reviewItemId: string): Promise<crm.ReviewItem>`
  - `resolveReviewItem(context: AppContext, tenantId: string, reviewItemId: string, resolution: { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string }, actorEmail: string): Promise<crm.ReviewItem>`

**Context for the implementer:** Follow `services/api/src/domain/crm/partners.ts` as the model — same argument order, same use of `context.now()`, same `notFound` on a miss. Store `GSI1PK = reviewQueueGsi1Pk(tenantId, reviewStatus)` on the item so `listReviewItems` is one `queryGsi` rather than a scan; **the GSI1PK must be rewritten when the status changes**, or a resolved item stays in the `OPEN` partition forever and the screen never empties. Strip the `GSI*` attributes before parsing to `ReviewItem`, exactly as `partners.ts` does — those are storage concerns, not domain fields.

Resolving an already-resolved item throws `conflict`. Two reviewers working the queue at once is the expected case, not an exotic one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import {
  getReviewItemOrThrow,
  listReviewItems,
  recordReviewItem,
  resolveReviewItem,
} from "../../src/domain/crm/reviewQueue";

const baseInput = {
  reason: "UNMAPPED_STATUS" as const,
  sourceSheet: "Mini CRM",
  sourceRow: 42,
  caseRef: "31376",
  fieldName: "Status",
  rawValue: "DEU/DEL/190126/",
};

describe("crm review queue", () => {
  it("records an item as OPEN and reads it back", async () => {
    const context = buildTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect(created.reviewStatus).toBe("OPEN");
    expect(created.rawValue).toBe("DEU/DEL/190126/");
    expect(created.sourceRow).toBe(42);

    const loaded = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(loaded).toEqual(created);
  });

  it("does not leak storage attributes into the domain object", async () => {
    const context = buildTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect("GSI1PK" in created).toBe(false);
    expect("PK" in created).toBe(false);
  });

  it("lists only the requested status", async () => {
    const context = buildTestContext();
    const first = await recordReviewItem(context, "rgs", baseInput);
    await recordReviewItem(context, "rgs", { ...baseInput, sourceRow: 43 });
    await resolveReviewItem(context, "rgs", first.reviewItemId, { reviewStatus: "DISMISSED" }, "ops@rgs.test");

    const open = await listReviewItems(context, "rgs", "OPEN");
    const dismissed = await listReviewItems(context, "rgs", "DISMISSED");
    expect(open.map((item) => item.sourceRow)).toEqual([43]);
    expect(dismissed.map((item) => item.sourceRow)).toEqual([42]);
  });

  it("moves an item out of the OPEN partition when it is resolved", async () => {
    const context = buildTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    expect(await listReviewItems(context, "rgs", "OPEN")).toHaveLength(1);

    await resolveReviewItem(
      context,
      "rgs",
      created.reviewItemId,
      { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" },
      "ops@rgs.test",
    );

    expect(await listReviewItems(context, "rgs", "OPEN")).toHaveLength(0);
    const resolved = await getReviewItemOrThrow(context, "rgs", created.reviewItemId);
    expect(resolved.reviewStatus).toBe("APPLIED");
    expect(resolved.resolvedValue).toBe("IN_PROGRESS");
    expect(resolved.resolvedBy).toBe("ops@rgs.test");
    expect(resolved.resolvedAt).toBe("2026-07-23T10:00:00.000Z");
  });

  it("refuses to resolve the same item twice with a 409", async () => {
    const context = buildTestContext();
    const created = await recordReviewItem(context, "rgs", baseInput);
    await resolveReviewItem(context, "rgs", created.reviewItemId, { reviewStatus: "APPLIED" }, "ops@rgs.test");
    await expect(
      resolveReviewItem(context, "rgs", created.reviewItemId, { reviewStatus: "DISMISSED" }, "other@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("throws a 404 for an unknown review item", async () => {
    const context = buildTestContext();
    await expect(getReviewItemOrThrow(context, "rgs", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not return another tenant's items", async () => {
    const context = buildTestContext();
    await recordReviewItem(context, "rgs", baseInput);
    expect(await listReviewItems(context, "other", "OPEN")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/api test reviewQueue`
Expected: FAIL — `Failed to load url ../../src/domain/crm/reviewQueue`.

- [ ] **Step 3: Write the implementation**

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { conflict, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { CASE_META_SORT_KEY, reviewItemPartitionKey, reviewQueueGsi1Pk } from "./keys";

export interface RecordReviewItemInput {
  reason: crm.ReviewReason;
  sourceSheet: string;
  sourceRow: number;
  caseRef: string;
  fieldName: string;
  rawValue: string;
  proposedValue?: string;
  confidence?: number;
  detail?: string;
}

/** Storage attributes are not domain fields — drop them before parsing. */
function stripStorageKeys(storedItem: Record<string, unknown>): Record<string, unknown> {
  const { PK: _pk, SK: _sk, GSI1PK: _gsi1Pk, GSI1SK: _gsi1Sk, ...domainFields } = storedItem;
  return domainFields;
}

export async function recordReviewItem(
  context: AppContext,
  tenantId: string,
  input: RecordReviewItemInput,
): Promise<crm.ReviewItem> {
  const createdAt = context.now().toISOString();
  const reviewItem = crm.ReviewItemSchema.parse({
    tenantId,
    reviewItemId: newId("rev", context.now().getTime()),
    reason: input.reason,
    reviewStatus: "OPEN",
    sourceSheet: input.sourceSheet,
    sourceRow: input.sourceRow,
    caseRef: input.caseRef,
    fieldName: input.fieldName,
    rawValue: input.rawValue,
    ...(input.proposedValue !== undefined ? { proposedValue: input.proposedValue } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt,
  });

  await context.table.put({
    PK: reviewItemPartitionKey(tenantId, reviewItem.reviewItemId),
    SK: CASE_META_SORT_KEY,
    GSI1PK: reviewQueueGsi1Pk(tenantId, reviewItem.reviewStatus),
    GSI1SK: reviewItem.createdAt,
    ...reviewItem,
  });

  return reviewItem;
}

export async function listReviewItems(
  context: AppContext,
  tenantId: string,
  reviewStatus: crm.ReviewStatus,
  limit = 200,
): Promise<crm.ReviewItem[]> {
  const storedItems = await context.table.queryGsi("GSI1", reviewQueueGsi1Pk(tenantId, reviewStatus), {
    limit,
    scanForward: true,
  });
  return storedItems.map((storedItem) => crm.ReviewItemSchema.parse(stripStorageKeys(storedItem)));
}

export async function getReviewItemOrThrow(
  context: AppContext,
  tenantId: string,
  reviewItemId: string,
): Promise<crm.ReviewItem> {
  const storedItem = await context.table.get(reviewItemPartitionKey(tenantId, reviewItemId), CASE_META_SORT_KEY);
  if (storedItem === undefined) {
    throw notFound("Review item");
  }
  return crm.ReviewItemSchema.parse(stripStorageKeys(storedItem));
}

export async function resolveReviewItem(
  context: AppContext,
  tenantId: string,
  reviewItemId: string,
  resolution: { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string },
  actorEmail: string,
): Promise<crm.ReviewItem> {
  const existingItem = await getReviewItemOrThrow(context, tenantId, reviewItemId);
  if (existingItem.reviewStatus !== "OPEN") {
    throw conflict(`Review item ${reviewItemId} is already ${existingItem.reviewStatus}`);
  }

  const resolvedItem = crm.ReviewItemSchema.parse({
    ...existingItem,
    reviewStatus: resolution.reviewStatus,
    ...(resolution.resolvedValue !== undefined ? { resolvedValue: resolution.resolvedValue } : {}),
    resolvedBy: actorEmail,
    resolvedAt: context.now().toISOString(),
  });

  // GSI1PK must follow the status, or a resolved item stays in the OPEN
  // partition forever and the review screen never empties.
  await context.table.put({
    PK: reviewItemPartitionKey(tenantId, resolvedItem.reviewItemId),
    SK: CASE_META_SORT_KEY,
    GSI1PK: reviewQueueGsi1Pk(tenantId, resolvedItem.reviewStatus),
    GSI1SK: resolvedItem.createdAt,
    ...resolvedItem,
  });

  return resolvedItem;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/api test reviewQueue` — PASS, 7 tests.
Then `pnpm --filter @rgs/api test` and `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/reviewQueue.ts services/api/test/crm/reviewQueue.test.ts
git commit -m "feat(crm): add the migration review queue domain module"
```

---

### Task 4: Review-queue routes

**Files:**
- Modify: `services/api/src/http/crmApi.ts`
- Test: `services/api/test/crm/crmApi.test.ts`

**Interfaces:**
- Consumes: `listReviewItems`, `getReviewItemOrThrow`, `resolveReviewItem` from `../domain/crm/reviewQueue`; the existing `requireAdmin`, `parseBody`, `Router` idiom already in the file.
- Produces: three routes.

| Method | Path | Domain call |
|---|---|---|
| GET | `/api/v1/admin/crm/review` | `listReviewItems` — `?status=` query param, defaults `OPEN` |
| GET | `/api/v1/admin/crm/review/{reviewItemId}` | `getReviewItemOrThrow` |
| PUT | `/api/v1/admin/crm/review/{reviewItemId}/resolve` | `resolveReviewItem` |

**Context for the implementer:** Copy the shape of the case routes already in this file exactly — `requireAdmin(requestContext)` as the **first statement** in every handler, tenant from `DEFAULT_TENANT_ID`, body through `parseBody`, and domain errors left to propagate so the router maps them to status codes. **PUT, not PATCH**: the CDK route declares GET/POST/PUT/DELETE only, so a PATCH route would pass every test here and then 404 in deployment.

An unrecognised `?status=` value is a `badRequest`, not a silent fallback to `OPEN` — a typo that quietly returns the wrong queue is worse than an error.

- [ ] **Step 1: Write the failing test**

Add to `services/api/test/crm/crmApi.test.ts`, following the existing `call(...)` helper idiom in that file:

```ts
  it("lists open review items and resolves one", async () => {
    const context = buildTestContext();
    const router = buildCrmRouter(context);
    const recorded = await recordReviewItem(context, "rgs", {
      reason: "UNMAPPED_STATUS",
      sourceSheet: "Mini CRM",
      sourceRow: 42,
      caseRef: "31376",
      fieldName: "Status",
      rawValue: "DEU/DEL/190126/",
    });

    const listed = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).items).toHaveLength(1);

    const resolved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" },
    );
    expect(resolved.statusCode).toBe(200);
    expect(JSON.parse(resolved.body).reviewStatus).toBe("APPLIED");

    const afterResolve = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(JSON.parse(afterResolve.body).items).toHaveLength(0);
  });

  it("rejects an unknown review status with a 400 rather than silently listing OPEN", async () => {
    const context = buildTestContext();
    const router = buildCrmRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/review?status=NONSENSE");
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown review item", async () => {
    const context = buildTestContext();
    const router = buildCrmRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/review/nope");
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unauthenticated caller on the review routes", async () => {
    const context = buildTestContext();
    const router = buildCrmRouter(context);
    const response = await callUnauthenticated(router, "GET", "/api/v1/admin/crm/review");
    expect(response.statusCode).toBe(403);
  });
```

Reuse the `callUnauthenticated` helper added in Plan 2's fix round; if it is named differently in the file, use the existing name rather than adding a second helper.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/api test crmApi`
Expected: FAIL — 404 from the router, because no `/crm/review` route is registered.

- [ ] **Step 3: Write the implementation**

Add the import and three routes to `services/api/src/http/crmApi.ts`:

```ts
import {
  getReviewItemOrThrow,
  listReviewItems,
  resolveReviewItem,
} from "../domain/crm/reviewQueue";

const ResolveReviewItemBody = z.object({
  reviewStatus: z.enum(["APPLIED", "DISMISSED"]),
  resolvedValue: z.string().min(1).optional(),
});
```

```ts
    .add("GET", "/api/v1/admin/crm/review", async (requestContext) => {
      requireAdmin(requestContext);
      const requestedStatus = requestContext.queryParams["status"] ?? "OPEN";
      const parsedStatus = crm.REVIEW_STATUSES.find((status) => status === requestedStatus);
      if (parsedStatus === undefined) {
        throw badRequest(`Unknown review status: ${requestedStatus}`);
      }
      const items = await listReviewItems(context, DEFAULT_TENANT_ID, parsedStatus);
      return { statusCode: 200, body: JSON.stringify({ items }) };
    })
    .add("GET", "/api/v1/admin/crm/review/{reviewItemId}", async (requestContext) => {
      requireAdmin(requestContext);
      const reviewItem = await getReviewItemOrThrow(
        context,
        DEFAULT_TENANT_ID,
        requestContext.pathParams["reviewItemId"]!,
      );
      return { statusCode: 200, body: JSON.stringify(reviewItem) };
    })
    .add("PUT", "/api/v1/admin/crm/review/{reviewItemId}/resolve", async (requestContext) => {
      requireAdmin(requestContext);
      const resolution = parseBody(ResolveReviewItemBody, requestContext.body);
      const resolvedItem = await resolveReviewItem(
        context,
        DEFAULT_TENANT_ID,
        requestContext.pathParams["reviewItemId"]!,
        resolution,
        requestContext.callerEmail,
      );
      return { statusCode: 200, body: JSON.stringify(resolvedItem) };
    })
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/api test crmApi` — PASS.
Then `pnpm --filter @rgs/api test` and `pnpm -r typecheck`.

- [ ] **Step 5: Confirm no infrastructure change is needed**

Run: `grep -n '"PATCH"' services/api/src/http/crmApi.ts`
Expected: no matches. If there is one, change that route to PUT — it would 404 in deployment.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/http/crmApi.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(crm): expose the migration review queue on the admin API"
```

---

### Task 5: The `services/migration` package and the Excel serial converter

**Files:**
- Create: `services/migration/package.json`, `services/migration/tsconfig.json`, `services/migration/vitest.config.ts`
- Create: `services/migration/src/excelSerial.ts`
- Test: `services/migration/test/excelSerial.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EXCEL_EPOCH_UTC: Date` — `1899-12-30T00:00:00.000Z`
  - `excelSerialToIsoDate(serialValue: number): string | null`
  - `isExcelSerialCandidate(rawValue: unknown): rawValue is number`

**Context for the implementer:** This package exists so `exceljs` never enters the Lambda bundle. Nothing in `services/api` may import it; the dependency arrow points one way only.

The epoch is **not a guess** and must not be changed. It was determined empirically: REF NO 31376 carries `Sub Date` as the serial `45657` on the `2025 YEAR` sheet and as the text `12/31/2024` on `Mini CRM`. `1899-12-30 + 45657 days = 2024-12-31`, which matches; the 1904 system yields 2029-01-01, which does not. Getting this wrong silently shifts every date on a 6,546-row sheet by five years, and nothing downstream would notice.

`excelSerialToIsoDate` returns `null` rather than throwing for values outside the plausible window, so the caller can route them to the review queue with the rest of the unparseable dates. The window matches `normalizeExcelDate`'s: 2020-2027 inclusive.

- [ ] **Step 1: Create the package scaffold**

`services/migration/package.json`:

```json
{
  "name": "@rgs/migration",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "import": "node --experimental-strip-types src/cli.ts"
  },
  "dependencies": {
    "@rgs/shared": "workspace:*",
    "@rgs/api": "workspace:*",
    "exceljs": "^4.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`services/migration/tsconfig.json` — copy `services/api/tsconfig.json` verbatim and adjust only the paths it contains. Do not invent new compiler options; the base config already sets `strict` and `noUncheckedIndexedAccess`.

`services/migration/vitest.config.ts` — copy `services/api/vitest.config.ts` verbatim.

Then run `pnpm install` from the repo root to link the workspace.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { excelSerialToIsoDate, isExcelSerialCandidate } from "../src/excelSerial";

describe("excelSerialToIsoDate", () => {
  it("uses the 1900 epoch, proven against a row present on both sheets", () => {
    // REF NO 31376: "2025 YEAR" Sub Date serial 45657, "Mini CRM" text "12/31/2024".
    expect(excelSerialToIsoDate(45657)).toBe("2024-12-31");
  });

  it("converts a second known serial from the same row", () => {
    expect(excelSerialToIsoDate(45931)).toBe("2025-10-01");
  });

  it("would NOT produce the right answer under the 1904 epoch", () => {
    // Guards the epoch constant against a well-meaning edit.
    expect(excelSerialToIsoDate(45657)).not.toBe("2029-01-01");
  });

  it("truncates a fractional serial to its date part", () => {
    expect(excelSerialToIsoDate(45657.75)).toBe("2024-12-31");
  });

  it("returns null outside the plausible business window", () => {
    expect(excelSerialToIsoDate(1)).toBeNull();       // 1899
    expect(excelSerialToIsoDate(60000)).toBeNull();   // 2064
  });

  it("recognises only finite numbers as serial candidates", () => {
    expect(isExcelSerialCandidate(45657)).toBe(true);
    expect(isExcelSerialCandidate("45657")).toBe(false);
    expect(isExcelSerialCandidate(Number.NaN)).toBe(false);
    expect(isExcelSerialCandidate(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm --filter @rgs/migration test`
Expected: FAIL — `Failed to load url ../src/excelSerial`.

- [ ] **Step 4: Write the implementation**

```ts
/**
 * Excel's 1900 date system, expressed as the day-zero anchor: serial 1 is
 * 1900-01-01, and the system's phantom 1900-02-29 makes 1899-12-30 the
 * arithmetic base.
 *
 * DETERMINED EMPIRICALLY, NOT ASSUMED. REF NO 31376 appears on both sheets:
 * "2025 YEAR" stores Sub Date as the serial 45657, "Mini CRM" stores it as
 * the text "12/31/2024". 1899-12-30 + 45657 days = 2024-12-31, which agrees.
 * The 1904 system gives 2029-01-01, which does not. Do not change this
 * without re-running that cross-sheet check.
 */
export const EXCEL_EPOCH_UTC = new Date(Date.UTC(1899, 11, 30));

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
/** Matches normalizeExcelDate's window so both paths agree on what is plausible. */
const EARLIEST_PLAUSIBLE_YEAR = 2020;
const LATEST_PLAUSIBLE_YEAR = 2027;

export function isExcelSerialCandidate(rawValue: unknown): rawValue is number {
  return typeof rawValue === "number" && Number.isFinite(rawValue);
}

export function excelSerialToIsoDate(serialValue: number): string | null {
  if (!Number.isFinite(serialValue)) {
    return null;
  }
  const wholeDays = Math.trunc(serialValue);
  const converted = new Date(EXCEL_EPOCH_UTC.getTime() + wholeDays * MILLISECONDS_PER_DAY);
  const year = converted.getUTCFullYear();
  if (year < EARLIEST_PLAUSIBLE_YEAR || year > LATEST_PLAUSIBLE_YEAR) {
    return null;
  }
  const month = String(converted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(converted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @rgs/migration test` — PASS, 6 tests.
Then `pnpm -r typecheck` — the new package must typecheck alongside the existing five.

- [ ] **Step 6: Commit**

```bash
git add services/migration pnpm-lock.yaml
git commit -m "feat(migration): add the migration package and the Excel serial converter"
```

---

### Task 6: Workbook reader

**Files:**
- Create: `services/migration/src/readWorkbook.ts`
- Test: `services/migration/test/readWorkbook.test.ts`
- Test fixture: `services/migration/test/fixtures/buildFixtureWorkbook.ts`

**Interfaces:**
- Consumes: `excelSerialToIsoDate`, `isExcelSerialCandidate` from `./excelSerial`.
- Produces:
  - `interface RawMiniCrmRow { sourceRow: number; receivedDateRaw: string; caseRef: string; applicantsName: string; applicantCount: string; partnerName: string; country: string; dateOfBirthRaw: string; subDateRaw: string; collectionRaw: string; passportNumber: string; entries: string; visaType: string; status: string; additionalItems: string }`
  - `interface RawYearRow { sourceRow: number; caseRef: string; phoneRaw: string; trackingNumber: string }`
  - `interface WorkbookExtract { miniCrmRows: RawMiniCrmRow[]; yearRows: RawYearRow[] }`
  - `readWorkbook(workbookPath: string): Promise<WorkbookExtract>`
  - `normaliseCellText(rawCellValue: unknown): string`
  - `normaliseRefNo(rawCellValue: unknown): string`

**Context for the implementer:** Three traps live in this file, and every one of them is silent if you get it wrong.

1. **Read by column position, never by header text.** On `2025 YEAR`, the header of column E literally reads `China` — somebody typed a country into the header cell. Keying on header names would drop or misroute that column.
2. **Convert serials here, at the reader boundary.** `Mini CRM` stores dates as text; `2025 YEAR` stores them as numeric serials. `normalizeExcelDate` in `@rgs/shared` explicitly refuses serials and routes them to review — so feeding it raw serials would send all 6,546 `2025 YEAR` rows to the queue. When a cell is a serial candidate, convert it with `excelSerialToIsoDate` and emit the ISO string; otherwise pass the text through untouched.
3. **`REF NO.` and `No.` arrive as floats** — `31376.0`, `3.0`. `normaliseRefNo` must yield `"31376"`. Case identity is keyed on this string, so `"31376"` and `"31376.0"` being different would break idempotency and re-import every row on the second run.

`sourceRow` is the 1-based worksheet row number, so row 2 is the first data row. It is stored on every record for provenance (spec §9) and must be the real sheet row, not an array index.

Build the fixture workbook programmatically with `exceljs` rather than committing a binary `.xlsx` — a generated fixture can encode exactly the traps above and stays reviewable in a diff.

- [ ] **Step 1: Write the fixture builder**

```ts
import ExcelJS from "exceljs";

/**
 * Builds a workbook reproducing the real file's traps: text dates on
 * "Mini CRM", serial dates and a mislabeled column-E header on "2025 YEAR",
 * and float-formatted REF NO / No. values on both.
 */
export async function buildFixtureWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const miniCrm = workbook.addWorksheet("Mini CRM");
  miniCrm.addRow(["C","REF NO.","APPLICANTS NAME","No.","REFRENCE","Country","DOB","Sub Date","Collection","Passport No.","Entries","Visa Type","Status","Additional Items"]);
  miniCrm.addRow(["30-12-2024", 31376, "AKSHAY JAIN", 3, "Sudiva Spinners Pvt Ltd", "Turkey", "", "12/31/2024", 45931, "V2404480", "Single", "Business", "Handover", "PHOTO, HOTEL"]);
  miniCrm.addRow(["02-01-2025", 31377, "MEERA IYER", 1, "VWI Mumbai", "Vietnam", "", "05/01/2025", "", "M1234567", "Multiple 1 Yr", "Tourist", "Approved", ""]);
  miniCrm.addRow(["03-01-2025", 31378, "RAVI NAIR", 1, "VWI BOM", "Czech Group", "", "aposttile", "", "", "Business", "Attestation", "DEU/DEL/190126/", ""]);

  // Column E's header really is "China" in the source file.
  const yearSheet = workbook.addWorksheet("2025 YEAR");
  yearSheet.addRow(["DATE","REF NO.","APPLICANTS NAME","REFRENCE","China","DOB","No.","Sub Date","Collection","Phone","TRACKING NO.","Passport No.","Visa Type","Entries"]);
  yearSheet.addRow(["30-12-2024", 31376, "AKSHAY JAIN", "Sudiva Spinners Pvt Ltd", "Turkey", "", 3, 45657, 45931, 723001238, "DTDC9911", "V2404480", "Business", "Single"]);
  yearSheet.addRow(["02-01-2025", 31377, "MEERA IYER", "VWI Mumbai", "Vietnam", "", 1, 45658, "", 9812345670, "", "M1234567", "Tourist", "Multiple 1 Yr"]);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFixtureWorkbook } from "./fixtures/buildFixtureWorkbook";
import { normaliseRefNo, readWorkbook, type WorkbookExtract } from "../src/readWorkbook";

let extract: WorkbookExtract;

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "rgs-migration-"));
  const workbookPath = join(directory, "fixture.xlsx");
  await writeFile(workbookPath, await buildFixtureWorkbook());
  extract = await readWorkbook(workbookPath);
});

describe("readWorkbook", () => {
  it("reads every Mini CRM data row and numbers them by sheet row", () => {
    expect(extract.miniCrmRows).toHaveLength(3);
    expect(extract.miniCrmRows[0]!.sourceRow).toBe(2);
    expect(extract.miniCrmRows[2]!.sourceRow).toBe(4);
  });

  it("strips the float formatting from REF NO so case identity is stable", () => {
    expect(extract.miniCrmRows[0]!.caseRef).toBe("31376");
    expect(extract.miniCrmRows[0]!.applicantCount).toBe("3");
    expect(normaliseRefNo(31376)).toBe("31376");
    expect(normaliseRefNo("31376.0")).toBe("31376");
  });

  it("passes Mini CRM text dates through untouched", () => {
    expect(extract.miniCrmRows[0]!.subDateRaw).toBe("12/31/2024");
  });

  it("converts 2025 YEAR serial dates at the reader boundary", () => {
    // Without this the shared date normalizer refuses serials and every
    // row on this sheet would land in the review queue.
    expect(extract.yearRows).toHaveLength(2);
    expect(extract.miniCrmRows[0]!.collectionRaw).toBe("2025-10-01");
  });

  it("reads 2025 YEAR by position despite the column-E header saying 'China'", () => {
    expect(extract.yearRows[0]!.caseRef).toBe("31376");
    expect(extract.yearRows[0]!.trackingNumber).toBe("DTDC9911");
  });

  it("expands a scientific-notation phone back to digits", () => {
    expect(extract.yearRows[0]!.phoneRaw).toBe("723001238");
    expect(extract.yearRows[1]!.phoneRaw).toBe("9812345670");
  });

  it("returns empty strings for blank cells rather than undefined", () => {
    expect(extract.miniCrmRows[1]!.collectionRaw).toBe("");
    expect(extract.miniCrmRows[1]!.additionalItems).toBe("");
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm --filter @rgs/migration test readWorkbook`
Expected: FAIL — `Failed to load url ../src/readWorkbook`.

- [ ] **Step 4: Write the implementation**

```ts
import ExcelJS from "exceljs";
import { excelSerialToIsoDate, isExcelSerialCandidate } from "./excelSerial";

export interface RawMiniCrmRow {
  sourceRow: number;
  receivedDateRaw: string;
  caseRef: string;
  applicantsName: string;
  applicantCount: string;
  partnerName: string;
  country: string;
  dateOfBirthRaw: string;
  subDateRaw: string;
  collectionRaw: string;
  passportNumber: string;
  entries: string;
  visaType: string;
  status: string;
  additionalItems: string;
}

export interface RawYearRow {
  sourceRow: number;
  caseRef: string;
  phoneRaw: string;
  trackingNumber: string;
}

export interface WorkbookExtract {
  miniCrmRows: RawMiniCrmRow[];
  yearRows: RawYearRow[];
}

export const MINI_CRM_SHEET_NAME = "Mini CRM";
export const YEAR_SHEET_NAME = "2025 YEAR";

/**
 * Cells arrive as strings, numbers, Dates, or rich-text objects depending on
 * how the value was entered. Everything becomes trimmed text; a numeric value
 * that looks like a date serial is converted here, at the boundary, because
 * the shared date normalizer deliberately refuses serials.
 */
export function normaliseCellText(rawCellValue: unknown): string {
  if (rawCellValue === null || rawCellValue === undefined) {
    return "";
  }
  if (rawCellValue instanceof Date) {
    return rawCellValue.toISOString().slice(0, 10);
  }
  if (typeof rawCellValue === "object" && "text" in rawCellValue) {
    return String((rawCellValue as { text: unknown }).text).trim();
  }
  if (typeof rawCellValue === "number") {
    return Number.isInteger(rawCellValue) ? String(rawCellValue) : String(rawCellValue);
  }
  return String(rawCellValue).trim();
}

/** A date cell: convert a serial, otherwise keep the text for the shared normalizer. */
function normaliseDateCell(rawCellValue: unknown): string {
  if (isExcelSerialCandidate(rawCellValue)) {
    return excelSerialToIsoDate(rawCellValue) ?? String(rawCellValue);
  }
  return normaliseCellText(rawCellValue);
}

/** `31376.0` and `"31376.0"` both become `"31376"`. Case identity depends on this. */
export function normaliseRefNo(rawCellValue: unknown): string {
  const text = normaliseCellText(rawCellValue);
  if (text === "") {
    return "";
  }
  const numericValue = Number(text);
  return Number.isFinite(numericValue) ? String(Math.trunc(numericValue)) : text;
}

/** Phones arrive as floats in scientific notation: 7.23001238E8. */
function normalisePhone(rawCellValue: unknown): string {
  if (typeof rawCellValue === "number" && Number.isFinite(rawCellValue)) {
    return String(Math.trunc(rawCellValue));
  }
  return normaliseCellText(rawCellValue);
}

export async function readWorkbook(workbookPath: string): Promise<WorkbookExtract> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);

  const miniCrmSheet = workbook.getWorksheet(MINI_CRM_SHEET_NAME);
  const yearSheet = workbook.getWorksheet(YEAR_SHEET_NAME);
  if (miniCrmSheet === undefined) {
    throw new Error(`Workbook has no "${MINI_CRM_SHEET_NAME}" sheet`);
  }

  const miniCrmRows: RawMiniCrmRow[] = [];
  miniCrmSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    // Columns are read by POSITION. The real file has unreliable headers.
    const cellAt = (columnNumber: number): unknown => row.getCell(columnNumber).value;
    const caseRef = normaliseRefNo(cellAt(2));
    if (caseRef === "") return; // a row with no REF NO carries no identity
    miniCrmRows.push({
      sourceRow: rowNumber,
      receivedDateRaw: normaliseDateCell(cellAt(1)),
      caseRef,
      applicantsName: normaliseCellText(cellAt(3)),
      applicantCount: normaliseRefNo(cellAt(4)),
      partnerName: normaliseCellText(cellAt(5)),
      country: normaliseCellText(cellAt(6)),
      dateOfBirthRaw: normaliseDateCell(cellAt(7)),
      subDateRaw: normaliseDateCell(cellAt(8)),
      collectionRaw: normaliseDateCell(cellAt(9)),
      passportNumber: normaliseCellText(cellAt(10)),
      entries: normaliseCellText(cellAt(11)),
      visaType: normaliseCellText(cellAt(12)),
      status: normaliseCellText(cellAt(13)),
      additionalItems: normaliseCellText(cellAt(14)),
    });
  });

  const yearRows: RawYearRow[] = [];
  yearSheet?.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cellAt = (columnNumber: number): unknown => row.getCell(columnNumber).value;
    const caseRef = normaliseRefNo(cellAt(2));
    if (caseRef === "") return;
    yearRows.push({
      sourceRow: rowNumber,
      caseRef,
      phoneRaw: normalisePhone(cellAt(10)),
      trackingNumber: normaliseCellText(cellAt(11)),
    });
  });

  return { miniCrmRows, yearRows };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm --filter @rgs/migration test readWorkbook` — PASS, 7 tests.
Then `pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add services/migration
git commit -m "feat(migration): read the workbook by column position with serial-date conversion"
```

---

### Task 7: Pass 1 — the deterministic row mapper

**Files:**
- Create: `services/migration/src/mapRow.ts`
- Test: `services/migration/test/mapRow.test.ts`

**Interfaces:**
- Consumes: `RawMiniCrmRow` from `./readWorkbook`; `crm.normalizeCountry`, `crm.normalizeEntries`, `crm.normalizeStatus`, `crm.normalizeVisaType`, `crm.normalizePartnerName`, `crm.normalizeExcelDate`, `crm.ReviewReason` from `@rgs/shared`.
- Produces:
  - `interface MappedRow { caseRef: string; sourceSheet: string; sourceRow: number; partnerName: string; travellerFullName: string; passportNumber?: string; applicantCount: number; caseDraft: MappedCaseDraft; reviewItems: PendingReviewItem[]; legacyRaw: Record<string, string> }`
  - `interface MappedCaseDraft { caseType: crm.CaseType; destinationCountry: string; visaType?: crm.VisaType; entryType?: crm.EntryType; processing?: crm.ProcessingSpeed; validity?: string; caseStatus: crm.CaseStatus; custody: crm.CustodyStatus; outcome: crm.ApplicantOutcome; courierMode?: crm.CourierMode; receivedDate?: string; submissionDate?: string; expectedCollectionDate?: string; note?: string }`
  - `interface PendingReviewItem { reason: crm.ReviewReason; fieldName: string; rawValue: string; proposedValue?: string; detail?: string }`
  - `mapRow(rawRow: RawMiniCrmRow): MappedRow`

**Context for the implementer:** This is spec §9's pass 1 and it is a **pure function** — no I/O, no database, no clock. That is what makes it testable against all 7,157 importable rows in a second.

The rules that decide review vs. accept:

- **Blank means "not recorded", not "needs review"** (spec §6). A blank cell produces no review item and no field. Only a value that is *present and unmappable* goes to the queue. Getting this backwards turns 4,648 rows (64.9%) into review items instead of 1,016 (14.2%) — measured.
- **Every normalizer already returns `needsReview`.** Trust it; do not second-guess with extra heuristics. Compose the Plan 1 normalizers and translate their `needsReview` into a `PendingReviewItem`.
- **Nothing is discarded.** Any column whose value could not be mapped onto a domain field is copied into `legacyRaw` keyed by its workbook column name, so it survives and a human can see it later.
- **A row always produces a `MappedRow`,** even when it also produces review items. A row with an unmappable `Status` still has a country, a partner and a traveller worth importing; the review item resolves the one field, it does not reject the row. Only a row with no usable `caseRef` is dropped, and the reader already excludes those.
- **Status is the axis-splitter.** `normalizeStatus` returns `caseStatus`, `custody`, `outcome`, `courierMode`, `caseTypeHint`, `lineItemHint` and `note` — the three axes come from one Excel column. When it yields no `caseStatus`, default to `NEW`; when it yields no `custody`, default to `NOT_HELD`; when it yields no `outcome`, default to `PENDING`. Those are the schema defaults and they mean "the sheet did not say".
- **`caseTypeHint` from Status wins over `Visa Type`** — `Payment Only` and `Documents attestation` sit in the Status column and describe what the case *is*, which the Visa Type column then contradicts.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mapRow } from "../src/mapRow";
import type { RawMiniCrmRow } from "../src/readWorkbook";

function buildRawRow(overrides: Partial<RawMiniCrmRow> = {}): RawMiniCrmRow {
  return {
    sourceRow: 2,
    receivedDateRaw: "30-12-2024",
    caseRef: "31376",
    applicantsName: "AKSHAY JAIN",
    applicantCount: "3",
    partnerName: "Sudiva Spinners Pvt Ltd",
    country: "Turkey",
    dateOfBirthRaw: "",
    subDateRaw: "31/12/2024",
    collectionRaw: "",
    passportNumber: "V2404480",
    entries: "Single",
    visaType: "Business",
    status: "Handover",
    additionalItems: "",
    ...overrides,
  };
}

describe("mapRow — pass 1", () => {
  it("maps a clean row with no review items", () => {
    const mapped = mapRow(buildRawRow());
    expect(mapped.reviewItems).toEqual([]);
    expect(mapped.caseRef).toBe("31376");
    expect(mapped.sourceRow).toBe(2);
    expect(mapped.caseDraft.destinationCountry).toBe("TR");
    expect(mapped.caseDraft.caseType).toBe("VISA");
    expect(mapped.caseDraft.visaType).toBe("BUSINESS");
    expect(mapped.caseDraft.entryType).toBe("SINGLE");
    expect(mapped.caseDraft.processing).toBe("NORMAL");
    expect(mapped.applicantCount).toBe(3);
  });

  it("splits one Status cell across all three axes", () => {
    // "Handover" is CLOSED + RETURNED per spec §6.
    const mapped = mapRow(buildRawRow({ status: "Handover" }));
    expect(mapped.caseDraft.caseStatus).toBe("CLOSED");
    expect(mapped.caseDraft.custody).toBe("RETURNED");
  });

  it("records an outcome that lives in the Status column", () => {
    const mapped = mapRow(buildRawRow({ status: "Approved" }));
    expect(mapped.caseDraft.caseStatus).toBe("DECIDED");
    expect(mapped.caseDraft.outcome).toBe("APPROVED");
  });

  it("treats a BLANK cell as not-recorded, never as a review item", () => {
    const mapped = mapRow(buildRawRow({ entries: "", subDateRaw: "", status: "" }));
    expect(mapped.reviewItems).toEqual([]);
    expect(mapped.caseDraft.entryType).toBeUndefined();
    expect(mapped.caseDraft.submissionDate).toBeUndefined();
    expect(mapped.caseDraft.caseStatus).toBe("NEW");
    expect(mapped.caseDraft.custody).toBe("NOT_HELD");
    expect(mapped.caseDraft.outcome).toBe("PENDING");
  });

  it("raises a review item for a PRESENT but unmappable status", () => {
    const mapped = mapRow(buildRawRow({ status: "DEU/DEL/190126/" }));
    const statusReview = mapped.reviewItems.find((item) => item.fieldName === "Status");
    expect(statusReview?.reason).toBe("UNMAPPED_STATUS");
    expect(statusReview?.rawValue).toBe("DEU/DEL/190126/");
  });

  it("raises a review item for an unparseable date but still maps the rest of the row", () => {
    const mapped = mapRow(buildRawRow({ subDateRaw: "aposttile" }));
    expect(mapped.reviewItems.some((item) => item.reason === "UNPARSEABLE_DATE")).toBe(true);
    expect(mapped.caseDraft.destinationCountry).toBe("TR");
    expect(mapped.caseDraft.submissionDate).toBeUndefined();
  });

  it("parses ambiguous dates day-first, matching the workbook's 3261:15 split", () => {
    expect(mapRow(buildRawRow({ subDateRaw: "05/01/2025" })).caseDraft.submissionDate).toBe("2025-01-05");
  });

  it("keeps unmapped columns in legacyRaw so nothing is discarded", () => {
    const mapped = mapRow(buildRawRow({ additionalItems: "PHOTO, HOTEL, GST NO" }));
    expect(mapped.legacyRaw["Additional Items"]).toBe("PHOTO, HOTEL, GST NO");
  });

  it("lets a caseType hint in the Status column beat the Visa Type column", () => {
    const mapped = mapRow(buildRawRow({ status: "Documents attestation", visaType: "Tourist" }));
    expect(mapped.caseDraft.caseType).toBe("ATTESTATION");
  });

  it("defaults a missing applicant count to 1 rather than 0", () => {
    expect(mapRow(buildRawRow({ applicantCount: "" })).applicantCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/migration test mapRow`
Expected: FAIL — `Failed to load url ../src/mapRow`.

- [ ] **Step 3: Write the implementation**

```ts
import { crm } from "@rgs/shared";
import type { RawMiniCrmRow } from "./readWorkbook";

export interface PendingReviewItem {
  reason: crm.ReviewReason;
  fieldName: string;
  rawValue: string;
  proposedValue?: string;
  detail?: string;
}

export interface MappedCaseDraft {
  caseType: crm.CaseType;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  validity?: string;
  caseStatus: crm.CaseStatus;
  custody: crm.CustodyStatus;
  outcome: crm.ApplicantOutcome;
  courierMode?: crm.CourierMode;
  receivedDate?: string;
  submissionDate?: string;
  expectedCollectionDate?: string;
  note?: string;
}

export interface MappedRow {
  caseRef: string;
  sourceSheet: string;
  sourceRow: number;
  partnerName: string;
  travellerFullName: string;
  passportNumber?: string;
  applicantCount: number;
  caseDraft: MappedCaseDraft;
  reviewItems: PendingReviewItem[];
  legacyRaw: Record<string, string>;
}

const MINI_CRM_SHEET_NAME = "Mini CRM";

function isBlank(rawValue: string): boolean {
  return rawValue.trim() === "";
}

/**
 * Spec §6: a blank cell means the sheet did not record the value. It is not
 * a defect and must never become a review item — treating blanks as review
 * items turns 64.9% of rows into queue entries instead of 14.2%.
 */
function mapDateField(
  rawValue: string,
  fieldName: string,
  reviewItems: PendingReviewItem[],
): string | undefined {
  if (isBlank(rawValue)) {
    return undefined;
  }
  // The reader has already converted Excel serials to ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue;
  }
  const normalized = crm.normalizeExcelDate(rawValue);
  if (normalized.isoDate === null) {
    reviewItems.push({ reason: "UNPARSEABLE_DATE", fieldName, rawValue });
    return undefined;
  }
  return normalized.isoDate;
}

export function mapRow(rawRow: RawMiniCrmRow): MappedRow {
  const reviewItems: PendingReviewItem[] = [];
  const legacyRaw: Record<string, string> = {};

  const country = crm.normalizeCountry(rawRow.country);
  if (!isBlank(rawRow.country) && country.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_COUNTRY", fieldName: "Country", rawValue: rawRow.country });
  }

  const visaTypeResult = crm.normalizeVisaType(rawRow.visaType);
  if (!isBlank(rawRow.visaType) && visaTypeResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_VISA_TYPE", fieldName: "Visa Type", rawValue: rawRow.visaType });
  }

  const entriesResult = crm.normalizeEntries(rawRow.entries);
  if (!isBlank(rawRow.entries) && entriesResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_ENTRIES", fieldName: "Entries", rawValue: rawRow.entries });
  }

  const statusResult = crm.normalizeStatus(rawRow.status);
  if (!isBlank(rawRow.status) && statusResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: rawRow.status });
  }

  const partnerResult = crm.normalizePartnerName(rawRow.partnerName);
  if (!isBlank(rawRow.partnerName) && partnerResult.needsReview) {
    reviewItems.push({ reason: "UNMAPPED_PARTNER", fieldName: "REFRENCE", rawValue: rawRow.partnerName });
  }

  // A caseType named in the Status column describes what the case IS and
  // beats the Visa Type column, which often contradicts it.
  const caseType: crm.CaseType = statusResult.caseTypeHint ?? visaTypeResult.caseType ?? "OTHER";

  if (!isBlank(rawRow.additionalItems)) {
    legacyRaw["Additional Items"] = rawRow.additionalItems;
  }
  if (statusResult.lineItemHint !== null) {
    legacyRaw["Status line item"] = statusResult.lineItemHint;
  }
  if (!isBlank(rawRow.dateOfBirthRaw)) {
    legacyRaw["DOB"] = rawRow.dateOfBirthRaw;
  }

  const parsedApplicantCount = Number(rawRow.applicantCount);
  const applicantCount =
    Number.isFinite(parsedApplicantCount) && parsedApplicantCount >= 1 ? Math.trunc(parsedApplicantCount) : 1;

  const caseDraft: MappedCaseDraft = {
    caseType,
    destinationCountry: country.countryCode ?? "",
    ...(visaTypeResult.visaType !== null ? { visaType: visaTypeResult.visaType } : {}),
    ...(entriesResult.entryType !== null ? { entryType: entriesResult.entryType } : {}),
    ...(entriesResult.processing !== null ? { processing: entriesResult.processing } : {}),
    ...(entriesResult.validity !== null ? { validity: entriesResult.validity } : {}),
    caseStatus: statusResult.caseStatus ?? "NEW",
    custody: statusResult.custody ?? "NOT_HELD",
    outcome: statusResult.outcome ?? "PENDING",
    ...(statusResult.courierMode !== null ? { courierMode: statusResult.courierMode } : {}),
    ...(statusResult.note !== null ? { note: statusResult.note } : {}),
  };

  const receivedDate = mapDateField(rawRow.receivedDateRaw, "C", reviewItems);
  if (receivedDate !== undefined) caseDraft.receivedDate = receivedDate;
  const submissionDate = mapDateField(rawRow.subDateRaw, "Sub Date", reviewItems);
  if (submissionDate !== undefined) caseDraft.submissionDate = submissionDate;
  const collectionDate = mapDateField(rawRow.collectionRaw, "Collection", reviewItems);
  if (collectionDate !== undefined) caseDraft.expectedCollectionDate = collectionDate;

  return {
    caseRef: rawRow.caseRef,
    sourceSheet: MINI_CRM_SHEET_NAME,
    sourceRow: rawRow.sourceRow,
    partnerName: rawRow.partnerName,
    travellerFullName: rawRow.applicantsName,
    ...(isBlank(rawRow.passportNumber) ? {} : { passportNumber: rawRow.passportNumber }),
    applicantCount,
    caseDraft,
    reviewItems,
    legacyRaw,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/migration test mapRow` — PASS, 10 tests.
Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add services/migration/src/mapRow.ts services/migration/test/mapRow.test.ts
git commit -m "feat(migration): add the deterministic pass-1 row mapper"
```

---

### Task 8: The Plan 4 seam, phone join, and group detection

**Files:**
- Create: `services/migration/src/residueResolver.ts`
- Create: `services/migration/src/joinPhones.ts`
- Create: `services/migration/src/groupCases.ts`
- Test: `services/migration/test/residueResolver.test.ts`, `services/migration/test/joinPhones.test.ts`, `services/migration/test/groupCases.test.ts`

**Interfaces:**
- Consumes: `MappedRow`, `PendingReviewItem` from `./mapRow`; `RawYearRow` from `./readWorkbook`.
- Produces:
  - `interface ResidueResolution { fieldName: string; proposedValue: string; confidence: number }`
  - `interface ResidueResolver { resolve(row: MappedRow, pending: PendingReviewItem[]): Promise<ResidueResolution[]> }`
  - `const passthroughResidueResolver: ResidueResolver` — resolves nothing
  - `joinPhones(mappedRows: MappedRow[], yearRows: RawYearRow[]): Map<string, { phone?: string; trackingNumber?: string }>`
  - `interface ProposedGroup { caseRefs: string[]; partnerName: string; destinationCountry: string; receivedDate: string }`
  - `proposeGroups(mappedRows: MappedRow[]): ProposedGroup[]`

**Context for the implementer:** Three small, independent pieces; they share a task because none is worth its own review cycle.

`residueResolver.ts` is **the seam for spec §9's pass 2**. Plan 4 supplies an LLM-backed implementation; this plan ships only the interface and a pass-through that resolves nothing, so the importer's wiring is already correct when Plan 4 arrives. Do **not** call a model here, and do not add a provider dependency — the whole point is that this plan has no LLM in it.

`joinPhones` implements spec §9's "phone numbers are recovered from `2025 YEAR` by REF NO join, since `Mini CRM` dropped that column". An Indian mobile is 10 digits starting 6-9; anything else is kept but flagged, because the source stores phones as floats and a leading zero may already be lost.

`proposeGroups` implements spec §9's group detection: same partner + country + received date + **adjacent** REF NO. It **proposes only** — the spec is explicit that groupings are reviewed, never auto-applied. Return the proposals; the importer turns them into `PROPOSED_GROUP` review items.

- [ ] **Step 1: Write the failing tests**

`residueResolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { passthroughResidueResolver } from "../src/residueResolver";

describe("passthroughResidueResolver", () => {
  it("resolves nothing, so pass-1 residue flows to the human queue", async () => {
    const resolutions = await passthroughResidueResolver.resolve(
      { caseRef: "1" } as never,
      [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "???" }],
    );
    expect(resolutions).toEqual([]);
  });
});
```

`joinPhones.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { joinPhones } from "../src/joinPhones";
import type { MappedRow } from "../src/mapRow";

const rowFor = (caseRef: string) => ({ caseRef }) as MappedRow;

describe("joinPhones", () => {
  it("recovers a phone from the 2025 YEAR sheet by REF NO", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [{ sourceRow: 2, caseRef: "31376", phoneRaw: "9812345670", trackingNumber: "DTDC9911" }],
    );
    expect(joined.get("31376")).toEqual({ phone: "9812345670", trackingNumber: "DTDC9911" });
  });

  it("omits a phone that is not a plausible Indian mobile but keeps the tracking number", () => {
    const joined = joinPhones(
      [rowFor("31376")],
      [{ sourceRow: 2, caseRef: "31376", phoneRaw: "723001238", trackingNumber: "X1" }],
    );
    expect(joined.get("31376")?.phone).toBeUndefined();
    expect(joined.get("31376")?.trackingNumber).toBe("X1");
  });

  it("ignores year rows with no matching case", () => {
    const joined = joinPhones([rowFor("31376")], [{ sourceRow: 2, caseRef: "99999", phoneRaw: "9812345670", trackingNumber: "" }]);
    expect(joined.has("99999")).toBe(false);
  });
});
```

`groupCases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { proposeGroups } from "../src/groupCases";
import type { MappedRow } from "../src/mapRow";

function rowFor(caseRef: string, receivedDate: string, partnerName = "VWI Mumbai"): MappedRow {
  return {
    caseRef,
    partnerName,
    caseDraft: { destinationCountry: "TR", receivedDate },
  } as MappedRow;
}

describe("proposeGroups", () => {
  it("proposes adjacent REF NOs sharing partner, country and received date", () => {
    const proposals = proposeGroups([
      rowFor("31376", "2025-01-02"),
      rowFor("31377", "2025-01-02"),
      rowFor("31378", "2025-01-02"),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.caseRefs).toEqual(["31376", "31377", "31378"]);
  });

  it("does not group non-adjacent REF NOs", () => {
    expect(proposeGroups([rowFor("31376", "2025-01-02"), rowFor("31380", "2025-01-02")])).toEqual([]);
  });

  it("does not group across different partners", () => {
    expect(
      proposeGroups([rowFor("31376", "2025-01-02", "VWI Mumbai"), rowFor("31377", "2025-01-02", "Other Agency")]),
    ).toEqual([]);
  });

  it("does not group rows with no received date", () => {
    expect(proposeGroups([rowFor("31376", ""), rowFor("31377", "")])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @rgs/migration test`
Expected: three FAILs, one per missing module.

- [ ] **Step 3: Write the implementations**

`residueResolver.ts`:

```ts
import type { MappedRow, PendingReviewItem } from "./mapRow";

export interface ResidueResolution {
  fieldName: string;
  proposedValue: string;
  /** 0..1. Spec §9: >= 0.9 auto-applies, below goes to review. */
  confidence: number;
}

/**
 * Spec §9 pass 2. Plan 4's agent layer supplies the LLM-backed
 * implementation; this plan ships only the seam so the importer's wiring is
 * already correct when it arrives. Deliberately no model and no provider
 * dependency here.
 */
export interface ResidueResolver {
  resolve(row: MappedRow, pending: PendingReviewItem[]): Promise<ResidueResolution[]>;
}

export const passthroughResidueResolver: ResidueResolver = {
  async resolve(): Promise<ResidueResolution[]> {
    return [];
  },
};
```

`joinPhones.ts`:

```ts
import type { MappedRow } from "./mapRow";
import type { RawYearRow } from "./readWorkbook";

export interface JoinedContactDetails {
  phone?: string;
  trackingNumber?: string;
}

/** An Indian mobile is 10 digits starting 6-9. The sheet stores phones as
 *  floats, so a leading zero may already be lost — anything else is dropped
 *  rather than stored as a number nobody can call. */
function isPlausibleIndianMobile(phoneDigits: string): boolean {
  return /^[6-9]\d{9}$/.test(phoneDigits);
}

export function joinPhones(
  mappedRows: MappedRow[],
  yearRows: RawYearRow[],
): Map<string, JoinedContactDetails> {
  const knownCaseRefs = new Set(mappedRows.map((mappedRow) => mappedRow.caseRef));
  const joined = new Map<string, JoinedContactDetails>();

  for (const yearRow of yearRows) {
    if (!knownCaseRefs.has(yearRow.caseRef)) {
      continue;
    }
    const details: JoinedContactDetails = {};
    if (isPlausibleIndianMobile(yearRow.phoneRaw)) {
      details.phone = yearRow.phoneRaw;
    }
    if (yearRow.trackingNumber.trim() !== "") {
      details.trackingNumber = yearRow.trackingNumber.trim();
    }
    joined.set(yearRow.caseRef, details);
  }

  return joined;
}
```

`groupCases.ts`:

```ts
import type { MappedRow } from "./mapRow";

export interface ProposedGroup {
  caseRefs: string[];
  partnerName: string;
  destinationCountry: string;
  receivedDate: string;
}

/**
 * Spec §9: same partner + country + received date + adjacent REF NO numbers
 * are PROPOSED as one case. Proposals are reviewed, never auto-applied —
 * this function returns candidates and writes nothing.
 */
export function proposeGroups(mappedRows: MappedRow[]): ProposedGroup[] {
  const buckets = new Map<string, MappedRow[]>();

  for (const mappedRow of mappedRows) {
    const receivedDate = mappedRow.caseDraft.receivedDate;
    if (receivedDate === undefined || receivedDate === "") {
      continue; // no date, no basis for grouping
    }
    const bucketKey = `${mappedRow.partnerName}|${mappedRow.caseDraft.destinationCountry}|${receivedDate}`;
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [mappedRow]);
    } else {
      bucket.push(mappedRow);
    }
  }

  const proposals: ProposedGroup[] = [];
  for (const bucketRows of buckets.values()) {
    if (bucketRows.length < 2) {
      continue;
    }
    const sortedRows = [...bucketRows].sort((left, right) => Number(left.caseRef) - Number(right.caseRef));
    let runStart = 0;
    for (let position = 1; position <= sortedRows.length; position += 1) {
      const previousRef = Number(sortedRows[position - 1]!.caseRef);
      const currentRef = position < sortedRows.length ? Number(sortedRows[position]!.caseRef) : Number.NaN;
      const isAdjacent = currentRef === previousRef + 1;
      if (!isAdjacent) {
        const run = sortedRows.slice(runStart, position);
        if (run.length >= 2) {
          const firstRow = run[0]!;
          proposals.push({
            caseRefs: run.map((runRow) => runRow.caseRef),
            partnerName: firstRow.partnerName,
            destinationCountry: firstRow.caseDraft.destinationCountry,
            receivedDate: firstRow.caseDraft.receivedDate ?? "",
          });
        }
        runStart = position;
      }
    }
  }

  return proposals;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @rgs/migration test` — PASS, 8 new tests.
Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add services/migration/src services/migration/test
git commit -m "feat(migration): add the pass-2 seam, phone join and group proposals"
```

---

### Task 9: The import run — idempotent orchestration

**Files:**
- Create: `services/migration/src/importRun.ts`
- Test: `services/migration/test/importRun.test.ts`

**Interfaces:**
- Consumes: `MappedRow` from `./mapRow`; `JoinedContactDetails` from `./joinPhones`; `ProposedGroup` from `./groupCases`; `ResidueResolver` from `./residueResolver`; `writeCase`, `readCase` from `@rgs/api` domain `caseStore`; `createPartner`, `findPartnerByName` from `partners`; `upsertTraveller`, `findTravellerByPassport`, `findTravellerByName` from `travellers`; `recordReviewItem` from `reviewQueue`; `newId` from `lib/ids`.
- Produces:
  - `interface ImportSummary { rowsRead: number; casesCreated: number; casesSkippedAlreadyImported: number; partnersCreated: number; partnersReused: number; travellersCreated: number; travellersReused: number; reviewItemsRecorded: number; groupsProposed: number }`
  - `runImport(context: AppContext, tenantId: string, input: RunImportInput): Promise<ImportSummary>`
  - `interface RunImportInput { mappedRows: MappedRow[]; contactDetails: Map<string, JoinedContactDetails>; proposedGroups: ProposedGroup[]; residueResolver: ResidueResolver; actorEmail: string; dryRun: boolean }`

**Context for the implementer:** This is the only file in the package that writes. Four rules govern it, and each one has bitten a real migration:

1. **Idempotency is keyed on `caseRef`.** Before creating a case, look for an existing one with the same `caseRef` and skip it. The spec calls for a re-runnable script — running it twice must not double the ledger. Because `caseRef` has no index yet (a known gap carried from Plan 2), maintain an in-run `Set` of already-imported refs seeded from a `listCasesByStatus` sweep, and document that a `caseRef` index is Plan 5's job. **Do not add an index in this task** — it is a storage-format change that belongs with the screen that needs it.

2. **Write cases through `caseStore.writeCase` directly, never through the Plan 2 mutators.** `changeCaseStatus` / `changeApplicantCustody` / `changeBillingStatus` / `changeApplicantOutcome` all fire the derived-status rules, and spec §5 is explicit that migrated cases keep the status the import assigned and are never retroactively reopened. Going through the mutators would drag almost every historical case out of `CLOSED`, because the sheet fills payment status on 0.5% of rows.

3. **`billingStatus` is `UNKNOWN` for every migrated case.** Spec §5: migrated rows with no billing evidence import as `UNKNOWN`, which the `billing_overdue` watchdog excludes. Never default them to `UNBILLED`.

4. **Partners are found before they are created.** `createPartner` throws `conflict` on a duplicate canonical key (Plan 2 fix round), so calling it blindly would abort the run on the second row from the same agency. Call `findPartnerByName` first and reuse. Same shape for travellers: passport first, then name, then create.

`dryRun` performs every lookup and every mapping but no write, and returns the same summary. That is how the run is rehearsed against staging before it touches anything.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
import { readCase } from "@rgs/api/src/domain/crm/caseStore";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
import { listPartners } from "@rgs/api/src/domain/crm/partners";
import { runImport } from "../src/importRun";
import { passthroughResidueResolver } from "../src/residueResolver";
import type { MappedRow } from "../src/mapRow";

function buildMappedRow(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    caseRef: "31376",
    sourceSheet: "Mini CRM",
    sourceRow: 2,
    partnerName: "VWI Mumbai",
    travellerFullName: "AKSHAY JAIN",
    passportNumber: "V2404480",
    applicantCount: 1,
    caseDraft: {
      caseType: "VISA",
      destinationCountry: "TR",
      visaType: "BUSINESS",
      caseStatus: "CLOSED",
      custody: "RETURNED",
      outcome: "APPROVED",
    },
    reviewItems: [],
    legacyRaw: {},
    ...overrides,
  } as MappedRow;
}

const baseInput = {
  contactDetails: new Map(),
  proposedGroups: [],
  residueResolver: passthroughResidueResolver,
  actorEmail: "ops@rgs.test",
  dryRun: false,
};

describe("runImport", () => {
  it("imports a row into a case, partner and traveller", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });
    expect(summary.casesCreated).toBe(1);
    expect(summary.partnersCreated).toBe(1);
    expect(summary.travellersCreated).toBe(1);
  });

  it("is idempotent: a second run creates nothing", async () => {
    const context = buildTestContext();
    const rows = [buildMappedRow()];
    await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    const secondSummary = await runImport(context, "rgs", { ...baseInput, mappedRows: rows });
    expect(secondSummary.casesCreated).toBe(0);
    expect(secondSummary.casesSkippedAlreadyImported).toBe(1);
    expect(secondSummary.partnersCreated).toBe(0);
    expect(secondSummary.partnersReused).toBe(1);
  });

  it("reuses one partner across spelling variants instead of creating two", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({ caseRef: "1", partnerName: "VWI Mumbai" }),
        buildMappedRow({ caseRef: "2", partnerName: "VWI BOM", passportNumber: "X9999999" }),
      ],
    });
    expect(summary.partnersCreated).toBe(1);
    expect(summary.partnersReused).toBe(1);
    expect(await listPartners(context, "rgs")).toHaveLength(1);
  });

  it("imports every migrated case with UNKNOWN billing, never UNBILLED", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", { ...baseInput, mappedRows: [buildMappedRow()] });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    // Spec §5: migrated rows carry no billing evidence, and UNKNOWN is what
    // the billing_overdue watchdog excludes. UNBILLED would nag on all 7,157 imported cases.
    expect(importedCase!.billingStatus).toBe("UNKNOWN");
  });

  it("keeps provenance on every imported case so any value traces back", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow({ legacyRaw: { "Additional Items": "PHOTO, HOTEL" } })],
    });

    const importedCase = await readCase(context, "rgs", summary.createdCaseIds[0]!);
    expect(importedCase!.sourceSheet).toBe("Mini CRM");
    expect(importedCase!.sourceRow).toBe(2);
    expect(importedCase!.caseRef).toBe("31376");
    expect(importedCase!.legacyRaw).toEqual({ "Additional Items": "PHOTO, HOTEL" });
  });

  it("records pass-1 review items in the queue", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [
        buildMappedRow({
          reviewItems: [{ reason: "UNMAPPED_STATUS", fieldName: "Status", rawValue: "DEU/DEL/190126/" }],
        }),
      ],
    });
    expect(summary.reviewItemsRecorded).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open[0]!.rawValue).toBe("DEU/DEL/190126/");
    expect(open[0]!.sourceRow).toBe(2);
  });

  it("records proposed groups as review items rather than applying them", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      proposedGroups: [
        { caseRefs: ["31376", "31377"], partnerName: "VWI Mumbai", destinationCountry: "TR", receivedDate: "2025-01-02" },
      ],
    });
    expect(summary.groupsProposed).toBe(1);
    const open = await listReviewItems(context, "rgs", "OPEN");
    expect(open.some((item) => item.reason === "PROPOSED_GROUP")).toBe(true);
  });

  it("writes nothing on a dry run but still reports what it would do", async () => {
    const context = buildTestContext();
    const summary = await runImport(context, "rgs", {
      ...baseInput,
      mappedRows: [buildMappedRow()],
      dryRun: true,
    });
    expect(summary.casesCreated).toBe(1);
    expect(await listPartners(context, "rgs")).toHaveLength(0);
    expect(await listReviewItems(context, "rgs", "OPEN")).toHaveLength(0);
  });
});
```

Note that both the billing and provenance tests read the case back through `readCase` using `summary.createdCaseIds[0]`, so `ImportSummary` must carry `createdCaseIds` — it is in the interface for exactly this reason. Assert values against literals, never against a value re-read from the same call you are testing.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @rgs/migration test importRun`
Expected: FAIL — `Failed to load url ../src/importRun`.

- [ ] **Step 3: Write the implementation**

Key shape — the implementer fills in the body following the rules above:

```ts
export interface ImportSummary {
  rowsRead: number;
  casesCreated: number;
  casesSkippedAlreadyImported: number;
  partnersCreated: number;
  partnersReused: number;
  travellersCreated: number;
  travellersReused: number;
  reviewItemsRecorded: number;
  groupsProposed: number;
  createdCaseIds: string[];
}

export async function runImport(
  context: AppContext,
  tenantId: string,
  input: RunImportInput,
): Promise<ImportSummary> {
  // 1. Seed the already-imported set from existing cases (idempotency on caseRef).
  // 2. For each mapped row, in order:
  //    a. skip if caseRef already imported;
  //    b. resolve the partner: findPartnerByName -> reuse, else createPartner;
  //    c. resolve the traveller: findTravellerByPassport -> findTravellerByName -> upsertTraveller;
  //    d. offer the row's pending review items to input.residueResolver; a
  //       resolution with confidence >= 0.9 is applied to the draft, anything
  //       lower becomes a review item carrying proposedValue and confidence;
  //    e. build the CrmCase with billingStatus "UNKNOWN", sourceSheet,
  //       sourceRow and legacyRaw, and write it with caseStore.writeCase;
  //    f. record every remaining review item.
  // 3. Record each proposed group as a PROPOSED_GROUP review item.
  // 4. When input.dryRun is true, perform every lookup and mapping but no put.
}
```

Every write in the loop is guarded by `if (!input.dryRun)`. The counters increment regardless, so a dry run reports exactly what a real run would do.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @rgs/migration test importRun` — PASS, 8 tests.
Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add services/migration/src/importRun.ts services/migration/test/importRun.test.ts
git commit -m "feat(migration): add the idempotent import run"
```

---

### Task 10: CLI, full-workbook rehearsal, and the green gate

**Files:**
- Create: `services/migration/src/cli.ts`
- Create: `services/migration/README.md`
- Modify: `README.md`
- Test: `services/migration/test/fullWorkbook.test.ts` (skipped unless the workbook is present)

**Interfaces:**
- Consumes: everything from Tasks 5-9.
- Produces: nothing consumed by later tasks. This is the merge gate.

**Context for the implementer:** The CLI is the operator's entry point. It must default to `--dry-run` — an import that writes to a real table on a mistyped command is exactly the accident this guard prevents. Writing requires an explicit `--commit`.

The full-workbook test is the one that matters: it runs all 7,157 importable rows through `readWorkbook` + `mapRow` and asserts the review-queue rate is in the expected band. It **skips** rather than fails when the workbook is absent, because the file lives outside the repo (`/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx`) and CI will not have it.

- [ ] **Step 1: Write the CLI**

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readWorkbook } from "./readWorkbook";
import { mapRow } from "./mapRow";
import { joinPhones } from "./joinPhones";
import { proposeGroups } from "./groupCases";
import { passthroughResidueResolver } from "./residueResolver";
import { runImport } from "./importRun";

const { values } = parseArgs({
  options: {
    workbook: { type: "string" },
    tenant: { type: "string", default: "rgs" },
    actor: { type: "string", default: "migration@rgs.local" },
    commit: { type: "boolean", default: false },
  },
});

if (values.workbook === undefined) {
  console.error("usage: pnpm --filter @rgs/migration import --workbook <path.xlsx> [--commit]");
  process.exit(1);
}

// Writing is opt-in. A mistyped command must never touch a real table.
const dryRun = !values.commit;
console.log(dryRun ? "DRY RUN — nothing will be written. Pass --commit to write." : "COMMITTING to the table.");

const extract = await readWorkbook(values.workbook);
const mappedRows = extract.miniCrmRows.map(mapRow);
const summary = await runImport(buildProductionContext(), values.tenant, {
  mappedRows,
  contactDetails: joinPhones(mappedRows, extract.yearRows),
  proposedGroups: proposeGroups(mappedRows),
  residueResolver: passthroughResidueResolver,
  actorEmail: values.actor,
  dryRun,
});

console.table(summary);
```

`buildProductionContext()` builds an `AppContext` around `DynamoTableClient` using `TABLE_NAME` from the environment — follow how the Lambda handler in `services/api/src/` constructs its context and reuse that, rather than assembling a second one by hand.

- [ ] **Step 2: Write the full-workbook rehearsal test**

```ts
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/readWorkbook";
import { mapRow } from "../src/mapRow";

const WORKBOOK_PATH = "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx";
const describeIfWorkbook = existsSync(WORKBOOK_PATH) ? describe : describe.skip;

describeIfWorkbook("the real workbook", () => {
  it("maps every row without throwing, and queues a plausible fraction", async () => {
    const extract = await readWorkbook(WORKBOOK_PATH);
    // Exact, measured against the real file. A loose band would hide the two
    // regressions most likely here: dropping the `caseRef === ""` guard admits
    // the 4 month-divider rows (7,161), and iterating `1..rowCount` instead of
    // `eachRow` admits the 391 blank rows (7,552).
    expect(extract.miniCrmRows.length).toBe(7157);
    expect(extract.yearRows.length).toBe(6546);

    const mappedRows = extract.miniCrmRows.map(mapRow);
    const rowsWithReview = mappedRows.filter((mappedRow) => mappedRow.reviewItems.length > 0);
    const reviewRate = rowsWithReview.length / mappedRows.length;

    // Blank = not recorded, so the queue must stay near the measured 14.2%,
    // not the 64.9% that treating blanks as review items would produce.
    expect(reviewRate).toBeLessThan(0.30);
    expect(reviewRate).toBeGreaterThan(0.02);
  });

  it("drops the month-divider rows instead of turning them into cases", async () => {
    const extract = await readWorkbook(WORKBOOK_PATH);
    const dividerRowNumbers = [5984, 6308, 6615, 6900];
    for (const dividerRowNumber of dividerRowNumbers) {
      expect(extract.miniCrmRows.some((row) => row.sourceRow === dividerRowNumber)).toBe(false);
    }
  });

  it("never emits a review item for a blank source cell", async () => {
    const extract = await readWorkbook(WORKBOOK_PATH);
    for (const rawRow of extract.miniCrmRows) {
      for (const pending of mapRow(rawRow).reviewItems) {
        expect(pending.rawValue.trim()).not.toBe("");
      }
    }
  });
});
```

- [ ] **Step 3: Run every gate**

```bash
pnpm -r typecheck
pnpm --filter @rgs/shared test
pnpm --filter @rgs/api test
pnpm --filter @rgs/migration test
pnpm --filter @rgs/admin build
pnpm --filter @rgs/portal build
pnpm --filter @rgs/marketing build
```

All must pass. Record the actual numbers in the commit message. Do not commit a red gate.

- [ ] **Step 4: Confirm no infrastructure change is needed**

```bash
grep -n '"PATCH"' services/api/src/http/crmApi.ts
```

Expected: no matches. The review routes are GET/GET/PUT, all covered by the existing `/api/v1/admin/{proxy+}`.

- [ ] **Step 5: Document the importer**

Write `services/migration/README.md` covering: what the package does, why it is a separate package (`exceljs` stays out of the Lambda bundle), the dry-run default, the exact command to rehearse and to commit, and the fact that the Excel epoch was determined empirically and must not be changed without re-running the cross-sheet check.

Add one sentence to the root `README.md` repository-layout table: a `services/migration` row describing it as the one-off workbook importer, not part of the deployed stack.

- [ ] **Step 6: Commit**

```bash
git add services/migration README.md
git commit -m "feat(migration): add the import CLI, full-workbook rehearsal and docs"
```

---

## Self-Review

**1. Spec coverage.** §9's three passes: pass 1 is Task 7; pass 2 is the `ResidueResolver` seam in Task 8, deliberately deferred to Plan 4 and wired in Task 9; pass 3 is Tasks 1-4. §9's standing rules: `sourceRow`/`sourceSheet` on every record (Tasks 7, 9); nothing discarded — `legacyRaw` (Task 7); phone recovery by REF NO join (Task 8); group detection proposed not applied (Tasks 8, 9); re-runnable and idempotent on REF NO (Task 9). §5's "migrated cases keep the status the import assigned" is enforced in Task 9 by writing through `caseStore` rather than the mutators, and `billingStatus: UNKNOWN` is asserted there. §6's blank-cell rule is enforced in Task 7 and re-asserted against the real workbook in Task 10.

**2. Known gaps, stated rather than hidden.** `caseRef` still has no index — Task 9 works around it with an in-run set and names Plan 5 as the owner. The `REQURIED INFORMATION` and `CHECKLIST` sheets are not imported; neither carries case data. Pass 2 resolves nothing until Plan 4, so the review queue in this plan is larger than it will eventually be — that is expected, and Task 10's band (2%-30%) is set accordingly rather than to the eventual steady state.

**3. Type consistency.** `MappedRow`, `MappedCaseDraft` and `PendingReviewItem` are defined once in Task 7 and consumed unchanged in Tasks 8-10. `RecordReviewItemInput` (Task 3) accepts exactly the fields `PendingReviewItem` carries plus provenance, so Task 9 maps one to the other without a shape mismatch. `ReviewItem`'s `confidence` is optional in Task 1 precisely so Task 8's resolver can populate it later without a schema change.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, spec-compliance and quality review after each, fast iteration.

**2. Inline Execution** — executed in this session with checkpoints.
