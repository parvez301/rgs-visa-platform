# CRM Domain Layer and Admin REST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and serve CRM cases, partners and travellers through `services/api`, so the admin SPA and the later agent both have one domain layer to call.

**Architecture:** Ports-and-adapters, exactly as the existing `services/api` domain modules do it. Every function takes `AppContext` first and reaches DynamoDB only through the `TableClient` port, so all tests run against `InMemoryTableClient` with no AWS. `@rgs/shared`'s `crm` namespace (Plan 1) supplies every type, enum, schema and state machine — this plan adds persistence and HTTP, and invents no domain rules of its own.

**Tech Stack:** TypeScript (strict, ESM), Zod 3, Vitest 2, AWS SDK v3 DynamoDB DocumentClient, existing `Router` from `services/api/src/http/router.ts`.

**Spec:** `docs/superpowers/specs/2026-09-09-rgs-crm-design.md` — §5 (data model), §6 (normalization tables), §7 (watchdogs). Read §5 before Task 2; the key shapes there are binding.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- **Descriptive variable names** (owner's standing rule): write `crmCase`, `applicantItem`, `partnerRecord` — never `cfg`, `res`, `idx`, `val`.
- ESM only (`"type": "module"`); local imports use **no file extension**.
- All new CRM API code lives under `services/api/src/domain/crm/` and `services/api/src/http/crmApi.ts`. Tests under `services/api/test/crm/`.
- Domain functions take `AppContext` as their first parameter and touch storage only via `context.table`. Never import `@aws-sdk/*` in a domain module.
- Never re-implement a rule that `@rgs/shared` already owns. Case/custody/billing legality comes from `canTransitionCaseStatus`, `canTransitionCustody`, `canTransitionBilling`; validation comes from the Zod schemas. If you find yourself writing a status list, you are doing it wrong.
- Every CRM key carries a tenant segment from day one: `TENANT#<tenantId>#...`. v1 has one tenant, `rgs`, but no key may omit the segment.
- Timestamps come from `context.now()`, never `new Date()` directly — tests control the clock.
- Ids come from `newId(prefix)` in `src/lib/ids.ts`, which is time-sortable and which the SK schemes rely on.
- Errors are thrown as `ApiError` via the helpers in `src/lib/errors.ts` (`notFound`, `badRequest`, `conflict`, `forbidden`). Never return an error shape from a domain function.
- **Admin API Gateway routes allow GET, POST, PUT and DELETE only** — see `infra/lib/rgs-platform-stack.ts:213`. `PATCH` is NOT routed for admin. Use `PUT` for updates. A `PATCH` route would pass every local test and 404 in deployment.
- Case status values, verbatim: `NEW`, `IN_PROGRESS`, `APPOINTMENT_SET`, `SUBMITTED`, `DECIDED`, `CLOSED`, `NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`.
- Custody values, verbatim: `NOT_HELD`, `WITH_RGS`, `AT_EMBASSY`, `IN_TRANSIT`, `RETURNED`.
- Billing values, verbatim: `UNBILLED`, `BILL_SENT`, `PAID`, `PART_PAID`, `WRITTEN_OFF`, `UNKNOWN`. `UNKNOWN` is set by the migration only and never by the CRM itself.
- Commit after every task; green tests required first.

## Owner decisions folded into this plan

Two decisions were taken by the owner after Plan 1 shipped, from analysis of the real 7,161-row workbook. Task 1 records both in the spec so later plans inherit them.

1. **A blank cell means "not recorded", not "needs review."** Flagging blanks would put 4,648 of 7,161 rows (64.9%) into the human review queue; treating blank as absent puts 1,016 (14.2%) there. A queue nobody works is worse than no queue. Consequence for this plan: optional fields stay optional, and no write path may demand a value the spreadsheet does not carry.
2. **Three country mappings were missing**, costing 91 rows: `CZECH REPUBLIC` and `CZECH GROUP` → `CZ`, `ALGERIA` → `DZ`, `DUBAI` → `AE`.

## File structure

| File | Responsibility |
|---|---|
| `packages/shared/src/crm/normalize/country.ts` (modify) | add the three missing country mappings |
| `services/api/src/domain/crm/keys.ts` | every key and GSI string for CRM items — the only place key formats are written |
| `services/api/src/domain/crm/caseStore.ts` | split a `CrmCase` into `META` + `APPLICANT#nn` items on write, reassemble on read |
| `services/api/src/domain/crm/crmEvents.ts` | `EVENT#` audit trail for CRM mutations |
| `services/api/src/domain/crm/partners.ts` | partner create / list / get |
| `services/api/src/domain/crm/travellers.ts` | traveller upsert plus repeat-traveller lookup by passport |
| `services/api/src/domain/crm/cases.ts` | case create, read, list, and the three status transitions |
| `services/api/src/http/crmApi.ts` | route registrations, mounted into the existing admin router |
| `services/api/src/http/adminApi.ts` (modify) | mount the CRM routes |

---

### Task 1: Missing country mappings and the blank-cell rule

**Files:**
- Modify: `packages/shared/src/crm/normalize/country.ts`
- Modify: `docs/superpowers/specs/2026-09-09-rgs-crm-design.md`
- Test: `packages/shared/test/crm/normalize/country.test.ts`

**Interfaces:**
- Consumes: `normalizeCountry(rawValue: unknown): CountryNormalizationResult` — already exists.
- Produces: nothing new. Three additional map entries.

**Context for the implementer:** `normalizeCountry` looks up an uppercased, apostrophe-folded, whitespace-collapsed key via `buildLookupKey`. The map keys are already in that post-fold form, so add them uppercase. Do not touch `buildLookupKey` itself. These three values were found by running all 7,161 real rows through the normalizer: `CZECH REPUBLIC` appears 30 times, `CZECH GROUP` 15, `ALGERIA` 26, `DUBAI` 20.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe` in `packages/shared/test/crm/normalize/country.test.ts`:

```ts
  it("maps the three destinations found missing in the real workbook", () => {
    // 91 rows across the workbook resolved to null before these were added.
    expect(normalizeCountry("CZECH REPUBLIC").countryCode).toBe("CZ");
    expect(normalizeCountry("Czech Republic").countryCode).toBe("CZ");
    expect(normalizeCountry("CZECH GROUP").countryCode).toBe("CZ");
    expect(normalizeCountry("ALGERIA").countryCode).toBe("DZ");
    // Dubai is a city; RGS books it as the UAE.
    expect(normalizeCountry("DUBAI").countryCode).toBe("AE");
  });

  it("still refuses to guess at a service line sitting in the country column", () => {
    // "TRAVEL INSURANCE" (21 rows) and "PASSPORT NEW" (34) are not destinations.
    expect(normalizeCountry("TRAVEL INSURANCE").countryCode).toBeNull();
    expect(normalizeCountry("TRAVEL INSURANCE").needsReview).toBe(true);
    expect(normalizeCountry("PASSPORT NEW").countryCode).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/country`
Expected: FAIL — `expected null to be 'CZ'`.

- [ ] **Step 3: Add the three mappings**

In the country map object in `packages/shared/src/crm/normalize/country.ts`, add these entries in the existing alphabetical position:

```ts
  ALGERIA: "DZ",
  "CZECH GROUP": "CZ",
  "CZECH REPUBLIC": "CZ",
  DUBAI: "AE",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test`
Expected: PASS, and every pre-existing shared suite still green (baseline 165 tests / 14 files).

- [ ] **Step 5: Record both owner decisions in the spec**

In `docs/superpowers/specs/2026-09-09-rgs-crm-design.md`, in the §6 country table, add rows for `CZECH REPUBLIC`/`CZECH GROUP` → `CZ`, `ALGERIA` → `DZ`, `DUBAI` → `AE`.

Then add this subsection at the end of §6:

```markdown
### Blank cells are "not recorded", not "needs review"

Measured over the real workbook: flagging every blank cell puts 4,648 of
7,161 rows (64.9%) into the review queue; treating blank as absent puts
1,016 (14.2%) there. The large number is almost entirely empty `Entries`
(3,678), `Visa Type` (2,721) and `Status` (2,688) cells — fields the desk
simply never filled in, not values that failed to map.

Rule: a blank source cell yields an absent field, not a review flag. The
review queue is for values that were present and could not be resolved.
Normalizers still return `needsReview: true` for a blank input — that is
their contract — but the migration treats "blank input" and "unresolvable
input" differently, and only the second reaches a human.
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/crm/normalize/country.ts \
        packages/shared/test/crm/normalize/country.test.ts \
        docs/superpowers/specs/2026-09-09-rgs-crm-design.md
git commit -m "feat(crm): add the three missing country mappings and record the blank-cell rule"
```

---

### Task 2: Tenant-scoped key builders

**Files:**
- Create: `services/api/src/domain/crm/keys.ts`
- Test: `services/api/test/crm/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_TENANT_ID: "rgs"`
  - `casePartitionKey(tenantId: string, caseId: string): string`
  - `CASE_META_SORT_KEY: "META"`
  - `applicantSortKey(applicantIndex: number): string`
  - `APPLICANT_SORT_KEY_PREFIX: "APPLICANT#"`
  - `partnerPartitionKey(tenantId: string, partnerId: string): string`
  - `travellerPartitionKey(tenantId: string, travellerId: string): string`
  - `PARTNER_LIST_GSI1PK(tenantId: string): string`
  - `caseStatusGsi1Pk(tenantId: string, caseStatus: string): string`
  - `partnerCasesGsi2Pk(tenantId: string, partnerId: string): string`
  - `passportGsi3Pk(tenantId: string, passportNumber: string): string`
  - `travellerNameGsi2Pk(tenantId: string, normalizedName: string): string`
  - `eventSortKey(createdAt: string, eventId: string): string`

**Context for the implementer:** This is the only file in the codebase permitted to write a CRM key format as a string literal. Every other module calls these functions. Spec §5 is the authority for the shapes — copy them exactly. Applicant sort keys are zero-padded to two digits so they sort correctly under `begins_with`, which is how `caseStore` reassembles a case.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  APPLICANT_SORT_KEY_PREFIX,
  CASE_META_SORT_KEY,
  DEFAULT_TENANT_ID,
  applicantSortKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  eventSortKey,
  partnerCasesGsi2Pk,
  partnerPartitionKey,
  passportGsi3Pk,
  travellerPartitionKey,
} from "../../src/domain/crm/keys";

describe("crm keys", () => {
  it("puts a tenant segment on every partition key", () => {
    expect(casePartitionKey("rgs", "case_1")).toBe("TENANT#rgs#CASE#case_1");
    expect(partnerPartitionKey("rgs", "p_1")).toBe("TENANT#rgs#PARTNER#p_1");
    expect(travellerPartitionKey("rgs", "t_1")).toBe("TENANT#rgs#TRAVELLER#t_1");
  });

  it("keeps tenants apart", () => {
    expect(casePartitionKey("rgs", "case_1")).not.toBe(casePartitionKey("other", "case_1"));
  });

  it("zero-pads applicant sort keys so they sort in order", () => {
    expect(applicantSortKey(0)).toBe("APPLICANT#00");
    expect(applicantSortKey(9)).toBe("APPLICANT#09");
    expect(applicantSortKey(12)).toBe("APPLICANT#12");
    // Lexicographic order must match numeric order — this is why padding exists.
    const sorted = [applicantSortKey(10), applicantSortKey(2)].sort();
    expect(sorted).toEqual([applicantSortKey(2), applicantSortKey(10)]);
  });

  it("prefixes applicant keys so a case query can select just them", () => {
    expect(applicantSortKey(3).startsWith(APPLICANT_SORT_KEY_PREFIX)).toBe(true);
    expect(CASE_META_SORT_KEY.startsWith(APPLICANT_SORT_KEY_PREFIX)).toBe(false);
  });

  it("builds the three index keys from spec section 5", () => {
    expect(caseStatusGsi1Pk("rgs", "SUBMITTED")).toBe("TENANT#rgs#CASE_STATUS#SUBMITTED");
    expect(partnerCasesGsi2Pk("rgs", "p_1")).toBe("TENANT#rgs#PARTNER#p_1");
    expect(passportGsi3Pk("rgs", "Z6931368")).toBe("TENANT#rgs#PASSPORT#Z6931368");
  });

  it("sorts events by time then id", () => {
    expect(eventSortKey("2026-01-02T03:04:05.000Z", "evt_9")).toBe(
      "2026-01-02T03:04:05.000Z#evt_9",
    );
  });

  it("defaults to the rgs tenant", () => {
    expect(DEFAULT_TENANT_ID).toBe("rgs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/keys`
Expected: FAIL — cannot resolve `../../src/domain/crm/keys`.

- [ ] **Step 3: Write the key builders**

`services/api/src/domain/crm/keys.ts`:

```ts
/**
 * Every CRM key format lives here and nowhere else. Shapes come from spec §5.
 * A tenant segment is mandatory on every partition key: v1 serves one tenant,
 * but the keys are multi-tenant from day one so a second tenant needs no
 * migration.
 */

export const DEFAULT_TENANT_ID = "rgs";

export const CASE_META_SORT_KEY = "META";
export const APPLICANT_SORT_KEY_PREFIX = "APPLICANT#";
export const NOTE_SORT_KEY_PREFIX = "NOTE#";
export const EVENT_SORT_KEY_PREFIX = "EVENT#";

export function casePartitionKey(tenantId: string, caseId: string): string {
  return `TENANT#${tenantId}#CASE#${caseId}`;
}

export function partnerPartitionKey(tenantId: string, partnerId: string): string {
  return `TENANT#${tenantId}#PARTNER#${partnerId}`;
}

export function travellerPartitionKey(tenantId: string, travellerId: string): string {
  return `TENANT#${tenantId}#TRAVELLER#${travellerId}`;
}

/**
 * Zero-padded so lexicographic sort order matches applicant order — the case
 * reassembly in caseStore relies on this.
 */
export function applicantSortKey(applicantIndex: number): string {
  return `${APPLICANT_SORT_KEY_PREFIX}${String(applicantIndex).padStart(2, "0")}`;
}

export function partnerListGsi1Pk(tenantId: string): string {
  return `TENANT#${tenantId}#PARTNERS`;
}

export function caseStatusGsi1Pk(tenantId: string, caseStatus: string): string {
  return `TENANT#${tenantId}#CASE_STATUS#${caseStatus}`;
}

export function partnerCasesGsi2Pk(tenantId: string, partnerId: string): string {
  return `TENANT#${tenantId}#PARTNER#${partnerId}`;
}

export function passportGsi3Pk(tenantId: string, passportNumber: string): string {
  return `TENANT#${tenantId}#PASSPORT#${passportNumber}`;
}

export function travellerNameGsi2Pk(tenantId: string, normalizedName: string): string {
  return `TENANT#${tenantId}#TRAVELLER_NAME#${normalizedName}`;
}

export function eventSortKey(createdAt: string, eventId: string): string {
  return `${createdAt}#${eventId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/keys`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/keys.ts services/api/test/crm/keys.test.ts
git commit -m "feat(crm): add tenant-scoped key builders for CRM items"
```

---

### Task 3: Case store — split on write, reassemble on read

**Files:**
- Create: `services/api/src/domain/crm/caseStore.ts`
- Test: `services/api/test/crm/caseStore.test.ts`

**Interfaces:**
- Consumes: `casePartitionKey`, `CASE_META_SORT_KEY`, `applicantSortKey`, `APPLICANT_SORT_KEY_PREFIX`, `caseStatusGsi1Pk`, `partnerCasesGsi2Pk` from `./keys`; `crm.CrmCaseSchema` and `crm.CrmCase` from `@rgs/shared`.
- Produces:
  - `writeCase(context: AppContext, crmCase: CrmCase): Promise<void>`
  - `readCase(context: AppContext, tenantId: string, caseId: string): Promise<CrmCase | undefined>`
  - `readCaseOrThrow(context: AppContext, tenantId: string, caseId: string): Promise<CrmCase>`

**Context for the implementer:** This is the task Plan 1 deliberately left open. `CrmCaseSchema` carries `applicants[]` inside the case object — that is the domain and API shape. Storage is different: spec §5 puts the case body in a `META` item and **each applicant in its own `APPLICANT#nn` item** under the same partition. This file owns both directions and is the only place that knows they differ. Do not "simplify" by storing `applicants` as a nested array on the `META` item.

`writeCase` must delete applicant items that no longer exist, or a case that drops from three applicants to two will silently keep a ghost third on the next read.

Import the shared CRM namespace as `import { crm } from "@rgs/shared";` and reference `crm.CrmCaseSchema`, `crm.CrmCase`.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/caseStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { readCase, readCaseOrThrow, writeCase } from "../../src/domain/crm/caseStore";
import { APPLICANT_SORT_KEY_PREFIX, casePartitionKey } from "../../src/domain/crm/keys";
import type { crm } from "@rgs/shared";

function buildCase(overrides: Partial<crm.CrmCase> = {}): crm.CrmCase {
  return {
    tenantId: "rgs",
    caseId: "case_1",
    caseRef: "31377",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "BH",
    visaType: "EVISA_TOURIST",
    entryType: "SINGLE",
    processing: "NORMAL",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-02",
    lineItems: [],
    totalInr: 0,
    watchdogOverrides: {},
    mutedRules: [],
    applicants: [
      { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "31378", travellerId: "trv_2", custody: "NOT_HELD", outcome: "PENDING" },
    ],
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  } as crm.CrmCase;
}

describe("caseStore", () => {
  it("stores each applicant as its own item, not a nested array", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const partitionKey = casePartitionKey("rgs", "case_1");
    const metaItem = await context.table.get(partitionKey, "META");
    expect(metaItem).toBeDefined();
    // The storage shape must NOT carry the applicants array.
    expect(metaItem!["applicants"]).toBeUndefined();

    const applicantItems = await context.table.query(partitionKey, {
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
    });
    expect(applicantItems).toHaveLength(2);
    expect(applicantItems[0]!["applicantRef"]).toBe("31377");
    expect(applicantItems[1]!["applicantRef"]).toBe("31378");
  });

  it("reassembles the domain shape on read", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const loaded = await readCase(context, "rgs", "case_1");
    expect(loaded).toBeDefined();
    expect(loaded!.applicants).toHaveLength(2);
    expect(loaded!.applicants[0]!.applicantRef).toBe("31377");
    expect(loaded!.caseRef).toBe("31377");
    expect(loaded!.destinationCountry).toBe("BH");
  });

  it("round-trips without losing or inventing a field", async () => {
    const context = buildTestContext();
    const original = buildCase();
    await writeCase(context, original);
    const loaded = await readCase(context, "rgs", "case_1");
    expect(loaded).toEqual(original);
  });

  it("removes applicant items that are no longer part of the case", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());

    const shrunk = buildCase({
      applicants: [
        { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
      ],
    } as Partial<crm.CrmCase>);
    await writeCase(context, shrunk);

    const loaded = await readCase(context, "rgs", "case_1");
    // Without the delete pass, a ghost second applicant survives here.
    expect(loaded!.applicants).toHaveLength(1);
    const applicantItems = await context.table.query(casePartitionKey("rgs", "case_1"), {
      skPrefix: APPLICANT_SORT_KEY_PREFIX,
    });
    expect(applicantItems).toHaveLength(1);
  });

  it("indexes the case by status and by partner", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), "META");
    expect(metaItem!["GSI1PK"]).toBe("TENANT#rgs#CASE_STATUS#NEW");
    expect(metaItem!["GSI2PK"]).toBe("TENANT#rgs#PARTNER#partner_1");
    expect(metaItem!["GSI2SK"]).toBe("2026-01-02");
  });

  it("returns undefined for a case that does not exist", async () => {
    const context = buildTestContext();
    expect(await readCase(context, "rgs", "nope")).toBeUndefined();
  });

  it("does not leak a case across tenants", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase());
    expect(await readCase(context, "other-tenant", "case_1")).toBeUndefined();
  });

  it("throws a 404 from readCaseOrThrow when missing", async () => {
    const context = buildTestContext();
    await expect(readCaseOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/caseStore`
Expected: FAIL — cannot resolve `../../src/domain/crm/caseStore`.

- [ ] **Step 3: Write the case store**

`services/api/src/domain/crm/caseStore.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import type { TableItem } from "../../lib/db";
import { notFound } from "../../lib/errors";
import {
  APPLICANT_SORT_KEY_PREFIX,
  CASE_META_SORT_KEY,
  applicantSortKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  partnerCasesGsi2Pk,
} from "./keys";

/**
 * The domain shape (CrmCase, with applicants[] embedded) and the storage shape
 * (a META item plus one APPLICANT#nn item each) differ on purpose — see spec §5.
 * This module is the only place that knows about the difference.
 */

export async function writeCase(context: AppContext, crmCase: crm.CrmCase): Promise<void> {
  const partitionKey = casePartitionKey(crmCase.tenantId, crmCase.caseId);
  const { applicants, ...caseBody } = crmCase;

  await context.table.put({
    PK: partitionKey,
    SK: CASE_META_SORT_KEY,
    GSI1PK: caseStatusGsi1Pk(crmCase.tenantId, crmCase.caseStatus),
    GSI1SK: crmCase.updatedAt,
    GSI2PK: partnerCasesGsi2Pk(crmCase.tenantId, crmCase.partnerId),
    GSI2SK: crmCase.receivedDate,
    ...caseBody,
  });

  for (const [applicantIndex, caseApplicant] of applicants.entries()) {
    await context.table.put({
      PK: partitionKey,
      SK: applicantSortKey(applicantIndex),
      ...caseApplicant,
    });
  }

  // Drop applicant items beyond the current count, or a shrunk case keeps ghosts.
  const existingApplicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
  });
  for (const staleItem of existingApplicantItems.slice(applicants.length)) {
    await context.table.delete(partitionKey, staleItem.SK);
  }
}

export async function readCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase | undefined> {
  const partitionKey = casePartitionKey(tenantId, caseId);
  const metaItem = await context.table.get(partitionKey, CASE_META_SORT_KEY);
  if (!metaItem) return undefined;

  const applicantItems = await context.table.query(partitionKey, {
    skPrefix: APPLICANT_SORT_KEY_PREFIX,
  });

  return crm.CrmCaseSchema.parse({
    ...stripStorageAttributes(metaItem),
    applicants: applicantItems.map(stripStorageAttributes),
  });
}

export async function readCaseOrThrow(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  const loadedCase = await readCase(context, tenantId, caseId);
  if (!loadedCase) throw notFound("Case");
  return loadedCase;
}

/** Removes the key and index attributes so only domain fields reach the schema. */
function stripStorageAttributes(item: TableItem): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1Pk,
    GSI1SK: _gsi1Sk,
    GSI2PK: _gsi2Pk,
    GSI2SK: _gsi2Sk,
    GSI3PK: _gsi3Pk,
    GSI3SK: _gsi3Sk,
    ...domainFields
  } = item;
  return domainFields;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/caseStore`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/caseStore.ts services/api/test/crm/caseStore.test.ts
git commit -m "feat(crm): split cases into META and applicant items on write, reassemble on read"
```

---

### Task 4: CRM audit trail

**Files:**
- Create: `services/api/src/domain/crm/crmEvents.ts`
- Test: `services/api/test/crm/crmEvents.test.ts`

**Interfaces:**
- Consumes: `casePartitionKey`, `eventSortKey`, `EVENT_SORT_KEY_PREFIX` from `./keys`; `newId` from `../../lib/ids`.
- Produces:
  - `CrmEventType = "CASE_CREATED" | "CASE_STATUS_CHANGED" | "CUSTODY_CHANGED" | "BILLING_CHANGED" | "CASE_UPDATED"`
  - `recordCrmEvent(context, tenantId, caseId, eventType: CrmEventType, actorEmail: string, meta?: Record<string, string | number | boolean>): Promise<CrmEvent>`
  - `listCaseEvents(context, tenantId, caseId): Promise<CrmEvent[]>`
  - `interface CrmEvent { eventId: string; eventType: CrmEventType; caseId: string; actorEmail: string; meta: Record<string, string | number | boolean>; createdAt: string }`

**Context for the implementer:** Spec §5 puts `EVENT#<ts>#<id>` items under the case partition. This is what later lets the agent answer "what happened to this case?" without a separate store. Events are append-only — there is no update or delete. The existing platform has a separate `logActivity` in `src/lib/context.ts`; do not reuse or modify it, it writes to a different partition with a different shape for a different audience.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/crmEvents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { listCaseEvents, recordCrmEvent } from "../../src/domain/crm/crmEvents";

describe("crm events", () => {
  it("records an event under the case partition", async () => {
    const context = buildTestContext();
    const event = await recordCrmEvent(
      context,
      "rgs",
      "case_1",
      "CASE_CREATED",
      "ops@rgs.test",
      { caseRef: "31377" },
    );

    expect(event.eventType).toBe("CASE_CREATED");
    expect(event.actorEmail).toBe("ops@rgs.test");
    expect(event.meta["caseRef"]).toBe("31377");
    expect(event.createdAt).toBe("2026-07-23T10:00:00.000Z");
  });

  it("lists events for a case in the order they happened", async () => {
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    context.advanceClock(60_000);
    await recordCrmEvent(context, "rgs", "case_1", "CASE_STATUS_CHANGED", "ops@rgs.test", {
      fromStatus: "NEW",
      toStatus: "IN_PROGRESS",
    });

    const events = await listCaseEvents(context, "rgs", "case_1");
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[1]!.eventType).toBe("CASE_STATUS_CHANGED");
    expect(events[1]!.meta["toStatus"]).toBe("IN_PROGRESS");
  });

  it("keeps one case's events out of another's", async () => {
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "rgs", "case_2")).toEqual([]);
  });

  it("keeps one tenant's events out of another's", async () => {
    const context = buildTestContext();
    await recordCrmEvent(context, "rgs", "case_1", "CASE_CREATED", "ops@rgs.test");
    expect(await listCaseEvents(context, "other-tenant", "case_1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/crmEvents`
Expected: FAIL — cannot resolve `../../src/domain/crm/crmEvents`.

- [ ] **Step 3: Write the audit trail**

`services/api/src/domain/crm/crmEvents.ts`:

```ts
import type { AppContext } from "../../lib/context";
import { newId } from "../../lib/ids";
import { EVENT_SORT_KEY_PREFIX, casePartitionKey, eventSortKey } from "./keys";

export type CrmEventType =
  | "CASE_CREATED"
  | "CASE_STATUS_CHANGED"
  | "CUSTODY_CHANGED"
  | "BILLING_CHANGED"
  | "CASE_UPDATED";

export interface CrmEvent {
  eventId: string;
  eventType: CrmEventType;
  caseId: string;
  actorEmail: string;
  meta: Record<string, string | number | boolean>;
  createdAt: string;
}

/** Append-only. Spec §5 stores these as EVENT#<ts>#<id> under the case partition. */
export async function recordCrmEvent(
  context: AppContext,
  tenantId: string,
  caseId: string,
  eventType: CrmEventType,
  actorEmail: string,
  meta: Record<string, string | number | boolean> = {},
): Promise<CrmEvent> {
  const createdAtDate = context.now();
  const createdAt = createdAtDate.toISOString();
  const eventId = newId("crmevt", createdAtDate.getTime());
  const crmEvent: CrmEvent = { eventId, eventType, caseId, actorEmail, meta, createdAt };

  await context.table.put({
    PK: casePartitionKey(tenantId, caseId),
    SK: `${EVENT_SORT_KEY_PREFIX}${eventSortKey(createdAt, eventId)}`,
    ...crmEvent,
  });
  return crmEvent;
}

export async function listCaseEvents(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<CrmEvent[]> {
  const eventItems = await context.table.query(casePartitionKey(tenantId, caseId), {
    skPrefix: EVENT_SORT_KEY_PREFIX,
  });
  return eventItems.map((eventItem) => ({
    eventId: String(eventItem["eventId"]),
    eventType: eventItem["eventType"] as CrmEventType,
    caseId: String(eventItem["caseId"]),
    actorEmail: String(eventItem["actorEmail"]),
    meta: (eventItem["meta"] ?? {}) as Record<string, string | number | boolean>,
    createdAt: String(eventItem["createdAt"]),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/crmEvents`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/crmEvents.ts services/api/test/crm/crmEvents.test.ts
git commit -m "feat(crm): add an append-only audit trail under the case partition"
```

---

### Task 5: Partners

**Files:**
- Create: `services/api/src/domain/crm/partners.ts`
- Test: `services/api/test/crm/partners.test.ts`

**Interfaces:**
- Consumes: `partnerPartitionKey`, `partnerListGsi1Pk` from `./keys`; `crm.PartnerSchema`, `crm.Partner`, `crm.normalizePartnerName` from `@rgs/shared`; `newId` from `../../lib/ids`.
- Produces:
  - `createPartner(context, tenantId, input: { canonicalName: string; partnerType?: crm.PartnerType; aliases?: string[]; notes?: string }, actorEmail: string): Promise<crm.Partner>`
  - `listPartners(context, tenantId): Promise<crm.Partner[]>`
  - `getPartnerOrThrow(context, tenantId, partnerId): Promise<crm.Partner>`
  - `findPartnerByName(context, tenantId, rawName: string): Promise<crm.Partner | undefined>`

**Context for the implementer:** 89% of RGS's volume arrives through referral agencies, so partners are a first-class entity, not a field on the case. `findPartnerByName` uses `crm.normalizePartnerName` to fold `"VWI Mumbai"` and `"VWI BOM"` onto the same canonical key — that is how the migration will avoid creating a partner per spelling. Reuse the shared normalizer; do not write your own matching.

**`PartnerSchema` has NO `canonicalKey` field.** Its fields are exactly: `tenantId`, `partnerId`, `canonicalName`, `aliases` (defaults `[]`), `partnerType`, `contactPhone?`, `contactEmail?`, `contactWhatsapp?`, `notes?`, `createdAt`. Note `partnerType`, not `type`, and flat contact fields, not a nested object.

The canonical key therefore lives **only as the storage attribute `GSI1SK`**, not on the domain object. `findPartnerByName` must compare against the raw item's `GSI1SK` BEFORE parsing to `Partner` — if you try to read `partner.canonicalKey` off a parsed `Partner`, Zod will have stripped it and every comparison silently yields `undefined`.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/partners.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import {
  createPartner,
  findPartnerByName,
  getPartnerOrThrow,
  listPartners,
} from "../../src/domain/crm/partners";

describe("crm partners", () => {
  it("creates a partner with the type the shared normalizer inferred", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "VWI Mumbai" },
      "ops@rgs.test",
    );
    expect(partner.canonicalName).toBe("VWI Mumbai");
    expect(partner.partnerType).toBe("AGENCY");
    expect(partner.aliases).toEqual([]);
    // canonicalKey is deliberately NOT on the domain object — it is a storage
    // attribute only. Its effect is observable through findPartnerByName below.
    expect("canonicalKey" in partner).toBe(false);
  });

  it("finds an existing partner through a different spelling", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "VWI Mumbai" }, "ops@rgs.test");
    // "VWI BOM" folds to the same canonical key — this is what stops the
    // migration creating one partner per spelling.
    const found = await findPartnerByName(context, "rgs", "VWI BOM");
    expect(found).toBeDefined();
    expect(found!.canonicalName).toBe("VWI Mumbai");
  });

  it("returns undefined when no partner matches", async () => {
    const context = buildTestContext();
    expect(await findPartnerByName(context, "rgs", "Nobody Travels")).toBeUndefined();
  });

  it("lists partners for the tenant", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    await createPartner(context, "rgs", { canonicalName: "Luxe Escape" }, "ops@rgs.test");
    const partners = await listPartners(context, "rgs");
    expect(partners).toHaveLength(2);
    expect(partners.map((partner) => partner.canonicalName).sort()).toEqual([
      "Luxe Escape",
      "Ozzy Travels",
    ]);
  });

  it("keeps one tenant's partners out of another's list", async () => {
    const context = buildTestContext();
    await createPartner(context, "rgs", { canonicalName: "Ozzy Travels" }, "ops@rgs.test");
    expect(await listPartners(context, "other-tenant")).toEqual([]);
  });

  it("throws a 404 for a partner that does not exist", async () => {
    const context = buildTestContext();
    await expect(getPartnerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("accepts an explicit partner type and aliases", async () => {
    const context = buildTestContext();
    const partner = await createPartner(
      context,
      "rgs",
      { canonicalName: "Sudiva Spinners Pvt Ltd", partnerType: "CORPORATE", aliases: ["Sudiva"] },
      "ops@rgs.test",
    );
    expect(partner.partnerType).toBe("CORPORATE");
    expect(partner.aliases).toEqual(["Sudiva"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/partners`
Expected: FAIL — cannot resolve `../../src/domain/crm/partners`.

- [ ] **Step 3: Write the partners module**

`services/api/src/domain/crm/partners.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { partnerListGsi1Pk, partnerPartitionKey } from "./keys";

export interface CreatePartnerInput {
  canonicalName: string;
  partnerType?: crm.PartnerType;
  aliases?: string[];
  notes?: string;
}

export async function createPartner(
  context: AppContext,
  tenantId: string,
  input: CreatePartnerInput,
  actorEmail: string,
): Promise<crm.Partner> {
  const normalized = crm.normalizePartnerName(input.canonicalName);
  if (normalized.canonicalKey === null) {
    throw badRequest("Partner name could not be normalized");
  }

  const partner = crm.PartnerSchema.parse({
    tenantId,
    partnerId: newId("prt", context.now().getTime()),
    canonicalName: input.canonicalName,
    partnerType: input.partnerType ?? normalized.partnerType,
    aliases: input.aliases ?? [],
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    createdAt: context.now().toISOString(),
  });

  await context.table.put({
    PK: partnerPartitionKey(tenantId, partner.partnerId),
    SK: "META",
    GSI1PK: partnerListGsi1Pk(tenantId),
    // The canonical key is a storage attribute only — PartnerSchema has no such
    // field, so it must not be spread into the domain object.
    GSI1SK: normalized.canonicalKey,
    createdByEmail: actorEmail,
    ...partner,
  });
  return partner;
}

export async function listPartners(
  context: AppContext,
  tenantId: string,
): Promise<crm.Partner[]> {
  const partnerItems = await context.table.queryGsi("GSI1", partnerListGsi1Pk(tenantId));
  return partnerItems.map((partnerItem) => crm.PartnerSchema.parse(stripKeys(partnerItem)));
}

export async function getPartnerOrThrow(
  context: AppContext,
  tenantId: string,
  partnerId: string,
): Promise<crm.Partner> {
  const partnerItem = await context.table.get(partnerPartitionKey(tenantId, partnerId), "META");
  if (!partnerItem) throw notFound("Partner");
  return crm.PartnerSchema.parse(stripKeys(partnerItem));
}

/**
 * Folds the raw name through the shared normalizer, so "VWI Mumbai" and
 * "VWI BOM" resolve to the same partner rather than creating a duplicate.
 */
export async function findPartnerByName(
  context: AppContext,
  tenantId: string,
  rawName: string,
): Promise<crm.Partner | undefined> {
  const normalized = crm.normalizePartnerName(rawName);
  if (normalized.canonicalKey === null) return undefined;
  const partnerItems = await context.table.queryGsi("GSI1", partnerListGsi1Pk(tenantId));
  // Match on the RAW item's GSI1SK. Parsing first would strip the key.
  const matchingItem = partnerItems.find(
    (partnerItem) => partnerItem.GSI1SK === normalized.canonicalKey,
  );
  return matchingItem ? crm.PartnerSchema.parse(stripKeys(matchingItem)) : undefined;
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI1PK: _gsi1Pk,
    GSI1SK: _gsi1Sk,
    createdByEmail: _createdByEmail,
    ...domainFields
  } = item;
  return domainFields;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/partners`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/partners.ts services/api/test/crm/partners.test.ts
git commit -m "feat(crm): add partner records with normalizer-backed deduplication"
```

---

### Task 6: Travellers and repeat-traveller lookup

**Files:**
- Create: `services/api/src/domain/crm/travellers.ts`
- Test: `services/api/test/crm/travellers.test.ts`

**Interfaces:**
- Consumes: `travellerPartitionKey`, `passportGsi3Pk`, `travellerNameGsi2Pk` from `./keys`; `crm.CrmTravellerSchema`, `crm.CrmTraveller` from `@rgs/shared`; `newId`.
- Produces:
  - `upsertTraveller(context, tenantId, input: { fullName: string; passportNumber?: string; dateOfBirth?: string; phone?: string }): Promise<crm.CrmTraveller>`
  - `findTravellerByPassport(context, tenantId, passportNumber): Promise<crm.CrmTraveller | undefined>`
  - `getTravellerOrThrow(context, tenantId, travellerId): Promise<crm.CrmTraveller>`
  - `normalizeTravellerName(fullName: string): string`

**Context for the implementer:** This is the capability the spreadsheet cannot offer: recognising that a traveller has been here before. `upsertTraveller` must return the EXISTING traveller when the passport number already exists for that tenant, rather than creating a second record — that is the whole point of the `GSI3` passport index in spec §5.

`normalizeTravellerName` uppercases, trims and collapses internal whitespace. It is the fuzzy fallback for travellers with no passport on file (74% of workbook rows have no passport number).

`CrmTravellerSchema` fields: `tenantId`, `travellerId`, `fullName`, `normalizedName`, `dateOfBirth` (optional), `phone` (optional), `passportNumber` (optional), `createdAt`.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/travellers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import {
  findTravellerByPassport,
  getTravellerOrThrow,
  normalizeTravellerName,
  upsertTraveller,
} from "../../src/domain/crm/travellers";

describe("crm travellers", () => {
  it("creates a traveller and indexes the passport", async () => {
    const context = buildTestContext();
    const traveller = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    expect(traveller.fullName).toBe("Umesh Kumar Yadav");
    expect(traveller.normalizedName).toBe("UMESH KUMAR YADAV");

    const found = await findTravellerByPassport(context, "rgs", "Z6931368");
    expect(found).toBeDefined();
    expect(found!.travellerId).toBe(traveller.travellerId);
  });

  it("returns the SAME traveller for a repeat passport rather than duplicating", async () => {
    const context = buildTestContext();
    const first = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    context.advanceClock(86_400_000);
    const second = await upsertTraveller(context, "rgs", {
      fullName: "Umesh K Yadav",
      passportNumber: "Z6931368",
    });
    // This is the capability the Excel sheet cannot provide.
    expect(second.travellerId).toBe(first.travellerId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("creates separate travellers when the passport differs", async () => {
    const context = buildTestContext();
    const first = await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    const second = await upsertTraveller(context, "rgs", {
      fullName: "Aman Kapoor",
      passportNumber: "M1112223",
    });
    expect(second.travellerId).not.toBe(first.travellerId);
  });

  it("creates a new traveller each time when no passport is recorded", async () => {
    const context = buildTestContext();
    // 74% of workbook rows carry no passport number, so this path is the common one.
    const first = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    const second = await upsertTraveller(context, "rgs", { fullName: "No Passport Person" });
    expect(second.travellerId).not.toBe(first.travellerId);
  });

  it("does not match a passport across tenants", async () => {
    const context = buildTestContext();
    await upsertTraveller(context, "rgs", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    expect(await findTravellerByPassport(context, "other-tenant", "Z6931368")).toBeUndefined();
  });

  it("normalizes names for the fuzzy fallback", () => {
    expect(normalizeTravellerName("  Umesh   Kumar  Yadav ")).toBe("UMESH KUMAR YADAV");
    expect(normalizeTravellerName("aman kapoor")).toBe("AMAN KAPOOR");
  });

  it("throws a 404 for a traveller that does not exist", async () => {
    const context = buildTestContext();
    await expect(getTravellerOrThrow(context, "rgs", "nope")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/travellers`
Expected: FAIL — cannot resolve `../../src/domain/crm/travellers`.

- [ ] **Step 3: Write the travellers module**

`services/api/src/domain/crm/travellers.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { passportGsi3Pk, travellerNameGsi2Pk, travellerPartitionKey } from "./keys";

export interface UpsertTravellerInput {
  fullName: string;
  passportNumber?: string;
  dateOfBirth?: string;
  phone?: string;
}

/** Uppercase, trimmed, single-spaced — the fuzzy fallback key from spec §5. */
export function normalizeTravellerName(fullName: string): string {
  return fullName.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Returns the existing traveller when the passport is already on file for this
 * tenant. Recognising a repeat traveller is the thing the spreadsheet cannot do.
 */
export async function upsertTraveller(
  context: AppContext,
  tenantId: string,
  input: UpsertTravellerInput,
): Promise<crm.CrmTraveller> {
  if (input.passportNumber !== undefined) {
    const existing = await findTravellerByPassport(context, tenantId, input.passportNumber);
    if (existing) return existing;
  }

  const traveller = crm.CrmTravellerSchema.parse({
    tenantId,
    travellerId: newId("trv", context.now().getTime()),
    fullName: input.fullName,
    normalizedName: normalizeTravellerName(input.fullName),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.passportNumber !== undefined ? { passportNumber: input.passportNumber } : {}),
    createdAt: context.now().toISOString(),
  });

  await context.table.put({
    PK: travellerPartitionKey(tenantId, traveller.travellerId),
    SK: "META",
    GSI2PK: travellerNameGsi2Pk(tenantId, traveller.normalizedName),
    GSI2SK: traveller.travellerId,
    ...(traveller.passportNumber !== undefined
      ? {
          GSI3PK: passportGsi3Pk(tenantId, traveller.passportNumber),
          GSI3SK: traveller.travellerId,
        }
      : {}),
    ...traveller,
  });
  return traveller;
}

export async function findTravellerByPassport(
  context: AppContext,
  tenantId: string,
  passportNumber: string,
): Promise<crm.CrmTraveller | undefined> {
  const matches = await context.table.queryGsi(
    "GSI3",
    passportGsi3Pk(tenantId, passportNumber),
    { limit: 1 },
  );
  const firstMatch = matches[0];
  return firstMatch ? crm.CrmTravellerSchema.parse(stripKeys(firstMatch)) : undefined;
}

export async function getTravellerOrThrow(
  context: AppContext,
  tenantId: string,
  travellerId: string,
): Promise<crm.CrmTraveller> {
  const travellerItem = await context.table.get(
    travellerPartitionKey(tenantId, travellerId),
    "META",
  );
  if (!travellerItem) throw notFound("Traveller");
  return crm.CrmTravellerSchema.parse(stripKeys(travellerItem));
}

function stripKeys(item: Record<string, unknown>): Record<string, unknown> {
  const {
    PK: _partitionKey,
    SK: _sortKey,
    GSI2PK: _gsi2Pk,
    GSI2SK: _gsi2Sk,
    GSI3PK: _gsi3Pk,
    GSI3SK: _gsi3Sk,
    ...domainFields
  } = item;
  return domainFields;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/travellers`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/travellers.ts services/api/test/crm/travellers.test.ts
git commit -m "feat(crm): add travellers with repeat-passport recognition"
```

---

### Task 7: Case service and the three status axes

**Files:**
- Create: `services/api/src/domain/crm/cases.ts`
- Test: `services/api/test/crm/cases.test.ts`

**Interfaces:**
- Consumes: `writeCase`, `readCase`, `readCaseOrThrow` from `./caseStore`; `recordCrmEvent` from `./crmEvents`; `getPartnerOrThrow` from `./partners`; `caseStatusGsi1Pk`, `partnerCasesGsi2Pk`, `casePartitionKey`, `CASE_META_SORT_KEY` from `./keys`; from `@rgs/shared`: `crm.CrmCaseSchema`, `crm.canTransitionCaseStatus`, `crm.canTransitionCustody`, `crm.canTransitionBilling`, `crm.deriveCaseStatusFromApplicants`.
- Produces:
  - `createCase(context, tenantId, input: CreateCaseInput, actorEmail): Promise<crm.CrmCase>`
  - `getCase(context, tenantId, caseId): Promise<crm.CrmCase>`
  - `listCasesByStatus(context, tenantId, caseStatus: crm.CaseStatus, limit?): Promise<crm.CrmCase[]>`
  - `listCasesByPartner(context, tenantId, partnerId, limit?): Promise<crm.CrmCase[]>`
  - `changeCaseStatus(context, tenantId, caseId, toStatus, actorEmail): Promise<crm.CrmCase>`
  - `changeApplicantCustody(context, tenantId, caseId, applicantIndex, toCustody, actorEmail): Promise<crm.CrmCase>`
  - `changeBillingStatus(context, tenantId, caseId, toBillingStatus, actorEmail): Promise<crm.CrmCase>`
  - `interface CreateCaseInput { caseRef: string; caseType: crm.CaseType; partnerId: string; destinationCountry: string; visaType?: crm.VisaType; entryType?: crm.EntryType; processing?: crm.ProcessingSpeed; receivedDate: string; applicants: Array<{ applicantRef: string; travellerId: string; passportNumber?: string }> }`

**Context for the implementer:** The three axes — `caseStatus`, per-applicant `custody`, `billingStatus` — move independently and each has its own legality check in `@rgs/shared`. **Never write a status without asking the matching `canTransition*` function first**, and throw `conflict(...)` when it says no. Do not re-implement the rules; do not add statuses.

Per the blank-cell rule in Global Constraints, `CreateCaseInput` requires only what the spreadsheet reliably carries. `visaType`, `entryType` and `processing` are optional — but `CrmCaseSchema` refuses a `VISA` case with no `visaType`, so a VISA case must supply it. New cases start at `caseStatus: "NEW"` and `billingStatus: "UNBILLED"`; `UNKNOWN` is reserved for the migration.

Every mutation records an event via `recordCrmEvent`.

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/cases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { createPartner } from "../../src/domain/crm/partners";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import {
  changeApplicantCustody,
  changeBillingStatus,
  changeCaseStatus,
  createCase,
  getCase,
  listCasesByPartner,
  listCasesByStatus,
} from "../../src/domain/crm/cases";

async function seedPartner(context: TestContext): Promise<string> {
  const partner = await createPartner(
    context,
    "rgs",
    { canonicalName: "Ozzy Travels" },
    "ops@rgs.test",
  );
  return partner.partnerId;
}

async function seedCase(context: TestContext, partnerId: string, caseRef = "31377") {
  return createCase(
    context,
    "rgs",
    {
      caseRef,
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      entryType: "SINGLE",
      processing: "NORMAL",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: caseRef, travellerId: "trv_1" }],
    },
    "ops@rgs.test",
  );
}

describe("crm cases", () => {
  it("creates a case on all three axes at their starting values", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    expect(created.caseStatus).toBe("NEW");
    expect(created.billingStatus).toBe("UNBILLED");
    expect(created.applicants[0]!.custody).toBe("NOT_HELD");
    expect(created.applicants[0]!.outcome).toBe("PENDING");
    expect(created.totalInr).toBe(0);
  });

  it("records a creation event", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const events = await listCaseEvents(context, "rgs", created.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[0]!.actorEmail).toBe("ops@rgs.test");
  });

  it("rejects a case whose partner does not exist", async () => {
    const context = buildTestContext();
    await expect(seedCase(context, "no_such_partner")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("rejects a VISA case with no visa type", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await expect(
      createCase(
        context,
        "rgs",
        {
          caseRef: "31999",
          caseType: "VISA",
          partnerId,
          destinationCountry: "BH",
          receivedDate: "2026-01-02",
          applicants: [{ applicantRef: "31999", travellerId: "trv_1" }],
        },
        "ops@rgs.test",
      ),
    ).rejects.toThrow();
  });

  it("allows a non-visa case with no visa type", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const attestation = await createCase(
      context,
      "rgs",
      {
        caseRef: "31888",
        caseType: "ATTESTATION",
        partnerId,
        destinationCountry: "AE",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: "31888", travellerId: "trv_2" }],
      },
      "ops@rgs.test",
    );
    expect(attestation.caseType).toBe("ATTESTATION");
    expect(attestation.visaType).toBeUndefined();
  });

  it("moves the case status through a legal transition and logs it", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const moved = await changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test");
    expect(moved.caseStatus).toBe("IN_PROGRESS");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusEvent!.meta["fromStatus"]).toBe("NEW");
    expect(statusEvent!.meta["toStatus"]).toBe("IN_PROGRESS");
  });

  it("refuses an illegal case-status transition with a 409", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await changeCaseStatus(context, "rgs", created.caseId, "WITHDRAWN", "ops@rgs.test");
    // WITHDRAWN is terminal — nothing may leave it.
    await expect(
      changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("moves custody on a single applicant without touching the case status", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const updated = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      0,
      "WITH_RGS",
      "ops@rgs.test",
    );
    expect(updated.applicants[0]!.custody).toBe("WITH_RGS");
    expect(updated.applicants[0]!.custodySince).toBe("2026-07-23T10:00:00.000Z");
    expect(updated.caseStatus).toBe("NEW");
  });

  it("refuses an illegal custody transition with a 409", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    // NOT_HELD may only go to WITH_RGS.
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, 0, "AT_EMBASSY", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a custody change for an applicant index that does not exist", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, 7, "WITH_RGS", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("moves billing independently of the other two axes", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const billed = await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    expect(billed.billingStatus).toBe("BILL_SENT");
    expect(billed.caseStatus).toBe("NEW");
    expect(billed.applicants[0]!.custody).toBe("NOT_HELD");
  });

  it("lists cases by status, and the index follows the case when it moves", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const created = await seedCase(context, partnerId);
    expect(await listCasesByStatus(context, "rgs", "NEW")).toHaveLength(1);

    await changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test");
    // The GSI1 entry must move with the status, or the queue shows stale rows.
    expect(await listCasesByStatus(context, "rgs", "NEW")).toHaveLength(0);
    expect(await listCasesByStatus(context, "rgs", "IN_PROGRESS")).toHaveLength(1);
  });

  it("lists cases by partner", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    expect(await listCasesByPartner(context, "rgs", partnerId)).toHaveLength(2);
  });

  it("keeps one tenant's cases out of another's queries", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId);
    expect(await listCasesByStatus(context, "other-tenant", "NEW")).toEqual([]);
  });

  it("throws a 404 reading a case that does not exist", async () => {
    const context = buildTestContext();
    await expect(getCase(context, "rgs", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/cases`
Expected: FAIL — cannot resolve `../../src/domain/crm/cases`.

- [ ] **Step 3: Write the case service**

`services/api/src/domain/crm/cases.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { readCase, readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { CASE_META_SORT_KEY, caseStatusGsi1Pk, partnerCasesGsi2Pk } from "./keys";
import { getPartnerOrThrow } from "./partners";

export interface CreateCaseApplicantInput {
  applicantRef: string;
  travellerId: string;
  passportNumber?: string;
}

export interface CreateCaseInput {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType?: crm.VisaType;
  entryType?: crm.EntryType;
  processing?: crm.ProcessingSpeed;
  receivedDate: string;
  applicants: CreateCaseApplicantInput[];
}

export async function createCase(
  context: AppContext,
  tenantId: string,
  input: CreateCaseInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  // 404s if the partner is unknown — a case always belongs to someone.
  await getPartnerOrThrow(context, tenantId, input.partnerId);

  const nowIso = context.now().toISOString();
  const crmCase = crm.CrmCaseSchema.parse({
    tenantId,
    caseId: newId("case", context.now().getTime()),
    caseRef: input.caseRef,
    caseType: input.caseType,
    partnerId: input.partnerId,
    destinationCountry: input.destinationCountry,
    ...(input.visaType !== undefined ? { visaType: input.visaType } : {}),
    ...(input.entryType !== undefined ? { entryType: input.entryType } : {}),
    ...(input.processing !== undefined ? { processing: input.processing } : {}),
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: input.receivedDate,
    lineItems: [],
    totalInr: 0,
    watchdogOverrides: {},
    mutedRules: [],
    applicants: input.applicants.map((applicant) => ({
      applicantRef: applicant.applicantRef,
      travellerId: applicant.travellerId,
      ...(applicant.passportNumber !== undefined
        ? { passportNumber: applicant.passportNumber }
        : {}),
      custody: "NOT_HELD",
      outcome: "PENDING",
    })),
    createdAt: nowIso,
    updatedAt: nowIso,
    createdByEmail: actorEmail,
  });

  await writeCase(context, crmCase);
  await recordCrmEvent(context, tenantId, crmCase.caseId, "CASE_CREATED", actorEmail, {
    caseRef: crmCase.caseRef,
    caseType: crmCase.caseType,
  });
  return crmCase;
}

export async function getCase(
  context: AppContext,
  tenantId: string,
  caseId: string,
): Promise<crm.CrmCase> {
  return readCaseOrThrow(context, tenantId, caseId);
}

export async function changeCaseStatus(
  context: AppContext,
  tenantId: string,
  caseId: string,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  if (!crm.canTransitionCaseStatus(currentCase.caseStatus, toStatus)) {
    throw conflict(`Cannot move a case from ${currentCase.caseStatus} to ${toStatus}`);
  }
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    caseStatus: toStatus,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "CASE_STATUS_CHANGED", actorEmail, {
    fromStatus: currentCase.caseStatus,
    toStatus,
  });
  return updatedCase;
}

export async function changeApplicantCustody(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantIndex: number,
  toCustody: crm.CustodyStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const caseApplicant = currentCase.applicants[applicantIndex];
  if (!caseApplicant) {
    throw badRequest(`Case has no applicant at index ${applicantIndex}`);
  }
  if (!crm.canTransitionCustody(caseApplicant.custody, toCustody)) {
    throw conflict(`Cannot move custody from ${caseApplicant.custody} to ${toCustody}`);
  }

  const nowIso = context.now().toISOString();
  const updatedApplicants = currentCase.applicants.map((applicant, index) =>
    index === applicantIndex
      ? { ...applicant, custody: toCustody, custodySince: nowIso }
      : applicant,
  );
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    applicants: updatedApplicants,
    updatedAt: nowIso,
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "CUSTODY_CHANGED", actorEmail, {
    applicantIndex,
    fromCustody: caseApplicant.custody,
    toCustody,
  });
  return updatedCase;
}

export async function changeBillingStatus(
  context: AppContext,
  tenantId: string,
  caseId: string,
  toBillingStatus: crm.BillingStatus,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  if (!crm.canTransitionBilling(currentCase.billingStatus, toBillingStatus)) {
    throw conflict(
      `Cannot move billing from ${currentCase.billingStatus} to ${toBillingStatus}`,
    );
  }
  const updatedCase: crm.CrmCase = {
    ...currentCase,
    billingStatus: toBillingStatus,
    updatedAt: context.now().toISOString(),
  };
  await writeCase(context, updatedCase);
  await recordCrmEvent(context, tenantId, caseId, "BILLING_CHANGED", actorEmail, {
    fromBillingStatus: currentCase.billingStatus,
    toBillingStatus,
  });
  return updatedCase;
}

export async function listCasesByStatus(
  context: AppContext,
  tenantId: string,
  caseStatus: crm.CaseStatus,
  limit = 50,
): Promise<crm.CrmCase[]> {
  const metaItems = await context.table.queryGsi(
    "GSI1",
    caseStatusGsi1Pk(tenantId, caseStatus),
    { limit, scanForward: false },
  );
  return loadCasesFromMetaItems(context, tenantId, metaItems);
}

export async function listCasesByPartner(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  limit = 50,
): Promise<crm.CrmCase[]> {
  const metaItems = await context.table.queryGsi(
    "GSI2",
    partnerCasesGsi2Pk(tenantId, partnerId),
    { limit, scanForward: false },
  );
  return loadCasesFromMetaItems(context, tenantId, metaItems);
}

/**
 * A GSI query returns only the META item; applicants live in sibling items, so
 * each case is reassembled through the store.
 */
async function loadCasesFromMetaItems(
  context: AppContext,
  tenantId: string,
  metaItems: Array<Record<string, unknown>>,
): Promise<crm.CrmCase[]> {
  const loadedCases: crm.CrmCase[] = [];
  for (const metaItem of metaItems) {
    if (metaItem["SK"] !== CASE_META_SORT_KEY) continue;
    const loadedCase = await readCase(context, tenantId, String(metaItem["caseId"]));
    if (loadedCase) loadedCases.push(loadedCase);
  }
  return loadedCases;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/api test crm/cases`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add services/api/src/domain/crm/cases.ts services/api/test/crm/cases.test.ts
git commit -m "feat(crm): add the case service with independent status, custody and billing axes"
```

---

### Task 8: Admin REST routes

**Files:**
- Create: `services/api/src/http/crmApi.ts`
- Modify: `services/api/src/http/adminApi.ts`
- Test: `services/api/test/crm/crmApi.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5-7; `Router`, `parseBody`, `RequestContext` from `./router`; `DEFAULT_TENANT_ID` from `../domain/crm/keys`.
- Produces: `registerCrmRoutes(router: Router, context: AppContext): Router`

**Context for the implementer:** Look at how `services/api/src/http/adminApi.ts` builds its router before writing this — same `Router`, same `parseBody`, same `requestContext.callerEmail` for the actor. Your function takes the admin router and adds routes to it, so the CRM inherits the admin Cognito authorizer with no infrastructure change.

**Every existing admin route calls `requireAdmin(requestContext)` as its first statement**, which throws `forbidden(...)` when `callerId` is empty. `requireAdmin` is currently a module-private function in `adminApi.ts`. Export it (`export function requireAdmin`) and call it first in every CRM handler. Skipping it would leave the CRM routes reachable by any caller whose JWT carried no subject, while every neighbouring admin route rejects them — an inconsistency a reviewer should catch.

**Use `PUT`, never `PATCH`.** `infra/lib/rgs-platform-stack.ts:213` routes GET/POST/PUT/DELETE for `/api/v1/admin/{proxy+}`; a `PATCH` route would pass every test here and 404 in deployment.

Tenant comes from `DEFAULT_TENANT_ID` for now — v1 is single-tenant, and threading a real tenant claim through the JWT is a later plan's job. Do not invent a tenant header.

Routes to add:

| Method | Path | Calls |
|---|---|---|
| GET | `/api/v1/admin/crm/cases` | `listCasesByStatus` (query param `status`, default `NEW`) |
| POST | `/api/v1/admin/crm/cases` | `createCase` |
| GET | `/api/v1/admin/crm/cases/{caseId}` | `getCase` |
| PUT | `/api/v1/admin/crm/cases/{caseId}/status` | `changeCaseStatus` |
| PUT | `/api/v1/admin/crm/cases/{caseId}/billing` | `changeBillingStatus` |
| PUT | `/api/v1/admin/crm/cases/{caseId}/applicants/{applicantIndex}/custody` | `changeApplicantCustody` |
| GET | `/api/v1/admin/crm/cases/{caseId}/events` | `listCaseEvents` |
| GET | `/api/v1/admin/crm/partners` | `listPartners` |
| POST | `/api/v1/admin/crm/partners` | `createPartner` |

- [ ] **Step 1: Write the failing test**

`services/api/test/crm/crmApi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { buildTestContext } from "../helpers";
import { Router } from "../../src/http/router";
import { registerCrmRoutes } from "../../src/http/crmApi";
import type { AppContext } from "../../src/lib/context";

function buildRouter(context: AppContext): Router {
  return registerCrmRoutes(new Router(), context);
}

function buildEvent(
  method: string,
  path: string,
  body?: unknown,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: "admin_1", email: "ops@rgs.test" } } },
    },
    ...(queryStringParameters ? { queryStringParameters } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function call(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEvent(method, path, body, query))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

describe("crm admin routes", () => {
  it("creates a partner then a case, and reads the case back", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);

    const partnerResponse = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    expect(partnerResponse.statusCode).toBe(200);
    const partnerId = partnerResponse.payload.partnerId;

    const caseResponse = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });
    expect(caseResponse.statusCode).toBe(200);
    expect(caseResponse.payload.caseStatus).toBe("NEW");

    const caseId = caseResponse.payload.caseId;
    const readResponse = await call(router, "GET", `/api/v1/admin/crm/cases/${caseId}`);
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.payload.caseRef).toBe("31377");
  });

  it("lists cases by status from the query parameter", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });

    const listed = await call(router, "GET", "/api/v1/admin/crm/cases", undefined, {
      status: "NEW",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.cases).toHaveLength(1);
  });

  it("moves the case status through PUT", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });

    const moved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/status`,
      { toStatus: "IN_PROGRESS" },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.payload.caseStatus).toBe("IN_PROGRESS");
  });

  it("returns 409 for an illegal transition", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });
    const caseId = created.payload.caseId;
    await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/status`, {
      toStatus: "WITHDRAWN",
    });
    const illegal = await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/status`, {
      toStatus: "IN_PROGRESS",
    });
    expect(illegal.statusCode).toBe(409);
  });

  it("returns 400 for a body that fails validation", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const bad = await call(router, "PUT", "/api/v1/admin/crm/cases/case_1/status", {
      toStatus: "NOT_A_STATUS",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("returns 404 for a case that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const missing = await call(router, "GET", "/api/v1/admin/crm/cases/nope");
    expect(missing.statusCode).toBe(404);
  });

  it("exposes the audit trail for a case", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });
    const events = await call(
      router,
      "GET",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/events`,
    );
    expect(events.statusCode).toBe(200);
    expect(events.payload.events[0].eventType).toBe("CASE_CREATED");
  });

  it("moves applicant custody through PUT", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_1" }],
    });
    const moved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/applicants/0/custody`,
      { toCustody: "WITH_RGS" },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.payload.applicants[0].custody).toBe("WITH_RGS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/api test crm/crmApi`
Expected: FAIL — cannot resolve `../../src/http/crmApi`.

- [ ] **Step 3: Write the routes**

`services/api/src/http/crmApi.ts`:

```ts
import { crm } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { badRequest } from "../lib/errors";
import {
  changeApplicantCustody,
  changeBillingStatus,
  changeCaseStatus,
  createCase,
  getCase,
  listCasesByStatus,
} from "../domain/crm/cases";
import { listCaseEvents } from "../domain/crm/crmEvents";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { createPartner, listPartners } from "../domain/crm/partners";
import { Router, parseBody } from "./router";
import { requireAdmin } from "./adminApi";

const CreatePartnerBody = z.object({
  canonicalName: z.string().min(1),
  partnerType: z.enum(crm.PARTNER_TYPES).optional(),
  aliases: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

const CreateCaseBody = z.object({
  caseRef: z.string().min(1),
  caseType: z.enum(crm.CASE_TYPES),
  partnerId: z.string().min(1),
  destinationCountry: z.string().length(2),
  visaType: z.enum(crm.VISA_TYPES).optional(),
  entryType: z.enum(crm.ENTRY_TYPES).optional(),
  processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  applicants: z
    .array(
      z.object({
        applicantRef: z.string().min(1),
        travellerId: z.string().min(1),
        passportNumber: z.string().optional(),
      }),
    )
    .min(1),
});

const CaseStatusBody = z.object({ toStatus: z.enum(crm.CASE_STATUSES) });
const BillingStatusBody = z.object({ toBillingStatus: z.enum(crm.BILLING_STATUSES) });
const CustodyBody = z.object({ toCustody: z.enum(crm.CUSTODY_STATUSES) });

/**
 * Mounted onto the admin router, so these inherit the admin Cognito authorizer
 * and the existing /api/v1/admin/{proxy+} API Gateway route — no CDK change.
 * PUT, never PATCH: PATCH is not among the routed admin methods.
 */
export function registerCrmRoutes(router: Router, context: AppContext): Router {
  const tenantId = DEFAULT_TENANT_ID;

  return router
    .add("GET", "/api/v1/admin/crm/partners", async (requestContext) => {
      requireAdmin(requestContext);
      return { partners: await listPartners(context, tenantId) };
    })
    .add("POST", "/api/v1/admin/crm/partners", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CreatePartnerBody, requestContext.body);
      return createPartner(context, tenantId, body, requestContext.callerEmail);
    })
    .add("GET", "/api/v1/admin/crm/cases", async (requestContext) => {
      requireAdmin(requestContext);
      const requestedStatus = requestContext.queryParams["status"] ?? "NEW";
      if (!crm.CASE_STATUSES.includes(requestedStatus as crm.CaseStatus)) {
        throw badRequest(`Unknown case status ${requestedStatus}`);
      }
      return {
        cases: await listCasesByStatus(context, tenantId, requestedStatus as crm.CaseStatus),
      };
    })
    .add("POST", "/api/v1/admin/crm/cases", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CreateCaseBody, requestContext.body);
      return createCase(context, tenantId, body, requestContext.callerEmail);
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireAdmin(requestContext);
      return getCase(context, tenantId, requestContext.pathParams["caseId"]!);
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}/events", async (requestContext) => {
      requireAdmin(requestContext);
      return {
        events: await listCaseEvents(context, tenantId, requestContext.pathParams["caseId"]!),
      };
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/status", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CaseStatusBody, requestContext.body);
      return changeCaseStatus(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        body.toStatus,
        requestContext.callerEmail,
      );
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/billing", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(BillingStatusBody, requestContext.body);
      return changeBillingStatus(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        body.toBillingStatus,
        requestContext.callerEmail,
      );
    })
    .add(
      "PUT",
      "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantIndex}/custody",
      async (requestContext) => {
        requireAdmin(requestContext);
        const body = parseBody(CustodyBody, requestContext.body);
        const applicantIndex = Number(requestContext.pathParams["applicantIndex"]);
        if (!Number.isInteger(applicantIndex) || applicantIndex < 0) {
          throw badRequest("applicantIndex must be a non-negative integer");
        }
        return changeApplicantCustody(
          context,
          tenantId,
          requestContext.pathParams["caseId"]!,
          applicantIndex,
          body.toCustody,
          requestContext.callerEmail,
        );
      },
    );
}
```

- [ ] **Step 4: Mount the routes into the admin router**

`services/api/src/http/adminApi.ts` currently reads (abridged):

```ts
function requireAdmin(requestContext: RequestContext): {
  adminId: string;
  adminEmail: string;
} {
  if (!requestContext.callerId) throw forbidden("Admin sign in required");
  return { adminId: requestContext.callerId, adminEmail: requestContext.callerEmail };
}

export function buildAdminRouter(context: AppContext): Router {
  return new Router()
    .add("GET", "/api/v1/admin/applications", async (requestContext) => {
      // ...many routes...
    });
}
```

Make exactly three edits, changing no existing route:

1. Export `requireAdmin` so `crmApi.ts` can use it — change `function requireAdmin(` to `export function requireAdmin(`.

2. Add the import beside the existing `./router` import:

```ts
import { registerCrmRoutes } from "./crmApi";
```

3. Capture the chain in a variable and pass it through `registerCrmRoutes`. Change the opening line of the builder from `return new Router()` to `const adminRouter = new Router()`, and change the final `});` that closes the chain to:

```ts
    });
  return registerCrmRoutes(adminRouter, context);
}
```

Note this creates a circular import between `adminApi.ts` and `crmApi.ts` (adminApi imports registerCrmRoutes; crmApi imports requireAdmin). ESM handles this because both are used only at call time, never at module evaluation time. If the test run reports `Cannot access 'requireAdmin' before initialization`, move `requireAdmin` into `services/api/src/http/adminAuth.ts` and import it from there in both files instead — do not work around it by duplicating the function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rgs/api test`
Expected: PASS — the 8 new route tests plus all 56 pre-existing API tests still green.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/http/crmApi.ts services/api/src/http/adminApi.ts \
        services/api/test/crm/crmApi.test.ts
git commit -m "feat(crm): expose CRM cases and partners on the admin API"
```

---

### Task 9: Full green gate and documentation

**Files:**
- Modify: `README.md`
- Test: no new test file; this task runs every existing gate.

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing consumed by later tasks. This is the merge gate.

**Context for the implementer:** This task exists to catch anything the per-module tests missed — particularly whether the CRM routes broke the deployed admin SPA's expectations, and whether `packages/shared` and `services/api` still typecheck together.

- [ ] **Step 1: Run every gate**

From the repo root, run each and record actual numbers:

```bash
pnpm -r typecheck
pnpm --filter @rgs/shared test
pnpm --filter @rgs/api test
pnpm --filter @rgs/admin build
pnpm --filter @rgs/portal build
```

Expected: `pnpm -r typecheck` clean across all 6 projects. `@rgs/shared` at 167 tests or more (baseline 165 plus Task 1's two). `@rgs/api` at 105 tests or more (baseline 56 plus roughly 49 new). Both SPA builds succeed.

If any gate fails, fix it before continuing — do not commit a red gate.

- [ ] **Step 2: Confirm no infrastructure change is needed**

Run:

```bash
grep -n "api/v1/admin" infra/lib/rgs-platform-stack.ts
```

Expected: the existing `/api/v1/admin/{proxy+}` route with GET, POST, PUT, DELETE. Confirm no CRM route uses PATCH:

```bash
grep -n '"PATCH"' services/api/src/http/crmApi.ts
```

Expected: no matches. If there is a match, that route will 404 in deployment — change it to PUT.

- [ ] **Step 3: Document the CRM surface in the README**

In `README.md`, in the `@rgs/shared` paragraph under "Repository layout", add a sentence after the existing status-machine sentence:

```markdown
The CRM domain core lives under `packages/shared/src/crm/` and is exported as the
`crm` namespace (`import { crm } from "@rgs/shared"`). It owns the three CRM
status axes (case, custody, billing), the spreadsheet normalizers, and the CRM
entity schemas. CRM persistence and routes live in
`services/api/src/domain/crm/` and `services/api/src/http/crmApi.ts`, mounted on
the admin API under `/api/v1/admin/crm/*`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe the CRM domain layer and admin routes"
```

---

## Done when

- `pnpm -r typecheck` is clean across all 6 workspace projects.
- `pnpm --filter @rgs/shared test` and `pnpm --filter @rgs/api test` are both green, including every pre-existing suite.
- Both SPA builds succeed.
- A case can be created, read, listed by status and by partner, and moved on all three axes through the admin API, with every mutation appearing in the case's audit trail.
- No route uses `PATCH`, and no CDK file was modified.
- Every CRM key written to the table carries a `TENANT#` segment.

## Next plan

Plan 3 — migration importer and review queue: read the workbook, run each row through the Plan 1 normalizers, apply the blank-cell rule from Task 1, write cases through `createCase`'s storage path with `billingStatus: UNKNOWN`, and queue for a human only the values that were present but unresolvable (about 1,016 rows, of which 644 are the three known ambiguous partner accounts).
