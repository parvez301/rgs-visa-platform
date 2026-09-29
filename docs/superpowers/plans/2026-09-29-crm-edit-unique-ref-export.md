# CRM: Edit Case After Create, Unique REF / REF NO, Excel Export — Implementation Plan

> **For agentic workers (Cursor):** Execute tasks strictly in order, one commit per task. Steps use checkbox (`- [ ]`) syntax. Every "Run" step lists the exact command and the expected result — if the result differs, STOP and fix before moving on. Do not skip the failing-test step: a test that never failed proves nothing.

**Goal:** Let the desk correct any case detail at any status after creation, refuse any REF or applicant REF NO that another case already uses, and export the Ledger's current view as an `.xlsx` file.

**Architecture:** Uniqueness is enforced by one small "ref claim" item per normalized reference value, written with a DynamoDB conditional put (`attribute_not_exists(PK)`), so two desks saving the same REF at the same moment cannot both succeed. `PUT /cases/{caseId}` is widened to every plain case field; three new applicant routes (update / add / remove) cover the people on a case. Export is a batched `POST /cases/export-rows` that returns flat per-applicant rows for the case ids the Ledger is showing; the admin builds the workbook in the browser with a lazily loaded `exceljs`.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, zod, AWS Lambda + DynamoDB single table (`@aws-sdk/lib-dynamodb`), React 19 + TanStack Query + Tailwind (admin), `exceljs@^4.4.0`.

**Spec:** No separate spec file. The design was agreed in chat on 2026-09-29 and is recorded in **Design** below — this plan is the spec.

---

## Owner request (verbatim, 2026-09-29)

> CASE DETAILS SHOULD BE MODIFIED AFTER GENERATING NEW CASE AT EVERY STAGE OF ENTRY
> REFRENCE NUMBER MUST BE UNIQUE AND SHOULD NOT BE DUPLICATE
> NEED OPTION TO EXPORT DATA IN EXCEL FORM

Choices made with the developer: **edit everything**; uniqueness on **case REF and applicant REF NO**; export the **current Ledger view**.

## Measured facts (2026-09-29) — do not re-derive

- Case page today edits only: status, billing, visa type, appointment date, group name, client email, per-applicant custody and outcome. REF, partner, country, case type, entry type, processing, received / submission / collection dates, remarks, and applicant name / passport / REF NO are locked after create. Applicants cannot be added or removed.
- `createCase` (`services/api/src/domain/crm/cases.ts:57`) never checks `caseRef`. Staging (`rgs-platform-staging`, ap-south-1, AWS profile `hireloop`) holds 7,160 cases with exactly one duplicated `caseRef`: `38017` (two cases). Prod holds 0 cases. No case has an applicant `refNo` yet.
- The importer already de-duplicated workbook refs (`38017-2` style suffixes) and raises `DUPLICATE_REF` review items; `DUPLICATE_REF` already exists in `crm.REVIEW_REASONS` and in `LEDGER_MARKER_REASONS`.
- Ledger filtering, search and sort run in the browser over loaded rows (`apps/admin/src/crm/ledger/LedgerPage.tsx`, `visibleLedgerRows`). The server cannot reproduce "what is on screen", so export sends case ids.
- API Lambda timeout is 15 s (`infra/lib/rgs-platform-stack.ts:126`). The admin proxy route already allows `DELETE` (`infra/lib/rgs-platform-stack.ts:296-302`) — **no infra change is needed**.
- `TableClient` (`services/api/src/lib/db.ts:74`) has no conditional write. It has three implementations that must all gain the new method: `DynamoTableClient`, `InMemoryTableClient` (same file) and the wrapper returned by `withWriteRetries` (`services/api/src/lib/tableRetry.ts:176`). One test fake also implements it: `tableFailingFirstWrites` in `services/api/test/tableRetry.test.ts:45`.
- Baseline pre-existing failures on `main` (NOT yours, do not fix): api `caseStore > round-trips` (1 fail), admin `LedgerTable > renders the spec's columns` (1 fail). Every "expected PASS" below means "no NEW failures beyond these two".

## Design

### D1. Ref claims (uniqueness)

- **Normalization:** `normalizeRefKey(value) = value.trim().replace(/\s+/g, " ").toUpperCase()`. `" 38017 "`, `"38017"` and `"rgs-1"` / `"RGS-1"` collide.
- **One namespace** for case REF and applicant REF NO: a REF NO may not equal another case's REF and vice versa. A REF NO **may** equal its **own** case's REF (single-person case typed twice), and two applicants in the **same** case may not share a REF NO (400).
- **Claim item:** `PK = TENANT#{tenantId}#REF_CLAIM#{refKey}`, `SK = META`, attributes `{ tenantId, refKey, refValue, caseId, claimedAt }`. Written with `putIfAbsent`. When the put loses, the existing claim is read: if it names the SAME `caseId` the claim is already ours (idempotent retry) — otherwise 409 `REF "<value>" is already used by another case.`
- **Diff only:** a write claims the keys the new case has that the previous version did not, and afterwards releases the keys the previous version had that the new one does not. Release reads the claim and deletes it only if it names this `caseId`. Unchanged values are never re-claimed, so a legacy duplicate (the second `38017`) can still have its remarks edited; it only hits the 409 if someone tries to set a REF that another case holds.
- **Order:** claim → `writeCase` → release stale. If `writeCase` throws, release the keys this call newly claimed, then rethrow.
- **Backfill:** a migration CLI claims every stored case's REF and REF NOs. A value already claimed by a different case gets a `DUPLICATE_REF` review item (so the desk renames it from the review screen / case page). Re-runnable.
- Status / billing / custody / outcome / checklist / invoice mutators do not touch refs and are unchanged.

### D2. Edit everything

- `PUT /api/v1/admin/crm/cases/{caseId}` accepts: `caseRef`, `caseType`, `partnerId`, `destinationCountry`, `receivedDate`, `visaType`, `entryType`, `processing`, `submissionDate`, `appointmentDate`, `expectedCollectionDate`, `remarks`, `groupName`, `clientEmail`. Every optional field except the first five also accepts `null` = clear. Still NOT a passthrough: `caseStatus`, `billingStatus`, custody, outcome keep their own routes.
- Leaving `VISA` drops `visaType` automatically. Moving to `VISA` without a `visaType` is a 400 (the schema's own "a VISA case needs a visaType").
- Collection date < received date stays a 400, checked against the NEW received date.
- Changing `partnerId` 404s on an unknown partner. The document checklist is NOT re-stamped when the country changes.
- Applicant routes:
  - `PUT /cases/{caseId}/applicants/{applicantRef}` body `{ fullName?, passportNumber?: string|null, refNo?: string|null }`. `fullName` is stored on the TRAVELLER, so it changes that person's name on every case they appear on (the UI says so). `passportNumber` updates the applicant and the traveller (and the traveller's passport index); a passport already on file for a DIFFERENT traveller is a 409.
  - `POST /cases/{caseId}/applicants` body `{ travellerId, passportNumber?, refNo? }`; the server assigns the next free `A{n}` `applicantRef`.
  - `DELETE /cases/{caseId}/applicants/{applicantRef}`: 409 when it is the last applicant, 409 when custody is `WITH_RGS`, `AT_EMBASSY` or `IN_TRANSIT` (we are holding the passport).
- Events: `CASE_UPDATED` (existing, `changedFields`), new `APPLICANT_UPDATED` (`applicantRef`, `changedFields`), `APPLICANT_ADDED` (`applicantRef`), `APPLICANT_REMOVED` (`applicantRef`). Timeline copy for all three.
- Admin: case page header gets **Edit details** (write role only). It opens `EditCaseDrawer`, pre-filled. Save sends: one `PUT` with only changed case fields → applicant `PUT`s → new applicants (`POST`, after the same traveller lookup/upsert the New Case drawer does) → removals (`DELETE`). It stops at the first failure and shows what was saved and what failed.

### D3. Excel export (current Ledger view)

- `POST /api/v1/admin/crm/cases/export-rows` body `{ caseIds: string[] }` (1..500, deduped). Response `{ rows: CaseExportRow[], missingCaseIds: string[] }`. Read-screen permission (`requireScreen(requestContext, "crm")`), not write.
- One row per applicant; case columns repeat on each applicant row. Raw enum values on the wire; the admin maps to labels.
- Admin Ledger toolbar gets **Export to Excel**. It chunks `visibleLedgerRows` case ids into 500s, calls the endpoint sequentially, shows `Exporting 500 of 7,160…`, builds the workbook with `exceljs` (dynamic `import()` so it is not in the main bundle), and downloads `rgs-ledger-YYYY-MM-DD.xlsx`. When the Ledger is partial (`isLedgerPartial`), the button's confirmation line says the file holds only the loaded rows.

## Global Constraints

- Always descriptive variable names (user rule). No `e`, `x`, `res`, `tmp`, `i` outside trivial index loops.
- Match surrounding style: comment density of the file you edit, named-field construction (never spread a request body onto a case), zod parse wrapped so `ZodError` becomes `badRequest(...)`.
- Every rejected operation throws a typed error from `services/api/src/lib/errors.ts` (`badRequest` 400, `notFound` 404, `conflict` 409). Never a bare `Error` from a request path.
- Never write `undefined` attribute values to DynamoDB — spread conditionally or delete undefined keys before `put`.
- API routes are `PUT` (never `PATCH`), under `/api/v1/admin/crm/...`.
- Six-segment literal routes (`/cases/export-rows`) must be registered BEFORE `/cases/{caseId}` routes of the same method.
- Commit messages: conventional (`feat(crm): ...`, `fix(admin): ...`), one commit per task.
- Deploy target for this work: **staging only**. Do not deploy prod, do not push unless asked.

## Review Focus

1. **Case-only difference** — `"rgs-100"` vs `"RGS-100 "` must be refused as a duplicate (pinned in Task 2 and Task 3).
2. **Two saves racing for one REF** — two concurrent `createCase` calls with the same REF: exactly one succeeds (pinned in Task 3 with `Promise.allSettled`).
3. **Failed case write leaves no orphan claim** — `writeCase` throwing after claims were written must release them, or the REF is burned forever (pinned in Task 3).
4. **Renaming a REF frees the old one** — after `A → B`, a new case may use `A` (pinned in Task 4).
5. **Export of a partially loaded Ledger** — the file must hold exactly the visible rows, and the UI must say when that is not the whole book (pinned in Task 10).

Also watch: `withWriteRetries` must delegate `putIfAbsent`, or production silently lacks the method while every in-memory test passes (pinned in Task 1).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `services/api/src/lib/db.ts` | modify | `putIfAbsent` on interface + both clients |
| `services/api/src/lib/tableRetry.ts` | modify | delegate `putIfAbsent` with retries |
| `services/api/src/domain/crm/keys.ts` | modify | `refClaimPartitionKey` |
| `services/api/src/domain/crm/refClaims.ts` | **create** | normalize, claim, release, distinct-REF-NO check |
| `services/api/src/domain/crm/cases.ts` | modify | createCase claims; updateCaseDetails widened |
| `services/api/src/domain/crm/applicantEdits.ts` | **create** | update / add / remove applicant |
| `services/api/src/domain/crm/travellers.ts` | modify | `updateTravellerDetails` |
| `services/api/src/domain/crm/crmEvents.ts` | modify | three new event types |
| `services/api/src/domain/crm/caseExport.ts` | **create** | build export rows for case ids |
| `packages/shared/src/crm/caseExport.ts` | **create** | `CaseExportRowSchema` shared by API and admin |
| `packages/shared/src/crm/index.ts` | modify | export the new module |
| `services/api/src/http/crmApi.ts` | modify | widened body, 4 new routes |
| `services/migration/src/backfillRefClaims.ts` + `runBackfillRefClaimsCli.ts` + `backfillRefClaimsCli.ts` | **create** | claim existing refs, flag duplicates |
| `services/migration/package.json` | modify | `backfill:ref-claims` script |
| `apps/admin/src/crm/api/crmClient.ts` | modify | new client methods + types |
| `apps/admin/src/crm/case/eventCopy.ts` | modify | timeline copy for new events |
| `apps/admin/src/crm/case/caseEditDiff.ts` | **create** | pure diff: drawer draft → API calls |
| `apps/admin/src/crm/case/EditCaseDrawer.tsx` | **create** | the edit drawer |
| `apps/admin/src/crm/case/CasePage.tsx` | modify | "Edit details" button |
| `apps/admin/src/crm/ledger/ledgerExport.ts` | **create** | fetch batches + build workbook |
| `apps/admin/src/crm/ledger/LedgerPage.tsx` | modify | "Export to Excel" button |
| `apps/admin/package.json` | modify | add `exceljs` |

Test commands (run from repo root):
- API: `pnpm --filter @rgs/api exec vitest run <path>`
- Admin: `pnpm --filter @rgs/admin exec vitest run <path>`
- Migration: `pnpm --filter @rgs/migration exec vitest run <path>`
- Shared: `pnpm --filter @rgs/shared exec vitest run`
- Types: `pnpm -r typecheck`

(If a filter name does not match, read the `name` field of that package's `package.json` and use it.)

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout main && git pull --ff-only || true && git checkout -b crm-edit-unique-export`
- [ ] **Step 2:** `pnpm install && pnpm -r test 2>&1 | tail -40` — record the baseline counts in your notes. Expected: only the two pre-existing failures listed above.

---

### Task 1: `putIfAbsent` on the table client

**Files:**
- Modify: `services/api/src/lib/db.ts` (interface at :74, `DynamoTableClient.put` at :131, `InMemoryTableClient.put` at :328)
- Modify: `services/api/src/lib/tableRetry.ts:210-224` (returned object)
- Modify: `services/api/test/tableRetry.test.ts:45-69` (`tableFailingFirstWrites` fake)
- Test: `services/api/test/db.test.ts`, `services/api/test/tableRetry.test.ts`

**Interfaces:**
- Produces: `TableClient.putIfAbsent(item: TableItem): Promise<boolean>` — `true` when written, `false` when an item with the same `PK`+`SK` already existed (nothing written).

- [ ] **Step 1: Write the failing tests** — append to `services/api/test/db.test.ts`:

```ts
describe("putIfAbsent", () => {
  it("InMemoryTableClient writes a new item and refuses to overwrite an existing one", async () => {
    const tableClient = new InMemoryTableClient();
    const firstWriteSucceeded = await tableClient.putIfAbsent({ PK: "CLAIM#1", SK: "META", owner: "first" });
    const secondWriteSucceeded = await tableClient.putIfAbsent({ PK: "CLAIM#1", SK: "META", owner: "second" });

    expect(firstWriteSucceeded).toBe(true);
    expect(secondWriteSucceeded).toBe(false);
    expect((await tableClient.get("CLAIM#1", "META"))?.["owner"]).toBe("first");
  });

  it("DynamoTableClient sends attribute_not_exists(PK) and maps a failed condition to false", async () => {
    const capturedInputs: Record<string, unknown>[] = [];
    const dynamoClient = new DynamoDBClient({
      region: "us-east-1",
      credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    });
    let requestCount = 0;
    dynamoClient.middlewareStack.add(
      () => async (handlerArguments) => {
        capturedInputs.push(handlerArguments.input as Record<string, unknown>);
        requestCount += 1;
        if (requestCount === 2) {
          const conditionFailure = new Error("The conditional request failed");
          conditionFailure.name = "ConditionalCheckFailedException";
          throw conditionFailure;
        }
        return { output: { $metadata: {} }, response: undefined };
      },
      { step: "initialize", priority: "high", name: "stubbedTransport" },
    );
    const tableClient = new DynamoTableClient("rgs-test-table", dynamoClient);

    expect(await tableClient.putIfAbsent({ PK: "CLAIM#1", SK: "META" })).toBe(true);
    expect(await tableClient.putIfAbsent({ PK: "CLAIM#1", SK: "META" })).toBe(false);
    expect(capturedInputs[0]?.["ConditionExpression"]).toBe("attribute_not_exists(PK)");
  });
});
```

Append to `services/api/test/tableRetry.test.ts`:

```ts
it("delegates putIfAbsent, so the production wrapper has the method the in-memory client has", async () => {
  const storage = new InMemoryTableClient();
  const retryingTable = withWriteRetries(storage, { onRetry: () => undefined });

  expect(await retryingTable.putIfAbsent(buildItem())).toBe(true);
  expect(await retryingTable.putIfAbsent(buildItem())).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/db.test.ts test/tableRetry.test.ts`
Expected: FAIL — `putIfAbsent is not a function` / TS error.

- [ ] **Step 3: Implement**

In `db.ts` interface `TableClient`, after `put`:

```ts
  /**
   * Writes `item` only when no item with the same PK+SK exists. Returns false
   * (and writes nothing) when one does. The building block for uniqueness:
   * two writers racing for one key cannot both see `true`.
   */
  putIfAbsent(item: TableItem): Promise<boolean>;
```

In `DynamoTableClient`, after `put`:

```ts
  async putIfAbsent(item: TableItem): Promise<boolean> {
    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
```

In `InMemoryTableClient`, after `put`:

```ts
  async putIfAbsent(item: TableItem): Promise<boolean> {
    const itemKey = InMemoryTableClient.itemKey(item.PK, item.SK);
    if (this.items.has(itemKey)) return false;
    this.items.set(itemKey, structuredClone(item));
    return true;
  }
```

In `tableRetry.ts`, in the returned object after `put`:

```ts
    // Retried like put. A retry after a write that DID land (timeout on the
    // response) comes back false; callers that care read the item and check
    // it is theirs -- refClaims.ts does exactly that.
    putIfAbsent: (item: TableItem) => withRetries(() => table.putIfAbsent(item)),
```

In `services/api/test/tableRetry.test.ts` `tableFailingFirstWrites`, add after `put`:

```ts
    putIfAbsent: async (item: TableItem) => {
      attemptLog.putAttempts += 1;
      if (attemptLog.putAttempts <= failureCount) throw error;
      return table.putIfAbsent(item);
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/api exec vitest run test/db.test.ts test/tableRetry.test.ts && pnpm --filter @rgs/api typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(api): conditional putIfAbsent on the table client"`

---

### Task 2: Ref claims module

**Files:**
- Modify: `services/api/src/domain/crm/keys.ts` (after `caseRefIndexPartitionKey`, :47)
- Create: `services/api/src/domain/crm/refClaims.ts`
- Test: `services/api/test/crm/refClaims.test.ts`

**Interfaces:**
- Consumes: `TableClient.putIfAbsent` (Task 1).
- Produces:
  - `normalizeRefKey(refValue: string): string`
  - `refKeysOfCase(crmCase: Pick<crm.CrmCase, "caseRef" | "applicants">): Map<string, string>` — normalized key → the value as typed.
  - `assertApplicantRefNosDistinct(crmCase: Pick<crm.CrmCase, "applicants">): void` — 400 on a repeat within one case.
  - `claimNewRefs(context, tenantId, caseId, previousCase | undefined, nextCase): Promise<string[]>` — claims keys in `nextCase` not in `previousCase`; returns the keys it newly wrote; 409 on a key held by another case (after releasing what it wrote this call).
  - `releaseRefKeys(context, tenantId, caseId, refKeys: Iterable<string>): Promise<void>` — deletes each claim only if it names `caseId`.
  - `staleRefKeys(previousCase, nextCase): string[]` — keys in previous not in next.
  - `readRefClaim(context, tenantId, refKey): Promise<RefClaim | undefined>`

- [ ] **Step 1: Write the failing test** — `services/api/test/crm/refClaims.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assertApplicantRefNosDistinct,
  claimNewRefs,
  normalizeRefKey,
  readRefClaim,
  refKeysOfCase,
  releaseRefKeys,
  staleRefKeys,
} from "../../src/domain/crm/refClaims";
import { buildTestContext } from "../helpers";

const TENANT_ID = "rgs";

function caseShape(caseRef: string, refNos: (string | undefined)[] = []) {
  return {
    caseRef,
    applicants: refNos.map((refNo, applicantIndex) => ({
      applicantRef: `A${applicantIndex + 1}`,
      travellerId: `trv_${applicantIndex}`,
      custody: "NOT_HELD" as const,
      outcome: "PENDING" as const,
      ...(refNo === undefined ? {} : { refNo }),
    })),
  };
}

describe("normalizeRefKey", () => {
  it("trims, collapses inner whitespace and uppercases", () => {
    expect(normalizeRefKey("  rgs-100 ")).toBe("RGS-100");
    expect(normalizeRefKey("RGS  100")).toBe("RGS 100");
  });
});

describe("refKeysOfCase", () => {
  it("collects the case REF and every applicant REF NO, one entry per normalized key", () => {
    const refKeys = refKeysOfCase(caseShape("38017", ["38017", "p-2", undefined]));
    expect([...refKeys.keys()]).toEqual(["38017", "P-2"]);
    expect(refKeys.get("P-2")).toBe("p-2");
  });
});

describe("assertApplicantRefNosDistinct", () => {
  it("refuses two applicants in one case with the same REF NO, ignoring case", () => {
    expect(() => assertApplicantRefNosDistinct(caseShape("1", ["ab-1", "AB-1 "]))).toThrow(/used twice/);
  });
  it("allows an applicant REF NO equal to its own case REF", () => {
    expect(() => assertApplicantRefNosDistinct(caseShape("38017", ["38017"]))).not.toThrow();
  });
});

describe("claimNewRefs / releaseRefKeys", () => {
  it("claims every new key and refuses a key another case holds, case-insensitively", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("rgs-100"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("RGS-100 ")),
    ).rejects.toMatchObject({ statusCode: 409, message: 'REF "RGS-100 " is already used by another case.' });
    expect((await readRefClaim(context, TENANT_ID, "RGS-100"))?.caseId).toBe("case_A");
  });

  it("releases what it claimed in the same call when a later key clashes", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("TAKEN"));

    await expect(
      claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("FRESH", ["TAKEN"])),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readRefClaim(context, TENANT_ID, "FRESH")).toBeUndefined();
  });

  it("treats a claim that already names this case as its own (idempotent retry)", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"));
    await expect(claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("R-1"))).resolves.toEqual([]);
  });

  it("claims only keys the previous version did not have", async () => {
    const context = buildTestContext();
    const newlyClaimed = await claimNewRefs(context, TENANT_ID, "case_A", caseShape("OLD"), caseShape("OLD", ["NEW-1"]));
    expect(newlyClaimed).toEqual(["NEW-1"]);
    expect(await readRefClaim(context, TENANT_ID, "OLD")).toBeUndefined();
  });

  it("release deletes only claims that name this case", async () => {
    const context = buildTestContext();
    await claimNewRefs(context, TENANT_ID, "case_A", undefined, caseShape("MINE"));
    await claimNewRefs(context, TENANT_ID, "case_B", undefined, caseShape("THEIRS"));

    await releaseRefKeys(context, TENANT_ID, "case_A", ["MINE", "THEIRS"]);
    expect(await readRefClaim(context, TENANT_ID, "MINE")).toBeUndefined();
    expect((await readRefClaim(context, TENANT_ID, "THEIRS"))?.caseId).toBe("case_B");
  });

  it("staleRefKeys lists keys dropped between versions", () => {
    expect(staleRefKeys(caseShape("A", ["X"]), caseShape("B", ["x"]))).toEqual(["A"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/refClaims.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/crm/refClaims`.

- [ ] **Step 3: Implement**

`keys.ts`, after `caseRefIndexPartitionKey`:

```ts
/**
 * The uniqueness claim for one normalized reference value (a case REF or an
 * applicant REF NO -- one namespace). Distinct from caseRefIndexPartitionKey:
 * that is the importer's idempotency anchor keyed on the raw ref; this is
 * the "no two cases share a reference" rule, keyed on the normalized one.
 */
export function refClaimPartitionKey(tenantId: string, refKey: string): string {
  return `TENANT#${tenantId}#REF_CLAIM#${refKey}`;
}
```

`services/api/src/domain/crm/refClaims.ts`:

```ts
import type { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict } from "../../lib/errors";
import { stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, refClaimPartitionKey } from "./keys";

/**
 * "REF must be unique" (owner, 2026-09-29), enforced by one claim item per
 * normalized reference value written with a conditional put. A case REF and
 * an applicant REF NO share one namespace; a REF NO may repeat its OWN case's
 * REF (a single-person case typed twice) but nothing else's.
 *
 * Diff-only by design: a write claims the keys the new version adds and
 * releases the keys it dropped. Unchanged values are never re-claimed, so a
 * legacy duplicate (staging's second 38017) can still have its remarks
 * edited -- it only meets the 409 when someone sets a REF another case holds.
 */
export interface RefClaim {
  tenantId: string;
  refKey: string;
  /** The value as it was typed, for the error message and the audit. */
  refValue: string;
  caseId: string;
  claimedAt: string;
}

type RefBearingCase = Pick<crm.CrmCase, "caseRef" | "applicants">;

export function normalizeRefKey(refValue: string): string {
  return refValue.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Normalized key -> the value as typed. The case REF first, then REF NOs in applicant order. */
export function refKeysOfCase(crmCase: RefBearingCase): Map<string, string> {
  const refValuesByKey = new Map<string, string>();
  const typedValues = [crmCase.caseRef, ...crmCase.applicants.map((applicant) => applicant.refNo)];
  for (const typedValue of typedValues) {
    if (typedValue === undefined || typedValue.trim() === "") continue;
    const refKey = normalizeRefKey(typedValue);
    if (!refValuesByKey.has(refKey)) refValuesByKey.set(refKey, typedValue);
  }
  return refValuesByKey;
}

export function assertApplicantRefNosDistinct(crmCase: Pick<crm.CrmCase, "applicants">): void {
  const seenRefKeys = new Set<string>();
  for (const applicant of crmCase.applicants) {
    if (applicant.refNo === undefined) continue;
    const refKey = normalizeRefKey(applicant.refNo);
    if (seenRefKeys.has(refKey)) {
      throw badRequest(`REF NO "${applicant.refNo}" is used twice on this case.`);
    }
    seenRefKeys.add(refKey);
  }
}

export async function readRefClaim(
  context: AppContext,
  tenantId: string,
  refKey: string,
): Promise<RefClaim | undefined> {
  // Consistent: a claim written a moment ago by the losing side of a race
  // must be visible to the reader deciding whether it is ours.
  const storedItem = await context.table.get(refClaimPartitionKey(tenantId, refKey), META_SORT_KEY, {
    consistentRead: true,
  });
  return storedItem === undefined ? undefined : (stripStorageKeys(storedItem) as unknown as RefClaim);
}

export async function claimNewRefs(
  context: AppContext,
  tenantId: string,
  caseId: string,
  previousCase: RefBearingCase | undefined,
  nextCase: RefBearingCase,
): Promise<string[]> {
  const previousRefKeys = previousCase === undefined ? new Set<string>() : new Set(refKeysOfCase(previousCase).keys());
  const newlyClaimedKeys: string[] = [];
  for (const [refKey, refValue] of refKeysOfCase(nextCase)) {
    if (previousRefKeys.has(refKey)) continue;
    const refClaim: RefClaim = { tenantId, refKey, refValue, caseId, claimedAt: context.now().toISOString() };
    const wasWritten = await context.table.putIfAbsent({
      PK: refClaimPartitionKey(tenantId, refKey),
      SK: META_SORT_KEY,
      ...refClaim,
    });
    if (wasWritten) {
      newlyClaimedKeys.push(refKey);
      continue;
    }
    const existingClaim = await readRefClaim(context, tenantId, refKey);
    if (existingClaim?.caseId === caseId) continue;
    await releaseRefKeys(context, tenantId, caseId, newlyClaimedKeys);
    throw conflict(`REF "${refValue}" is already used by another case.`);
  }
  return newlyClaimedKeys;
}

export async function releaseRefKeys(
  context: AppContext,
  tenantId: string,
  caseId: string,
  refKeys: Iterable<string>,
): Promise<void> {
  for (const refKey of refKeys) {
    const existingClaim = await readRefClaim(context, tenantId, refKey);
    if (existingClaim?.caseId !== caseId) continue;
    await context.table.delete(refClaimPartitionKey(tenantId, refKey), META_SORT_KEY);
  }
}

export function staleRefKeys(previousCase: RefBearingCase, nextCase: RefBearingCase): string[] {
  const nextRefKeys = new Set(refKeysOfCase(nextCase).keys());
  return [...refKeysOfCase(previousCase).keys()].filter((refKey) => !nextRefKeys.has(refKey));
}
```

Check `conflict()` in `lib/errors.ts` produces an `ApiError` with `statusCode: 409` and the message verbatim; if the property is named differently (e.g. `status`), adjust the test's `toMatchObject` key to match — do not change `errors.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/refClaims.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(crm): ref claims enforce unique REF and REF NO"`

---

### Task 3: `createCase` refuses a duplicate REF / REF NO

**Files:**
- Modify: `services/api/src/domain/crm/cases.ts:57-137` (`createCase`)
- Test: `services/api/test/crm/cases.test.ts` (append), `services/api/test/crm/crmApi.test.ts` (append)

**Interfaces:**
- Consumes: `claimNewRefs`, `releaseRefKeys`, `assertApplicantRefNosDistinct` (Task 2).

- [ ] **Step 1: Write the failing tests** — append to `services/api/test/crm/cases.test.ts` (reuse the file's existing seeding helpers where they exist; this block is self-contained):

```ts
import { readRefClaim } from "../../src/domain/crm/refClaims";

describe("createCase reference uniqueness", () => {
  async function seedPartnerAndTraveller(context: ReturnType<typeof buildTestContext>) {
    const partner = await createPartner(context, "rgs", { canonicalName: "Unique Travels", partnerType: "AGENCY" }, "desk@rgs.local");
    const traveller = await upsertTraveller(context, "rgs", { fullName: "RAVI KUMAR" });
    return { partnerId: partner.partnerId, travellerId: traveller.travellerId };
  }

  function caseInput(ids: { partnerId: string; travellerId: string }, caseRef: string, refNo?: string) {
    return {
      caseRef,
      caseType: "VISA" as const,
      visaType: "TOURIST" as const,
      partnerId: ids.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: ids.travellerId, ...(refNo === undefined ? {} : { refNo }) }],
    };
  }

  it("refuses a second case with the same REF, ignoring case and spaces", async () => {
    const context = buildTestContext();
    const ids = await seedPartnerAndTraveller(context);
    await createCase(context, "rgs", caseInput(ids, "rgs-100"), "desk@rgs.local");

    await expect(createCase(context, "rgs", caseInput(ids, " RGS-100"), "desk@rgs.local")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses a REF NO that is another case's REF", async () => {
    const context = buildTestContext();
    const ids = await seedPartnerAndTraveller(context);
    await createCase(context, "rgs", caseInput(ids, "50001"), "desk@rgs.local");

    await expect(createCase(context, "rgs", caseInput(ids, "50002", "50001"), "desk@rgs.local")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("lets exactly one of two racing creates win the same REF", async () => {
    const context = buildTestContext();
    const ids = await seedPartnerAndTraveller(context);
    const outcomes = await Promise.allSettled([
      createCase(context, "rgs", caseInput(ids, "RACE-1"), "desk@rgs.local"),
      createCase(context, "rgs", caseInput(ids, "RACE-1"), "desk@rgs.local"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("releases its claims when the case write fails, so the REF is not burned", async () => {
    const context = buildTestContext();
    const ids = await seedPartnerAndTraveller(context);
    // Fail only the case META write. Claims go through putIfAbsent, so they
    // still land -- which is exactly the state the rollback must undo.
    const originalPut = context.table.put.bind(context.table);
    context.table.put = async (item) => {
      if (item.SK === "META" && String(item.PK).includes("#CASE#")) throw new Error("dynamo down");
      return originalPut(item);
    };

    await expect(createCase(context, "rgs", caseInput(ids, "BURN-1", "BURN-1-P"), "desk@rgs.local")).rejects.toThrow("dynamo down");
    context.table.put = originalPut;
    expect(await readRefClaim(context, "rgs", "BURN-1")).toBeUndefined();
    expect(await readRefClaim(context, "rgs", "BURN-1-P")).toBeUndefined();
  });
});
```

Append to `services/api/test/crm/crmApi.test.ts` (use that file's existing `call`, `buildRouter`, and whatever helper it uses to seed a partner + traveller; search the file for an existing `POST /api/v1/admin/crm/cases` test and copy its body shape):

```ts
it("POST /cases answers 409 with a readable message for a duplicate REF", async () => {
  // Seed exactly as the existing create-case test in this file does, then:
  const firstResponse = await call(router, "POST", "/api/v1/admin/crm/cases", createBody);
  expect(firstResponse.statusCode).toBe(200);
  const secondResponse = await call(router, "POST", "/api/v1/admin/crm/cases", createBody);
  expect(secondResponse.statusCode).toBe(409);
  expect(secondResponse.payload.message).toBe(`REF "${createBody.caseRef}" is already used by another case.`);
});
```

(`createBody` = the body object the neighbouring create test builds. If the existing success status is 201, use 201.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/cases.test.ts test/crm/crmApi.test.ts`
Expected: the new tests FAIL (second create returns a case instead of 409).

- [ ] **Step 3: Implement** — in `createCase`, import at the top of `cases.ts`:

```ts
import { assertApplicantRefNosDistinct, claimNewRefs, releaseRefKeys } from "./refClaims";
```

Replace the tail of `createCase` from `await writeCase(context, crmCase);` down to (not including) `await recordCrmEvent(... "CASE_CREATED" ...)` with:

```ts
  assertApplicantRefNosDistinct(crmCase);
  // Claimed BEFORE the write so two racing creates cannot both land; released
  // again if the write fails, or the REF would stay taken by a case that does
  // not exist.
  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, crmCase.caseId, undefined, crmCase);
  try {
    await writeCase(context, crmCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, crmCase.caseId, newlyClaimedRefKeys);
    throw error;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm` 
Expected: PASS except the pre-existing `caseStore > round-trips`. If any OLD test now 409s because it creates two cases with the same `caseRef` on purpose/by copy-paste, give the second one a different ref — note each such change in the commit message.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(crm): createCase refuses a REF or REF NO another case holds"`

---

### Task 4: `updateCaseDetails` edits every plain field

**Files:**
- Modify: `services/api/src/domain/crm/cases.ts:144-283` (`UpdateCaseDetailsInput`, `updateCaseDetails`)
- Modify: `services/api/src/http/crmApi.ts:110-120` (`UpdateCaseDetailsBody`)
- Test: `services/api/test/crm/updateCaseDetails.test.ts` (append), `services/api/test/crm/crmApi.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 functions; `getPartnerOrThrow` (already imported in `cases.ts`).
- Produces: widened `UpdateCaseDetailsInput` (below). The admin mirror is added in Task 8.

- [ ] **Step 1: Write the failing tests** — append to `updateCaseDetails.test.ts` (it already has `seedOneCase` → case `90001`, VISA, JP):

```ts
describe("updateCaseDetails — every stage, every field", () => {
  it("changes REF, partner, country, received date and type, and records them", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const otherPartner = await createPartner(context, TENANT_ID, { canonicalName: "Blue Sky", partnerType: "AGENCY" }, ACTOR);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      {
        caseRef: "90001-B",
        partnerId: otherPartner.partnerId,
        destinationCountry: "FR",
        receivedDate: "2026-08-30",
        caseType: "ATTESTATION",
      },
      ACTOR,
    );

    expect(updated).toMatchObject({
      caseRef: "90001-B",
      partnerId: otherPartner.partnerId,
      destinationCountry: "FR",
      receivedDate: "2026-08-30",
      caseType: "ATTESTATION",
    });
    // Leaving VISA drops the visa type without a second request.
    expect(updated.visaType).toBeUndefined();
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvent = events.find((event) => event.eventType === "CASE_UPDATED");
    expect(String(updateEvent?.meta["changedFields"]).split(",").sort()).toEqual(
      ["caseRef", "caseType", "destinationCountry", "partnerId", "receivedDate", "visaType"].sort(),
    );
  });

  it("clears an optional field when sent null", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { remarks: "call first", processing: "EXPRESS" }, ACTOR);

    const cleared = await updateCaseDetails(context, TENANT_ID, seeded.caseId, { remarks: null, processing: null }, ACTOR);
    expect(cleared.remarks).toBeUndefined();
    expect(cleared.processing).toBeUndefined();
  });

  it("frees the old REF after a rename, and refuses a REF another case holds", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseRef: "RENAMED-1" }, ACTOR);

    // 90001 is free again: a new case may take it.
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "NEW PERSON" });
    const newCase = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "90001",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: seeded.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-02",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await expect(
      updateCaseDetails(context, TENANT_ID, newCase.caseId, { caseRef: "renamed-1" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("checks the collection date against the NEW received date", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { expectedCollectionDate: "2026-09-10" }, ACTOR);

    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { receivedDate: "2026-09-15" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on an unknown partner and 400s on VISA without a visa type", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { partnerId: "ptn_missing" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseType: "ATTESTATION" }, ACTOR);
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseType: "VISA" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

Check `crm.CASE_TYPES` in `packages/shared/src/crm/statuses.ts` — if `"ATTESTATION"` is not a member, use any non-`"VISA"` member. Import `createCase` if not imported.

Append to `crmApi.test.ts`:

```ts
it("PUT /cases/{caseId} accepts caseRef and null-clears remarks, and still ignores caseStatus", async () => {
  // seed one case exactly as the neighbouring PUT /cases/{caseId} test does -> `seededCaseId`
  const response = await call(router, "PUT", `/api/v1/admin/crm/cases/${seededCaseId}`, {
    caseRef: "EDITED-REF",
    remarks: null,
    caseStatus: "CLOSED",
  });
  expect(response.statusCode).toBe(200);
  expect(response.payload.caseRef).toBe("EDITED-REF");
  expect(response.payload.caseStatus).toBe("NEW");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/updateCaseDetails.test.ts test/crm/crmApi.test.ts`
Expected: new tests FAIL (TS errors on unknown input keys / unchanged values).

- [ ] **Step 3: Implement** — in `cases.ts`, replace `UpdateCaseDetailsInput` and the whole `updateCaseDetails` function (keep its doc comment, updating the field list) with:

```ts
export interface UpdateCaseDetailsInput {
  caseRef?: string;
  caseType?: crm.CaseType;
  partnerId?: string;
  destinationCountry?: string;
  receivedDate?: string;
  /** For every field below, `null` clears it; `undefined` leaves it alone. */
  visaType?: crm.VisaType | null;
  entryType?: crm.EntryType | null;
  processing?: crm.ProcessingSpeed | null;
  submissionDate?: string | null;
  appointmentDate?: string | null;
  expectedCollectionDate?: string | null;
  remarks?: string | null;
  groupName?: string | null;
  clientEmail?: string | null;
}

/**
 * Every field this route may move, by name. A closed list, never a spread of
 * the input: caseStatus, billingStatus, custody and outcome each have a state
 * machine and their own route, and anything not named here cannot reach the
 * case whatever extra keys the caller sends.
 */
const EDITABLE_CASE_FIELDS = [
  "caseRef",
  "caseType",
  "partnerId",
  "destinationCountry",
  "receivedDate",
  "visaType",
  "entryType",
  "processing",
  "submissionDate",
  "appointmentDate",
  "expectedCollectionDate",
  "remarks",
  "groupName",
  "clientEmail",
] as const satisfies readonly (keyof UpdateCaseDetailsInput & keyof crm.CrmCase)[];
type EditableCaseField = (typeof EDITABLE_CASE_FIELDS)[number];

export async function updateCaseDetails(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: UpdateCaseDetailsInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);

  // Named for the audit trail: a field that actually MOVED, not merely one the
  // caller supplied. `null` reads as "absent", so clearing an absent field is
  // no change at all.
  const nextFieldValues: Partial<Record<EditableCaseField, unknown>> = {};
  const changedFieldNames: EditableCaseField[] = [];
  for (const fieldName of EDITABLE_CASE_FIELDS) {
    const requestedValue = input[fieldName];
    if (requestedValue === undefined) continue;
    const nextValue = requestedValue ?? undefined;
    if (nextValue === currentCase[fieldName]) continue;
    nextFieldValues[fieldName] = nextValue;
    changedFieldNames.push(fieldName);
  }
  const nextCaseType = (nextFieldValues.caseType ?? currentCase.caseType) as crm.CaseType;
  if (nextCaseType !== "VISA" && currentCase.visaType !== undefined && !("visaType" in nextFieldValues)) {
    nextFieldValues.visaType = undefined;
    changedFieldNames.push("visaType");
  }

  if (changedFieldNames.length === 0) return currentCase;

  if ("partnerId" in nextFieldValues) {
    await getPartnerOrThrow(context, tenantId, nextFieldValues.partnerId as string);
  }
  const nextReceivedDate = (nextFieldValues.receivedDate ?? currentCase.receivedDate) as string;
  const nextCollectionDate =
    "expectedCollectionDate" in nextFieldValues
      ? (nextFieldValues.expectedCollectionDate as string | undefined)
      : currentCase.expectedCollectionDate;
  assertCollectionNotBeforeReceived(nextReceivedDate, nextCollectionDate);

  let updatedCase: crm.CrmCase;
  try {
    const { appointmentReminderSentFor, ...caseWithoutReminderStamp } = currentCase;
    const appointmentDateChanging = "appointmentDate" in nextFieldValues;
    const mergedCase: Record<string, unknown> = {
      ...caseWithoutReminderStamp,
      // A moved appointment must earn a fresh reminder; an unmoved one keeps its stamp.
      ...(appointmentDateChanging || appointmentReminderSentFor === undefined ? {} : { appointmentReminderSentFor }),
      ...nextFieldValues,
      updatedAt: context.now().toISOString(),
    };
    // DynamoDB refuses an undefined attribute; a cleared field must be absent.
    for (const [fieldName, fieldValue] of Object.entries(mergedCase)) {
      if (fieldValue === undefined) delete mergedCase[fieldName];
    }
    updatedCase = crm.CrmCaseSchema.parse(mergedCase);
  } catch (error) {
    if (error instanceof ZodError) throw badRequest(describeFirstZodIssue(error));
    throw error;
  }

  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, caseId, currentCase, updatedCase);
  try {
    await writeCase(context, updatedCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, caseId, newlyClaimedRefKeys);
    throw error;
  }
  await releaseRefKeys(context, tenantId, caseId, staleRefKeys(currentCase, updatedCase));

  await recordCrmEvent(context, tenantId, caseId, "CASE_UPDATED", actorEmail, {
    changedFields: changedFieldNames.join(","),
  });
  return updatedCase;
}
```

Keep whatever the old function did after writing that is not shown above (read the old body's tail from `await recordCrmEvent(` to `return` first — if it passed extra meta or did anything else, keep it). Add `staleRefKeys` to the `./refClaims` import.

In `crmApi.ts`, replace `UpdateCaseDetailsBody` with:

```ts
const UpdateCaseDetailsBody = z.object({
  caseRef: z.string().trim().min(1).max(40).optional(),
  caseType: z.enum(crm.CASE_TYPES).optional(),
  partnerId: z.string().min(1).optional(),
  destinationCountry: z.string().length(2).optional(),
  receivedDate: isoDateBody.optional(),
  visaType: z.enum(crm.VISA_TYPES).nullable().optional(),
  entryType: z.enum(crm.ENTRY_TYPES).nullable().optional(),
  processing: z.enum(crm.PROCESSING_SPEEDS).nullable().optional(),
  submissionDate: isoDateBody.nullable().optional(),
  appointmentDate: isoDateBody.nullable().optional(),
  expectedCollectionDate: isoDateBody.nullable().optional(),
  remarks: z.string().trim().min(1).max(2000).nullable().optional(),
  groupName: z.string().trim().min(1).max(120).nullable().optional(),
  clientEmail: z.string().trim().email().nullable().optional(),
});
```

Keep the comment above it but make it say "every plain field". Check the route handler at `crmApi.ts:310-320` passes `body` straight to `updateCaseDetails`; if it picks fields one by one, add the new ones.

Also check `services/api/src/agent/tools/writeTools.ts:216` still typechecks (it passes a subset; no change expected).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm && pnpm --filter @rgs/api typecheck`
Expected: PASS (minus the pre-existing failure). The original "changes only the six permitted fields" test must still pass untouched.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(crm): every plain case field is editable after create"`

---

### Task 5: Applicant update / add / remove

**Files:**
- Modify: `services/api/src/domain/crm/crmEvents.ts:5-25` (union)
- Modify: `services/api/src/domain/crm/travellers.ts` (add `updateTravellerDetails`)
- Create: `services/api/src/domain/crm/applicantEdits.ts`
- Modify: `services/api/src/http/crmApi.ts` (3 routes, after the `/outcome` route ~:422)
- Test: `services/api/test/crm/applicantEdits.test.ts`, `services/api/test/crm/crmApi.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 functions, `readCaseOrThrow`, `writeCase`, `recordCrmEvent`, `getTravellerOrThrow`, `findTravellerByPassport`.
- Produces:
  - `updateTravellerDetails(context, tenantId, travellerId, input: { fullName?: string; passportNumber?: string | null }): Promise<crm.CrmTraveller>`
  - `updateApplicantDetails(context, tenantId, caseId, applicantRef, input: UpdateApplicantInput, actorEmail): Promise<crm.CrmCase>` where `UpdateApplicantInput = { fullName?: string; passportNumber?: string | null; refNo?: string | null }`
  - `addApplicant(context, tenantId, caseId, input: AddApplicantInput, actorEmail): Promise<crm.CrmCase>` where `AddApplicantInput = { travellerId: string; passportNumber?: string; refNo?: string }`
  - `removeApplicant(context, tenantId, caseId, applicantRef, actorEmail): Promise<crm.CrmCase>`
  - Event types `"APPLICANT_UPDATED" | "APPLICANT_ADDED" | "APPLICANT_REMOVED"`.

- [ ] **Step 1: Write the failing test** — `services/api/test/crm/applicantEdits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCase, changeApplicantCustody } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { getTravellerOrThrow, upsertTraveller } from "../../src/domain/crm/travellers";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { addApplicant, removeApplicant, updateApplicantDetails } from "../../src/domain/crm/applicantEdits";
import { readRefClaim } from "../../src/domain/crm/refClaims";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedFamilyCase(context: TestContext) {
  const partner = await createPartner(context, TENANT_ID, { canonicalName: "Family Tours", partnerType: "AGENCY" }, ACTOR);
  const firstTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "ANIL SHARMA", passportNumber: "P1111111" });
  const secondTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "SITA SHARMA" });
  const crmCase = await createCase(
    context,
    TENANT_ID,
    {
      caseRef: "FAM-1",
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [
        { applicantRef: "A1", travellerId: firstTraveller.travellerId, passportNumber: "P1111111", refNo: "FAM-1-A" },
        { applicantRef: "A2", travellerId: secondTraveller.travellerId },
      ],
    },
    ACTOR,
  );
  return { crmCase, firstTraveller, secondTraveller };
}

describe("updateApplicantDetails", () => {
  it("renames the traveller, changes passport and REF NO, and records one event", async () => {
    const context = buildTestContext();
    const { crmCase, firstTraveller } = await seedFamilyCase(context);

    const updatedCase = await updateApplicantDetails(
      context,
      TENANT_ID,
      crmCase.caseId,
      "A1",
      { fullName: "ANIL K SHARMA", passportNumber: "P2222222", refNo: "FAM-1-X" },
      ACTOR,
    );

    expect(updatedCase.applicants[0]).toMatchObject({ passportNumber: "P2222222", refNo: "FAM-1-X" });
    const traveller = await getTravellerOrThrow(context, TENANT_ID, firstTraveller.travellerId);
    expect(traveller).toMatchObject({ fullName: "ANIL K SHARMA", passportNumber: "P2222222" });
    expect(await readRefClaim(context, TENANT_ID, "FAM-1-A")).toBeUndefined();
    expect((await readRefClaim(context, TENANT_ID, "FAM-1-X"))?.caseId).toBe(crmCase.caseId);
    const events = await listCaseEvents(context, TENANT_ID, crmCase.caseId);
    const applicantEvent = events.find((event) => event.eventType === "APPLICANT_UPDATED");
    expect(applicantEvent?.meta).toMatchObject({ applicantRef: "A1", changedFields: "fullName,passportNumber,refNo" });
  });

  it("clears a REF NO with null", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    const updatedCase = await updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A1", { refNo: null }, ACTOR);
    expect(updatedCase.applicants[0]?.refNo).toBeUndefined();
  });

  it("refuses a passport on file for a different traveller", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A2", { passportNumber: "P1111111" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a REF NO another applicant on the same case already has", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A2", { refNo: "fam-1-a" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on an unknown applicant", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A9", { refNo: "Z" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("addApplicant / removeApplicant", () => {
  it("adds a person under the next free applicantRef", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    const newTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "RIYA SHARMA" });

    const updatedCase = await addApplicant(
      context,
      TENANT_ID,
      crmCase.caseId,
      { travellerId: newTraveller.travellerId, refNo: "FAM-1-C" },
      ACTOR,
    );
    expect(updatedCase.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A1", "A2", "A3"]);
    expect(updatedCase.applicants[2]).toMatchObject({ custody: "NOT_HELD", outcome: "PENDING", refNo: "FAM-1-C" });
  });

  it("removes a person, frees their REF NO, and refuses the last one", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);

    const afterRemoval = await removeApplicant(context, TENANT_ID, crmCase.caseId, "A1", ACTOR);
    expect(afterRemoval.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A2"]);
    expect(await readRefClaim(context, TENANT_ID, "FAM-1-A")).toBeUndefined();
    await expect(removeApplicant(context, TENANT_ID, crmCase.caseId, "A2", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses to remove a person whose passport we are holding", async () => {
    const context = buildTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await changeApplicantCustody(context, TENANT_ID, crmCase.caseId, "A2", "WITH_RGS", ACTOR);
    await expect(removeApplicant(context, TENANT_ID, crmCase.caseId, "A2", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
```

Check `changeApplicantCustody`'s real signature in `cases.ts:317` and whether `NOT_HELD → WITH_RGS` is a legal move in `packages/shared/src/crm/stateMachines.ts`; adjust the call (not the assertion) to match.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/applicantEdits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`crmEvents.ts` union — add after `"APPLICANT_OUTCOME_CHANGED"`:

```ts
  | "APPLICANT_UPDATED"
  | "APPLICANT_ADDED"
  | "APPLICANT_REMOVED"
```

`travellers.ts` — add (imports: `conflict` from `../../lib/errors`, `stripStorageKeys` if not present):

```ts
export interface UpdateTravellerDetailsInput {
  fullName?: string;
  /** `null` clears the passport. */
  passportNumber?: string | null;
}

/**
 * A traveller is one person across every case, so a corrected name shows on
 * all of them -- the edit drawer says so. The name and passport indexes
 * (GSI2, GSI3) are rewritten with the item, and a passport already on file
 * for SOMEONE ELSE is refused: silently re-pointing it would merge two people.
 */
export async function updateTravellerDetails(
  context: AppContext,
  tenantId: string,
  travellerId: string,
  input: UpdateTravellerDetailsInput,
): Promise<crm.CrmTraveller> {
  const currentTraveller = await getTravellerOrThrow(context, tenantId, travellerId);
  const nextPassportNumber =
    input.passportNumber === undefined ? currentTraveller.passportNumber : (input.passportNumber ?? undefined);
  if (nextPassportNumber !== undefined && nextPassportNumber !== currentTraveller.passportNumber) {
    const passportHolder = await findTravellerByPassport(context, tenantId, nextPassportNumber);
    if (passportHolder !== undefined && passportHolder.travellerId !== travellerId) {
      throw conflict(`Passport ${nextPassportNumber} is already on file for ${passportHolder.fullName}.`);
    }
  }
  const nextFullName = input.fullName ?? currentTraveller.fullName;
  const { passportNumber: _previousPassportNumber, ...travellerWithoutPassport } = currentTraveller;
  let updatedTraveller: crm.CrmTraveller;
  try {
    updatedTraveller = crm.CrmTravellerSchema.parse({
      ...travellerWithoutPassport,
      fullName: nextFullName,
      normalizedName: normalizeTravellerName(nextFullName),
      ...(nextPassportNumber !== undefined ? { passportNumber: nextPassportNumber } : {}),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid traveller");
    }
    throw error;
  }
  await context.table.put({
    PK: travellerPartitionKey(tenantId, travellerId),
    SK: META_SORT_KEY,
    GSI2PK: travellerNameGsi2Pk(tenantId, updatedTraveller.normalizedName),
    GSI2SK: travellerId,
    ...(updatedTraveller.passportNumber !== undefined
      ? { GSI3PK: passportGsi3Pk(tenantId, updatedTraveller.passportNumber), GSI3SK: travellerId }
      : {}),
    ...updatedTraveller,
  });
  return updatedTraveller;
}
```

`services/api/src/domain/crm/applicantEdits.ts`:

```ts
import { crm } from "@rgs/shared";
import { ZodError } from "zod";
import type { AppContext } from "../../lib/context";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { readCaseOrThrow, writeCase } from "./caseStore";
import { recordCrmEvent } from "./crmEvents";
import { assertApplicantRefNosDistinct, claimNewRefs, releaseRefKeys, staleRefKeys } from "./refClaims";
import { getTravellerOrThrow, updateTravellerDetails } from "./travellers";

/**
 * Custody states in which the passport is physically with RGS or on its way
 * somewhere on RGS's behalf. Removing that person from the case would lose
 * track of a passport we are holding.
 */
const PASSPORT_HELD_CUSTODIES: readonly crm.CustodyStatus[] = ["WITH_RGS", "AT_EMBASSY", "IN_TRANSIT"];

export interface UpdateApplicantInput {
  fullName?: string;
  passportNumber?: string | null;
  refNo?: string | null;
}

export interface AddApplicantInput {
  travellerId: string;
  passportNumber?: string;
  refNo?: string;
}

/** The one write path for an applicant-list change: parse, claim, write, release. */
async function persistApplicantChange(
  context: AppContext,
  tenantId: string,
  currentCase: crm.CrmCase,
  nextApplicants: crm.CaseApplicant[],
): Promise<crm.CrmCase> {
  let updatedCase: crm.CrmCase;
  try {
    updatedCase = crm.CrmCaseSchema.parse({
      ...currentCase,
      applicants: nextApplicants,
      updatedAt: context.now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      throw badRequest(firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid case");
    }
    throw error;
  }
  assertApplicantRefNosDistinct(updatedCase);
  const newlyClaimedRefKeys = await claimNewRefs(context, tenantId, currentCase.caseId, currentCase, updatedCase);
  try {
    await writeCase(context, updatedCase);
  } catch (error) {
    await releaseRefKeys(context, tenantId, currentCase.caseId, newlyClaimedRefKeys);
    throw error;
  }
  await releaseRefKeys(context, tenantId, currentCase.caseId, staleRefKeys(currentCase, updatedCase));
  return updatedCase;
}

function findApplicantIndexOrThrow(crmCase: crm.CrmCase, applicantRef: string): number {
  const applicantIndex = crmCase.applicants.findIndex((applicant) => applicant.applicantRef === applicantRef);
  if (applicantIndex === -1) throw notFound("Applicant");
  return applicantIndex;
}

export async function updateApplicantDetails(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantRef: string,
  input: UpdateApplicantInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = findApplicantIndexOrThrow(currentCase, applicantRef);
  const currentApplicant = currentCase.applicants[applicantIndex]!;
  const traveller = await getTravellerOrThrow(context, tenantId, currentApplicant.travellerId);

  const changedFieldNames: string[] = [];
  const trimmedFullName = input.fullName?.trim();
  const fullNameChanging = trimmedFullName !== undefined && trimmedFullName !== traveller.fullName;
  if (fullNameChanging) changedFieldNames.push("fullName");
  const nextPassportNumber =
    input.passportNumber === undefined
      ? currentApplicant.passportNumber
      : (input.passportNumber?.trim().toUpperCase() || undefined);
  const passportChanging = nextPassportNumber !== currentApplicant.passportNumber;
  if (passportChanging) changedFieldNames.push("passportNumber");
  const nextRefNo = input.refNo === undefined ? currentApplicant.refNo : (input.refNo?.trim() || undefined);
  const refNoChanging = nextRefNo !== currentApplicant.refNo;
  if (refNoChanging) changedFieldNames.push("refNo");

  if (changedFieldNames.length === 0) return currentCase;

  // Traveller first: its passport clash check is the one refusal that can
  // come from outside this case, so it must fail before the case is touched.
  if (fullNameChanging || passportChanging) {
    await updateTravellerDetails(context, tenantId, currentApplicant.travellerId, {
      ...(fullNameChanging ? { fullName: trimmedFullName } : {}),
      ...(passportChanging ? { passportNumber: nextPassportNumber ?? null } : {}),
    });
  }

  const { passportNumber: _previousPassport, refNo: _previousRefNo, ...applicantBase } = currentApplicant;
  const nextApplicant: crm.CaseApplicant = {
    ...applicantBase,
    ...(nextPassportNumber !== undefined ? { passportNumber: nextPassportNumber } : {}),
    ...(nextRefNo !== undefined ? { refNo: nextRefNo } : {}),
  };
  const nextApplicants = currentCase.applicants.map((applicant, index) =>
    index === applicantIndex ? nextApplicant : applicant,
  );
  // Always rewritten, even for a name-only change: writeCase recomputes the
  // Ledger's search haystack from the traveller names.
  const updatedCase = await persistApplicantChange(context, tenantId, currentCase, nextApplicants);
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_UPDATED", actorEmail, {
    applicantRef,
    changedFields: changedFieldNames.join(","),
  });
  return updatedCase;
}

export async function addApplicant(
  context: AppContext,
  tenantId: string,
  caseId: string,
  input: AddApplicantInput,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  await getTravellerOrThrow(context, tenantId, input.travellerId);
  const usedApplicantRefs = new Set(currentCase.applicants.map((applicant) => applicant.applicantRef));
  let applicantNumber = currentCase.applicants.length + 1;
  while (usedApplicantRefs.has(`A${applicantNumber}`)) applicantNumber += 1;
  const applicantRef = `A${applicantNumber}`;
  const trimmedRefNo = input.refNo?.trim();
  const newApplicant: crm.CaseApplicant = {
    applicantRef,
    travellerId: input.travellerId,
    ...(input.passportNumber !== undefined ? { passportNumber: input.passportNumber.trim().toUpperCase() } : {}),
    ...(trimmedRefNo ? { refNo: trimmedRefNo } : {}),
    custody: "NOT_HELD",
    outcome: "PENDING",
  };
  const updatedCase = await persistApplicantChange(context, tenantId, currentCase, [
    ...currentCase.applicants,
    newApplicant,
  ]);
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_ADDED", actorEmail, { applicantRef });
  return updatedCase;
}

export async function removeApplicant(
  context: AppContext,
  tenantId: string,
  caseId: string,
  applicantRef: string,
  actorEmail: string,
): Promise<crm.CrmCase> {
  const currentCase = await readCaseOrThrow(context, tenantId, caseId);
  const applicantIndex = findApplicantIndexOrThrow(currentCase, applicantRef);
  if (currentCase.applicants.length === 1) {
    throw conflict("A case needs at least one applicant. Add the right person before removing this one.");
  }
  const applicantToRemove = currentCase.applicants[applicantIndex]!;
  if (PASSPORT_HELD_CUSTODIES.includes(applicantToRemove.custody)) {
    throw conflict("This person's passport is with us. Return it (custody) before removing them from the case.");
  }
  const updatedCase = await persistApplicantChange(
    context,
    tenantId,
    currentCase,
    currentCase.applicants.filter((_, index) => index !== applicantIndex),
  );
  await recordCrmEvent(context, tenantId, caseId, "APPLICANT_REMOVED", actorEmail, { applicantRef });
  return updatedCase;
}
```

If `readCaseOrThrow` is exported from `caseStore.ts` (it is, :115) keep the import; verify `crm.CustodyStatus` exists (it does, `statuses.ts:37`).

`crmApi.ts` — bodies near the other bodies:

```ts
const UpdateApplicantBody = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  passportNumber: z.string().trim().min(1).max(20).nullable().optional(),
  refNo: z.string().trim().min(1).max(40).nullable().optional(),
});

const AddApplicantBody = z.object({
  travellerId: z.string().min(1),
  passportNumber: z.string().trim().min(1).max(20).optional(),
  refNo: z.string().trim().min(1).max(40).optional(),
});
```

Routes, after the `/outcome` route:

```ts
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}", async (requestContext) => {
      requireWrite(requestContext, "crm");
      const body = parseBody(UpdateApplicantBody, requestContext.body);
      return updateApplicantDetails(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        requestContext.pathParams["applicantRef"]!,
        body,
        requestContext.callerEmail,
      );
    })
    .add("POST", "/api/v1/admin/crm/cases/{caseId}/applicants", async (requestContext) => {
      requireWrite(requestContext, "crm");
      const body = parseBody(AddApplicantBody, requestContext.body);
      return addApplicant(context, tenantId, requestContext.pathParams["caseId"]!, body, requestContext.callerEmail);
    })
    .add("DELETE", "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}", async (requestContext) => {
      requireWrite(requestContext, "crm");
      return removeApplicant(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        requestContext.pathParams["applicantRef"]!,
        requestContext.callerEmail,
      );
    })
```

Router-level test — append to `crmApi.test.ts`:

```ts
it("applicant routes: PUT edits, POST adds, DELETE removes, and a Viewer is refused", async () => {
  // seed a two-applicant case the way this file seeds cases -> `seededCaseId`, traveller id `extraTravellerId`
  const putResponse = await call(router, "PUT", `/api/v1/admin/crm/cases/${seededCaseId}/applicants/A1`, { refNo: "R-A1" });
  expect(putResponse.statusCode).toBe(200);
  expect(putResponse.payload.applicants[0].refNo).toBe("R-A1");

  const postResponse = await call(router, "POST", `/api/v1/admin/crm/cases/${seededCaseId}/applicants`, {
    travellerId: extraTravellerId,
  });
  expect(postResponse.statusCode).toBe(200);
  const addedRef = postResponse.payload.applicants.at(-1).applicantRef;

  const deleteResponse = await call(router, "DELETE", `/api/v1/admin/crm/cases/${seededCaseId}/applicants/${addedRef}`);
  expect(deleteResponse.statusCode).toBe(200);
});
```

(If the file has a helper for a Viewer-role event, add a Viewer `PUT` expecting 403; otherwise skip that clause and drop "and a Viewer is refused" from the title.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/api exec vitest run test/crm && pnpm --filter @rgs/api typecheck`
Expected: PASS (minus pre-existing).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(crm): edit, add and remove applicants on an existing case"`

---

### Task 6: Backfill ref claims for existing cases

**Files:**
- Create: `services/migration/src/backfillRefClaims.ts`, `services/migration/src/runBackfillRefClaimsCli.ts`, `services/migration/src/backfillRefClaimsCli.ts`
- Modify: `services/migration/package.json` scripts
- Test: `services/migration/test/backfillRefClaims.test.ts`

**Interfaces:**
- Consumes: `listCaseRefsByStatus` (`cases.ts:548`), `readCase`, `claimNewRefs`, `recordReviewItem` (`reviewQueue.ts:58`), `CorruptRecordError`.
- Produces: `backfillRefClaims(context, tenantId, options?): Promise<RefClaimBackfillReport>` with `RefClaimBackfillReport = { scanned: number; claimed: number; alreadyClaimed: number; duplicates: { caseId: string; caseRef: string; refValue: string }[]; unreadableCaseIds: string[] }`.

- [ ] **Step 1: Write the failing test** — `services/migration/test/backfillRefClaims.test.ts` (mirror the imports of `backfillLedgerSearchText.test.ts` for building a context and seeding cases; cases MUST be seeded with `writeCase` directly, not `createCase`, because pre-feature data has no claims):

```ts
import { describe, expect, it } from "vitest";
import { backfillRefClaims } from "../src/backfillRefClaims";
import { readRefClaim } from "@rgs/api/src/domain/crm/refClaims";
import { listReviewItems } from "@rgs/api/src/domain/crm/reviewQueue";
// + the context/seed helpers backfillLedgerSearchText.test.ts uses

describe("backfillRefClaims", () => {
  it("claims every stored REF, flags the second holder of a duplicate, and is re-runnable", async () => {
    // seed via writeCase: case_1 caseRef "38017"; case_2 caseRef "38017"; case_3 caseRef "40000" with applicant refNo "40000-B"
    const firstReport = await backfillRefClaims(context, "rgs");

    expect(firstReport.scanned).toBe(3);
    expect(firstReport.duplicates).toHaveLength(1);
    expect(firstReport.duplicates[0]?.refValue).toBe("38017");
    expect(await readRefClaim(context, "rgs", "40000-B")).toBeDefined();
    const reviewItems = await listReviewItems(context, "rgs" /* + whatever args it needs for OPEN */);
    expect(reviewItems.items.filter((item) => item.reason === "DUPLICATE_REF" && item.caseRef === "38017")).toHaveLength(1);

    const secondReport = await backfillRefClaims(context, "rgs");
    expect(secondReport.claimed).toBe(0);
    expect(secondReport.duplicates).toHaveLength(1);
    // Re-running must not raise a second review item for the same clash.
    const reviewItemsAfterRerun = await listReviewItems(context, "rgs" /* same args */);
    expect(reviewItemsAfterRerun.items.filter((item) => item.reason === "DUPLICATE_REF" && item.caseRef === "38017")).toHaveLength(1);
  });
});
```

Read `listReviewItems`'s signature (`reviewQueue.ts:122`) and fix the call and the `.items` access to its real return shape before running.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/migration exec vitest run test/backfillRefClaims.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `services/migration/src/backfillRefClaims.ts`:

```ts
import { readCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseRefsByStatus } from "@rgs/api/src/domain/crm/cases";
import { claimNewRefs, normalizeRefKey, readRefClaim, refKeysOfCase } from "@rgs/api/src/domain/crm/refClaims";
import { listReviewItems, recordReviewItem } from "@rgs/api/src/domain/crm/reviewQueue";
import { ApiError, CorruptRecordError } from "@rgs/api/src/lib/errors";
import type { AppContext } from "@rgs/api/src/lib/context";
import { crm } from "@rgs/shared";

export interface RefClaimBackfillReport {
  scanned: number;
  claimed: number;
  alreadyClaimed: number;
  duplicates: { caseId: string; caseRef: string; refValue: string }[];
  unreadableCaseIds: string[];
}

/** Review items need a provenance row; there is no workbook row for this one. */
const BACKFILL_SOURCE_SHEET = "ref-claims-backfill";

/**
 * Gives every case stored before uniqueness existed its ref claims. The first
 * case to be swept keeps a contested value; every later holder is reported
 * and gets ONE open DUPLICATE_REF review item (re-runs do not add more), so a
 * human renames it from the case page. No case is modified.
 */
export async function backfillRefClaims(
  context: AppContext,
  tenantId: string,
  options: { onProgress?: (scanned: number) => void } = {},
): Promise<RefClaimBackfillReport> {
  const report: RefClaimBackfillReport = { scanned: 0, claimed: 0, alreadyClaimed: 0, duplicates: [], unreadableCaseIds: [] };
  const openDuplicateKeys = await loadOpenDuplicateReviewKeys(context, tenantId);

  for (const caseStatus of crm.CASE_STATUSES) {
    const { storedCaseRefs, unreadableCaseIds } = await listCaseRefsByStatus(context, tenantId, caseStatus, undefined);
    report.unreadableCaseIds.push(...unreadableCaseIds);
    for (const { caseId } of storedCaseRefs) {
      report.scanned += 1;
      options.onProgress?.(report.scanned);
      let storedCase;
      try {
        storedCase = await readCase(context, tenantId, caseId);
      } catch (error) {
        if (!(error instanceof CorruptRecordError)) throw error;
        report.unreadableCaseIds.push(caseId);
        continue;
      }
      if (storedCase === undefined) continue;

      // One value at a time, so a clash on the REF does not stop the REF NOs
      // behind it from being claimed.
      for (const [refKey, refValue] of refKeysOfCase(storedCase)) {
        const existingClaim = await readRefClaim(context, tenantId, refKey);
        if (existingClaim?.caseId === caseId) {
          report.alreadyClaimed += 1;
          continue;
        }
        try {
          await claimNewRefs(context, tenantId, caseId, undefined, { caseRef: refValue, applicants: [] });
          report.claimed += 1;
        } catch (error) {
          if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
          report.duplicates.push({ caseId, caseRef: storedCase.caseRef, refValue });
          const duplicateKey = `${storedCase.caseRef}|${normalizeRefKey(refValue)}`;
          if (openDuplicateKeys.has(duplicateKey)) continue;
          await recordReviewItem(context, tenantId, {
            reason: "DUPLICATE_REF",
            sourceSheet: BACKFILL_SOURCE_SHEET,
            sourceRow: report.scanned,
            caseRef: storedCase.caseRef,
            fieldName: "REF NO.",
            rawValue: refValue,
            detail: `"${refValue}" is also used by another case, which keeps it. Rename this case's REF or REF NO (case id ${caseId}).`,
          });
          openDuplicateKeys.add(duplicateKey);
        }
      }
    }
  }
  return report;
}

async function loadOpenDuplicateReviewKeys(context: AppContext, tenantId: string): Promise<Set<string>> {
  // Adapt this call to listReviewItems' real signature (reviewQueue.ts:122):
  // it must return every OPEN item, draining all pages.
  const openItems = await listReviewItems(context, tenantId /* , "OPEN", ... */);
  const openDuplicateKeys = new Set<string>();
  for (const reviewItem of openItems.items) {
    if (reviewItem.reason !== "DUPLICATE_REF" || reviewItem.sourceSheet !== BACKFILL_SOURCE_SHEET) continue;
    openDuplicateKeys.add(`${reviewItem.caseRef}|${normalizeRefKey(reviewItem.rawValue)}`);
  }
  return openDuplicateKeys;
}
```

Check `ApiError`'s status property name in `lib/errors.ts` (`statusCode` assumed) and fix if different. If `listReviewItems` pages, loop until the cursor is empty.

`runBackfillRefClaimsCli.ts` — copy `runBackfillSearchTextCli.ts` exactly, swapping the function and the summary:

```ts
import { DEFAULT_TENANT_ID } from "@rgs/api/src/domain/crm/keys";
import type { AppContext } from "@rgs/api/src/lib/context";
import { backfillRefClaims, type RefClaimBackfillReport } from "./backfillRefClaims";

export interface RefClaimCliDependencies {
  buildContext: () => AppContext;
  logLine: (message: string) => void;
  logError: (message: string) => void;
  logSummary: (summary: Record<string, unknown>) => void;
}

export async function runBackfillRefClaimsCli(
  dependencies: RefClaimCliDependencies,
): Promise<{ exitCode: number; report: RefClaimBackfillReport }> {
  const context = dependencies.buildContext();
  const report = await backfillRefClaims(context, DEFAULT_TENANT_ID, {
    onProgress: (scanned) => {
      if (scanned % 250 === 0) dependencies.logLine(`...${scanned} cases scanned`);
    },
  });
  dependencies.logSummary({
    scanned: report.scanned,
    claimed: report.claimed,
    alreadyClaimed: report.alreadyClaimed,
    duplicates: report.duplicates.length,
    unreadable: report.unreadableCaseIds.length,
  });
  for (const duplicate of report.duplicates) {
    dependencies.logError(`Duplicate: case ${duplicate.caseId} (REF ${duplicate.caseRef}) also uses "${duplicate.refValue}"`);
  }
  return { exitCode: 0, report };
}
```

`backfillRefClaimsCli.ts`:

```ts
#!/usr/bin/env node
import { buildProductionContext } from "@rgs/api/src/http/handler";
import { runBackfillRefClaimsCli } from "./runBackfillRefClaimsCli";

const cliResult = await runBackfillRefClaimsCli({
  buildContext: buildProductionContext,
  logLine: (message) => console.log(message),
  logError: (message) => console.error(message),
  logSummary: (summary) => console.table(summary),
});

process.exitCode = cliResult.exitCode;
```

`services/migration/package.json` scripts: add `"backfill:ref-claims": "tsx src/backfillRefClaimsCli.ts"`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/migration exec vitest run && pnpm --filter @rgs/migration typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(migration): backfill ref claims and flag existing duplicate REFs"`

---

### Task 7: Export rows endpoint

**Files:**
- Create: `packages/shared/src/crm/caseExport.ts`; Modify: `packages/shared/src/crm/index.ts`
- Create: `services/api/src/domain/crm/caseExport.ts`
- Modify: `services/api/src/http/crmApi.ts` (body + route, registered right after the `GET /cases/ledger` route)
- Test: `services/api/test/crm/caseExport.test.ts`, `services/api/test/crm/crmApi.test.ts` (append)

**Interfaces:**
- Produces (shared): `crm.CaseExportRowSchema`, `type crm.CaseExportRow`, `crm.MAX_EXPORT_CASE_IDS = 500`.
- Produces (api): `buildCaseExportRows(context, tenantId, caseIds: readonly string[]): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }>`.

- [ ] **Step 1: Write the failing test** — `services/api/test/crm/caseExport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCaseExportRows } from "../../src/domain/crm/caseExport";
import { createCase } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { buildTestContext } from "../helpers";

describe("buildCaseExportRows", () => {
  it("returns one row per applicant in the order asked, with partner and traveller names, and lists missing ids", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, "rgs", { canonicalName: "Export Tours", partnerType: "AGENCY" }, "desk@rgs.local");
    const firstTraveller = await upsertTraveller(context, "rgs", { fullName: "MEERA IYER", passportNumber: "M1234567" });
    const secondTraveller = await upsertTraveller(context, "rgs", { fullName: "RAJ IYER" });
    const familyCase = await createCase(
      context,
      "rgs",
      {
        caseRef: "EXP-1",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        remarks: "priority",
        groupName: "Iyer Family",
        clientEmail: "meera@example.com",
        applicants: [
          { applicantRef: "A1", travellerId: firstTraveller.travellerId, passportNumber: "M1234567", refNo: "EXP-1-A" },
          { applicantRef: "A2", travellerId: secondTraveller.travellerId },
        ],
      },
      "desk@rgs.local",
    );

    const exportResult = await buildCaseExportRows(context, "rgs", [familyCase.caseId, "case_missing"]);

    expect(exportResult.missingCaseIds).toEqual(["case_missing"]);
    expect(exportResult.rows).toHaveLength(2);
    expect(exportResult.rows[0]).toMatchObject({
      caseRef: "EXP-1",
      groupName: "Iyer Family",
      partnerName: "Export Tours",
      destinationCountry: "JP",
      caseStatus: "NEW",
      remarks: "priority",
      clientEmail: "meera@example.com",
      applicantRefNo: "EXP-1-A",
      applicantName: "MEERA IYER",
      passportNumber: "M1234567",
      custody: "NOT_HELD",
      outcome: "PENDING",
    });
    expect(exportResult.rows[1]).toMatchObject({ applicantRefNo: "A2", applicantName: "RAJ IYER" });
  });
});
```

Append to `crmApi.test.ts`:

```ts
it("POST /cases/export-rows refuses an empty or oversized batch and is not shadowed by /cases/{caseId}", async () => {
  expect((await call(router, "POST", "/api/v1/admin/crm/cases/export-rows", { caseIds: [] })).statusCode).toBe(400);
  const tooMany = Array.from({ length: 501 }, (_, index) => `case_${index}`);
  expect((await call(router, "POST", "/api/v1/admin/crm/cases/export-rows", { caseIds: tooMany })).statusCode).toBe(400);
  const okResponse = await call(router, "POST", "/api/v1/admin/crm/cases/export-rows", { caseIds: ["case_nope"] });
  expect(okResponse.statusCode).toBe(200);
  expect(okResponse.payload).toEqual({ rows: [], missingCaseIds: ["case_nope"] });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/api exec vitest run test/crm/caseExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/shared/src/crm/caseExport.ts`:

```ts
import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  CUSTODY_STATUSES,
  ENTRY_TYPES,
  PROCESSING_SPEEDS,
  VISA_TYPES,
} from "./statuses";

/** The largest id batch one export-rows call accepts -- keeps a call well inside the 15 s Lambda timeout. */
export const MAX_EXPORT_CASE_IDS = 500;

/**
 * One spreadsheet row: one applicant, with their case's columns repeated.
 * Enum values stay raw on the wire; the admin maps them to labels.
 */
export const CaseExportRowSchema = z.object({
  caseId: z.string(),
  caseRef: z.string(),
  groupName: z.string().optional(),
  partnerName: z.string(),
  destinationCountry: z.string(),
  caseType: z.enum(CASE_TYPES),
  visaType: z.enum(VISA_TYPES).optional(),
  entryType: z.enum(ENTRY_TYPES).optional(),
  processing: z.enum(PROCESSING_SPEEDS).optional(),
  caseStatus: z.enum(CASE_STATUSES),
  billingStatus: z.enum(BILLING_STATUSES),
  receivedDate: z.string(),
  submissionDate: z.string().optional(),
  appointmentDate: z.string().optional(),
  expectedCollectionDate: z.string().optional(),
  totalInr: z.number(),
  clientEmail: z.string().optional(),
  remarks: z.string().optional(),
  applicantRefNo: z.string(),
  applicantName: z.string(),
  passportNumber: z.string().optional(),
  custody: z.enum(CUSTODY_STATUSES),
  outcome: z.enum(APPLICANT_OUTCOMES),
  trackingNumber: z.string().optional(),
});
export type CaseExportRow = z.infer<typeof CaseExportRowSchema>;
```

Verify each imported constant actually lives in `./statuses` (some may be in `./schemas` or elsewhere — `grep -n "export const ENTRY_TYPES\|PROCESSING_SPEEDS\|VISA_TYPES\|CASE_TYPES\|BILLING_STATUSES" packages/shared/src/crm/*.ts`) and fix the import paths. Add `export * from "./caseExport";` to `packages/shared/src/crm/index.ts` following its existing style.

`services/api/src/domain/crm/caseExport.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { CorruptRecordError } from "../../lib/errors";
import { readCase } from "./caseStore";
import { resolveCaseTravellers } from "./caseTravellers";
import { listPartners } from "./partners";

/** Parallel reads per batch: fast enough for 500 cases in a few seconds, gentle on on-demand capacity. */
const EXPORT_READ_CONCURRENCY = 20;

async function mapWithConcurrency<InputType, OutputType>(
  inputs: readonly InputType[],
  concurrencyLimit: number,
  mapInput: (input: InputType) => Promise<OutputType>,
): Promise<OutputType[]> {
  const outputs: OutputType[] = new Array(inputs.length);
  let nextInputIndex = 0;
  async function drainQueue(): Promise<void> {
    while (nextInputIndex < inputs.length) {
      const inputIndex = nextInputIndex;
      nextInputIndex += 1;
      outputs[inputIndex] = await mapInput(inputs[inputIndex]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencyLimit, inputs.length) }, drainQueue));
  return outputs;
}

/**
 * The rows behind the Ledger's "Export to Excel". The caller sends the case
 * ids it is SHOWING (filters and search run in the browser, so the server
 * cannot rebuild that set itself) and gets them back in the same order. An
 * id that is gone or unreadable is named in missingCaseIds, never dropped
 * silently -- a spreadsheet one row short with no explanation is worse than
 * a note saying which rows are missing.
 */
export async function buildCaseExportRows(
  context: AppContext,
  tenantId: string,
  caseIds: readonly string[],
): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }> {
  const partnerListing = await listPartners(context, tenantId);
  const partnerNamesById = new Map(
    partnerListing.partners.map((partner) => [partner.partnerId, partner.canonicalName]),
  );

  const loadedCases = await mapWithConcurrency(caseIds, EXPORT_READ_CONCURRENCY, async (caseId) => {
    try {
      const storedCase = await readCase(context, tenantId, caseId);
      if (storedCase === undefined) return { caseId, storedCase: undefined, travellers: {} };
      const travellers = await resolveCaseTravellers(context, tenantId, storedCase.applicants);
      return { caseId, storedCase, travellers };
    } catch (error) {
      if (!(error instanceof CorruptRecordError)) throw error;
      return { caseId, storedCase: undefined, travellers: {} };
    }
  });

  const rows: crm.CaseExportRow[] = [];
  const missingCaseIds: string[] = [];
  for (const { caseId, storedCase, travellers } of loadedCases) {
    if (storedCase === undefined) {
      missingCaseIds.push(caseId);
      continue;
    }
    for (const applicant of storedCase.applicants) {
      rows.push({
        caseId: storedCase.caseId,
        caseRef: storedCase.caseRef,
        ...(storedCase.groupName !== undefined ? { groupName: storedCase.groupName } : {}),
        partnerName: partnerNamesById.get(storedCase.partnerId) ?? storedCase.partnerId,
        destinationCountry: storedCase.destinationCountry,
        caseType: storedCase.caseType,
        ...(storedCase.visaType !== undefined ? { visaType: storedCase.visaType } : {}),
        ...(storedCase.entryType !== undefined ? { entryType: storedCase.entryType } : {}),
        ...(storedCase.processing !== undefined ? { processing: storedCase.processing } : {}),
        caseStatus: storedCase.caseStatus,
        billingStatus: storedCase.billingStatus,
        receivedDate: storedCase.receivedDate,
        ...(storedCase.submissionDate !== undefined ? { submissionDate: storedCase.submissionDate } : {}),
        ...(storedCase.appointmentDate !== undefined ? { appointmentDate: storedCase.appointmentDate } : {}),
        ...(storedCase.expectedCollectionDate !== undefined
          ? { expectedCollectionDate: storedCase.expectedCollectionDate }
          : {}),
        totalInr: storedCase.totalInr,
        ...(storedCase.clientEmail !== undefined ? { clientEmail: storedCase.clientEmail } : {}),
        ...(storedCase.remarks !== undefined ? { remarks: storedCase.remarks } : {}),
        applicantRefNo: crm.displayApplicantRef(storedCase.caseRef, storedCase.applicants.length, applicant),
        applicantName: crm.displayApplicantName(travellers, applicant),
        ...((applicant.passportNumber ?? travellers[applicant.travellerId]?.passportNumber) !== undefined
          ? { passportNumber: applicant.passportNumber ?? travellers[applicant.travellerId]?.passportNumber }
          : {}),
        custody: applicant.custody,
        outcome: applicant.outcome,
        ...(applicant.trackingNumber !== undefined ? { trackingNumber: applicant.trackingNumber } : {}),
      });
    }
  }
  return { rows, missingCaseIds };
}
```

Check `listPartners`' real return shape (`partners.ts:75-107`, `PartnerListing`) and adapt `partnerListing.partners` accordingly.

`crmApi.ts` — body:

```ts
const ExportRowsBody = z.object({
  caseIds: z.array(z.string().min(1)).min(1).max(crm.MAX_EXPORT_CASE_IDS),
});
```

Route, immediately after the `GET /api/v1/admin/crm/cases/ledger` route (keep the "BEFORE /cases/{caseId}" rule):

```ts
    // A POST only because the id list does not fit a query string. Reads
    // only, so gated on the screen, not on write.
    .add("POST", "/api/v1/admin/crm/cases/export-rows", async (requestContext) => {
      requireScreen(requestContext, "crm");
      const body = parseBody(ExportRowsBody, requestContext.body);
      return buildCaseExportRows(context, tenantId, [...new Set(body.caseIds)]);
    })
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/shared exec vitest run && pnpm --filter @rgs/api exec vitest run test/crm && pnpm -r typecheck`
Expected: PASS (minus pre-existing).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(crm): export-rows endpoint returns per-applicant rows for given cases"`

---

### Task 8: Admin client methods + timeline copy

**Files:**
- Modify: `apps/admin/src/crm/api/crmClient.ts` (`CrmEventType` :74, `UpdateCaseDetailsBody` :108, `crmClient` object :371)
- Modify: `apps/admin/src/crm/case/eventCopy.ts` (table comment :42-60 and the switch near :300)
- Test: `apps/admin/test/crm/crmClient.test.ts`, `apps/admin/test/crm/Timeline.test.tsx` or the existing eventCopy test (find with `grep -rln "describeCrmEvent\|eventCopy" apps/admin/test`)

**Interfaces:**
- Produces on `crmClient`:
  - `updateApplicant(idToken, caseId, applicantRef, input: UpdateApplicantBody): Promise<crm.CrmCase>`
  - `addApplicant(idToken, caseId, input: AddApplicantBody): Promise<crm.CrmCase>`
  - `removeApplicant(idToken, caseId, applicantRef): Promise<crm.CrmCase>`
  - `fetchExportRows(idToken, caseIds: string[]): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }>`
- Exported types `UpdateApplicantBody = { fullName?: string; passportNumber?: string | null; refNo?: string | null }`, `AddApplicantBody = { travellerId: string; passportNumber?: string; refNo?: string }`.

- [ ] **Step 1: Write the failing tests** — append to `crmClient.test.ts`, following how that file stubs `fetch` and asserts method + URL + body:

```ts
it("sends the applicant and export calls to the right routes", async () => {
  // with the file's fetch stub answering {} / { rows: [], missingCaseIds: [] }:
  await crmClient.updateApplicant("token", "case_1", "A1", { refNo: null });
  await crmClient.addApplicant("token", "case_1", { travellerId: "trv_1" });
  await crmClient.removeApplicant("token", "case_1", "A2");
  await crmClient.fetchExportRows("token", ["case_1"]);
  // assert, in order:
  // PUT    /api/v1/admin/crm/cases/case_1/applicants/A1   body {"refNo":null}
  // POST   /api/v1/admin/crm/cases/case_1/applicants      body {"travellerId":"trv_1"}
  // DELETE /api/v1/admin/crm/cases/case_1/applicants/A2   no body
  // POST   /api/v1/admin/crm/cases/export-rows            body {"caseIds":["case_1"]}
});
```

Append to the eventCopy test:

```ts
it("describes applicant add, update and remove", () => {
  const baseEvent = { eventId: "e1", caseId: "case_1", actorEmail: "desk@rgs.local", createdAt: "2026-09-29T10:00:00.000Z" };
  expect(/* the file's describe function */({ ...baseEvent, eventType: "APPLICANT_ADDED", meta: { applicantRef: "A3" } }).title)
    .toBe("Applicant A3 added by desk@rgs.local");
  expect(/* describe */({ ...baseEvent, eventType: "APPLICANT_REMOVED", meta: { applicantRef: "A2" } }).title)
    .toBe("Applicant A2 removed by desk@rgs.local");
  expect(/* describe */({ ...baseEvent, eventType: "APPLICANT_UPDATED", meta: { applicantRef: "A1", changedFields: "refNo" } }).title)
    .toBe("Applicant A1 updated by desk@rgs.local");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm/crmClient.test.ts` (+ the eventCopy test file)
Expected: FAIL.

- [ ] **Step 3: Implement**

`crmClient.ts`:
- Add `"APPLICANT_UPDATED" | "APPLICANT_ADDED" | "APPLICANT_REMOVED"` to `CrmEventType`.
- Replace `UpdateCaseDetailsBody` with the mirror of Task 4's server body:

```ts
export interface UpdateCaseDetailsBody {
  caseRef?: string;
  caseType?: crm.CaseType;
  partnerId?: string;
  destinationCountry?: string;
  receivedDate?: string;
  /** For every field below, `null` clears; mirrors `.nullable()` in crmApi.ts. */
  visaType?: crm.VisaType | null;
  entryType?: crm.EntryType | null;
  processing?: crm.ProcessingSpeed | null;
  submissionDate?: string | null;
  appointmentDate?: string | null;
  expectedCollectionDate?: string | null;
  remarks?: string | null;
  groupName?: string | null;
  clientEmail?: string | null;
}

export interface UpdateApplicantBody {
  fullName?: string;
  passportNumber?: string | null;
  refNo?: string | null;
}

export interface AddApplicantBody {
  travellerId: string;
  passportNumber?: string;
  refNo?: string;
}
```

- Add to the `crmClient` object (next to `setOutcome`):

```ts
  updateApplicant(idToken: string, caseId: string, applicantRef: string, input: UpdateApplicantBody): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/applicants/${encodeURIComponent(applicantRef)}`,
      { method: "PUT", body: input, idToken },
    );
  },

  addApplicant(idToken: string, caseId: string, input: AddApplicantBody): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(`${CRM_BASE}/cases/${encodeURIComponent(caseId)}/applicants`, {
      method: "POST",
      body: input,
      idToken,
    });
  },

  removeApplicant(idToken: string, caseId: string, applicantRef: string): Promise<crm.CrmCase> {
    return apiFetch<crm.CrmCase>(
      `${CRM_BASE}/cases/${encodeURIComponent(caseId)}/applicants/${encodeURIComponent(applicantRef)}`,
      { method: "DELETE", idToken },
    );
  },

  fetchExportRows(idToken: string, caseIds: string[]): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }> {
    return apiFetch(`${CRM_BASE}/cases/export-rows`, { method: "POST", body: { caseIds }, idToken });
  },
```

Run `pnpm --filter @rgs/admin typecheck` now: any existing caller that relied on the old `UpdateCaseDetailsBody` (e.g. `mutations.ts`) must still compile — the new type is a superset.

`eventCopy.ts`: add three rows to the module's meta table comment and three cases to the switch, in the file's style:

```ts
    case "APPLICANT_UPDATED":
      return {
        title: `Applicant ${String(meta["applicantRef"] ?? "")} updated by ${actorEmail}`,
        detail: describeChangedFields(meta),
        isAutoApplied: false,
      };

    case "APPLICANT_ADDED":
      return {
        title: `Applicant ${String(meta["applicantRef"] ?? "")} added by ${actorEmail}`,
        isAutoApplied: false,
      };

    case "APPLICANT_REMOVED":
      return {
        title: `Applicant ${String(meta["applicantRef"] ?? "")} removed by ${actorEmail}`,
        isAutoApplied: false,
      };
```

(If the return type requires `detail`, give the two without detail `detail: undefined` or whatever the neighbours use. If `describeChangedFields` maps names through `CASE_FIELD_LABELS` in `labels.ts:285`, add labels there for any new names: `caseRef: "REF"`, `caseType: "Type"`, `partnerId: "Partner"`, `destinationCountry: "Country"`, `receivedDate: "Received"`, `fullName: "Name"`, `passportNumber: "Passport"`, `refNo: "REF NO"` — only the ones missing.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm && pnpm --filter @rgs/admin typecheck`
Expected: PASS (minus the pre-existing LedgerTable failure).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(admin): client calls for applicant edits and export; timeline copy"`

---

### Task 9: Edit Case drawer on the case page

**Files:**
- Create: `apps/admin/src/crm/case/caseEditDiff.ts`
- Create: `apps/admin/src/crm/case/EditCaseDrawer.tsx`
- Modify: `apps/admin/src/crm/case/CasePage.tsx` (button in `CaseHeader`'s title row ~:297, drawer render in `CaseScreen`)
- Test: `apps/admin/test/crm/caseEditDiff.test.ts`, `apps/admin/test/crm/EditCaseDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 8 client methods; `CaseView` (`crmClient.ts:130`); `crm.displayApplicantName`.
- Produces:
  - `interface CaseDraft { caseRef; caseType; partnerId; destinationCountry; visaType: crm.VisaType | ""; entryType: crm.EntryType | ""; processing: crm.ProcessingSpeed | ""; receivedDate; submissionDate; appointmentDate; expectedCollectionDate; remarks; groupName; clientEmail; applicants: ApplicantDraftRow[] }` — all strings; `""` = empty.
  - `interface ApplicantDraftRow { applicantRef?: string; fullName: string; passportNumber: string; refNo: string }` — `applicantRef` undefined = new person.
  - `draftFromCase(caseView: CaseView): CaseDraft`
  - `buildCaseDetailsPatch(original: CaseDraft, edited: CaseDraft): UpdateCaseDetailsBody` — only changed fields; `""` → `null` for clearable fields.
  - `planApplicantChanges(original: CaseDraft, edited: CaseDraft): { updates: { applicantRef: string; body: UpdateApplicantBody }[]; additions: ApplicantDraftRow[]; removals: string[] }`

- [ ] **Step 1: Write the failing tests** — `apps/admin/test/crm/caseEditDiff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCaseDetailsPatch, planApplicantChanges, type CaseDraft } from "../../src/crm/case/caseEditDiff";

const ORIGINAL_DRAFT: CaseDraft = {
  caseRef: "38017",
  caseType: "VISA",
  partnerId: "ptn_1",
  destinationCountry: "JP",
  visaType: "TOURIST",
  entryType: "",
  processing: "",
  receivedDate: "2026-09-01",
  submissionDate: "",
  appointmentDate: "",
  expectedCollectionDate: "2026-09-20",
  remarks: "call first",
  groupName: "",
  clientEmail: "",
  applicants: [
    { applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "P1111111", refNo: "" },
    { applicantRef: "A2", fullName: "SITA SHARMA", passportNumber: "", refNo: "" },
  ],
};

describe("buildCaseDetailsPatch", () => {
  it("sends only changed fields, trimmed, and null for a cleared optional", () => {
    const patch = buildCaseDetailsPatch(ORIGINAL_DRAFT, {
      ...ORIGINAL_DRAFT,
      caseRef: " 38017-B ",
      remarks: "",
      expectedCollectionDate: "",
    });
    expect(patch).toEqual({ caseRef: "38017-B", remarks: null, expectedCollectionDate: null });
  });

  it("sends nothing when nothing changed", () => {
    expect(buildCaseDetailsPatch(ORIGINAL_DRAFT, { ...ORIGINAL_DRAFT, caseRef: "38017 " })).toEqual({});
  });
});

describe("planApplicantChanges", () => {
  it("splits edits into updates, additions and removals", () => {
    const plan = planApplicantChanges(ORIGINAL_DRAFT, {
      ...ORIGINAL_DRAFT,
      applicants: [
        { applicantRef: "A1", fullName: "ANIL K SHARMA", passportNumber: "P1111111", refNo: "R-1" },
        { fullName: "RIYA SHARMA", passportNumber: "", refNo: "R-3" },
      ],
    });
    expect(plan.updates).toEqual([{ applicantRef: "A1", body: { fullName: "ANIL K SHARMA", refNo: "R-1" } }]);
    expect(plan.additions).toEqual([{ fullName: "RIYA SHARMA", passportNumber: "", refNo: "R-3" }]);
    expect(plan.removals).toEqual(["A2"]);
  });

  it("clears a REF NO or passport with null", () => {
    const withValues: CaseDraft = {
      ...ORIGINAL_DRAFT,
      applicants: [{ applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "P1111111", refNo: "R-1" }],
    };
    const plan = planApplicantChanges(withValues, {
      ...withValues,
      applicants: [{ applicantRef: "A1", fullName: "ANIL SHARMA", passportNumber: "", refNo: "" }],
    });
    expect(plan.updates).toEqual([{ applicantRef: "A1", body: { passportNumber: null, refNo: null } }]);
  });
});
```

`apps/admin/test/crm/EditCaseDrawer.test.tsx` — copy the harness from `NewCaseDrawer.test.tsx` (`TEST_AUTH_STATE`, `jsonResponse`, URL-routed `fetch` stub with a `requestLog`) and render `<EditCaseDrawer caseRecord={CASE_VIEW} onClose={onClose} />` inside `QueryClientProvider` + `AuthContext.Provider` + `MemoryRouter`. `CASE_VIEW` is a `CaseView` matching `ORIGINAL_DRAFT` above with `travellers: { trv_1: { fullName: "ANIL SHARMA", passportNumber: "P1111111" }, trv_2: { fullName: "SITA SHARMA" } }` and all required `CrmCase` fields (copy a fixture from `CasePage.test.tsx`). Tests:

```ts
it("pre-fills the form from the case", async () => {
  renderEditDrawer();
  expect(screen.getByLabelText("REF")).toHaveValue("38017");
  expect(screen.getByLabelText("Applicant 1 name")).toHaveValue("ANIL SHARMA");
});

it("saves only what changed: PUT case, then PUT applicant, in that order", async () => {
  const { requestLog, onClose } = renderEditDrawer();
  fireEvent.change(screen.getByLabelText("REF"), { target: { value: "38017-B" } });
  fireEvent.change(screen.getByLabelText("Applicant 1 REF NO"), { target: { value: "R-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  const writes = requestLog.filter((request) => request.method !== "GET");
  expect(writes.map((request) => `${request.method} ${new URL(request.url, "http://x").pathname}`)).toEqual([
    "PUT /api/v1/admin/crm/cases/case_1",
    "PUT /api/v1/admin/crm/cases/case_1/applicants/A1",
  ]);
  expect(writes[0]?.body).toEqual({ caseRef: "38017-B" });
});

it("shows the server's 409 message and stays open when the REF is taken", async () => {
  const { onClose } = renderEditDrawer({ caseWriteStatus: 409, caseWriteMessage: 'REF "38018" is already used by another case.' });
  fireEvent.change(screen.getByLabelText("REF"), { target: { value: "38018" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText(/REF "38018" is already used by another case\./)).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

it("does nothing and says so when no field changed", async () => {
  const { requestLog } = renderEditDrawer();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
  expect(requestLog.filter((request) => request.method !== "GET")).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm/caseEditDiff.test.ts test/crm/EditCaseDrawer.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `caseEditDiff.ts`**

```ts
import { crm } from "@rgs/shared";
import type { CaseView, UpdateApplicantBody, UpdateCaseDetailsBody } from "../api/crmClient";

export interface ApplicantDraftRow {
  /** Absent for a person added in this edit. */
  applicantRef?: string;
  fullName: string;
  passportNumber: string;
  refNo: string;
}

/** Every editable field as the form holds it: strings, "" meaning empty. */
export interface CaseDraft {
  caseRef: string;
  caseType: crm.CaseType;
  partnerId: string;
  destinationCountry: string;
  visaType: crm.VisaType | "";
  entryType: crm.EntryType | "";
  processing: crm.ProcessingSpeed | "";
  receivedDate: string;
  submissionDate: string;
  appointmentDate: string;
  expectedCollectionDate: string;
  remarks: string;
  groupName: string;
  clientEmail: string;
  applicants: ApplicantDraftRow[];
}

export function draftFromCase(caseView: CaseView): CaseDraft {
  return {
    caseRef: caseView.caseRef,
    caseType: caseView.caseType,
    partnerId: caseView.partnerId,
    destinationCountry: caseView.destinationCountry,
    visaType: caseView.visaType ?? "",
    entryType: caseView.entryType ?? "",
    processing: caseView.processing ?? "",
    receivedDate: caseView.receivedDate,
    submissionDate: caseView.submissionDate ?? "",
    appointmentDate: caseView.appointmentDate ?? "",
    expectedCollectionDate: caseView.expectedCollectionDate ?? "",
    remarks: caseView.remarks ?? "",
    groupName: caseView.groupName ?? "",
    clientEmail: caseView.clientEmail ?? "",
    applicants: caseView.applicants.map((applicant) => ({
      applicantRef: applicant.applicantRef,
      fullName: caseView.travellers?.[applicant.travellerId]?.fullName ?? "",
      passportNumber: applicant.passportNumber ?? "",
      refNo: applicant.refNo ?? "",
    })),
  };
}

/** Required on the case: a blank here is a validation problem, never a clear. */
const REQUIRED_CASE_FIELDS = ["caseRef", "caseType", "partnerId", "destinationCountry", "receivedDate"] as const;
/** Optional on the case: a blank is sent as null, which the server reads as "clear". */
const CLEARABLE_CASE_FIELDS = [
  "visaType",
  "entryType",
  "processing",
  "submissionDate",
  "appointmentDate",
  "expectedCollectionDate",
  "remarks",
  "groupName",
  "clientEmail",
] as const;

export function buildCaseDetailsPatch(original: CaseDraft, edited: CaseDraft): UpdateCaseDetailsBody {
  const patch: Record<string, string | null> = {};
  for (const fieldName of REQUIRED_CASE_FIELDS) {
    const editedValue = edited[fieldName].trim();
    if (editedValue !== original[fieldName].trim()) patch[fieldName] = editedValue;
  }
  for (const fieldName of CLEARABLE_CASE_FIELDS) {
    const editedValue = edited[fieldName].trim();
    if (editedValue === original[fieldName].trim()) continue;
    patch[fieldName] = editedValue === "" ? null : editedValue;
  }
  return patch as UpdateCaseDetailsBody;
}

export function planApplicantChanges(
  original: CaseDraft,
  edited: CaseDraft,
): { updates: { applicantRef: string; body: UpdateApplicantBody }[]; additions: ApplicantDraftRow[]; removals: string[] } {
  const originalRowsByRef = new Map(
    original.applicants.map((applicantRow) => [applicantRow.applicantRef, applicantRow] as const),
  );
  const keptApplicantRefs = new Set<string>();
  const updates: { applicantRef: string; body: UpdateApplicantBody }[] = [];
  const additions: ApplicantDraftRow[] = [];

  for (const editedRow of edited.applicants) {
    if (editedRow.applicantRef === undefined) {
      additions.push(editedRow);
      continue;
    }
    keptApplicantRefs.add(editedRow.applicantRef);
    const originalRow = originalRowsByRef.get(editedRow.applicantRef);
    if (originalRow === undefined) continue;
    const body: UpdateApplicantBody = {};
    if (editedRow.fullName.trim() !== originalRow.fullName.trim()) body.fullName = editedRow.fullName.trim();
    const editedPassport = editedRow.passportNumber.trim().toUpperCase();
    if (editedPassport !== originalRow.passportNumber.trim().toUpperCase()) {
      body.passportNumber = editedPassport === "" ? null : editedPassport;
    }
    const editedRefNo = editedRow.refNo.trim();
    if (editedRefNo !== originalRow.refNo.trim()) body.refNo = editedRefNo === "" ? null : editedRefNo;
    if (Object.keys(body).length > 0) updates.push({ applicantRef: editedRow.applicantRef, body });
  }

  const removals = original.applicants
    .map((applicantRow) => applicantRow.applicantRef)
    .filter((applicantRef): applicantRef is string => applicantRef !== undefined && !keptApplicantRefs.has(applicantRef));
  return { updates, additions, removals };
}
```

- [ ] **Step 4: Implement `EditCaseDrawer.tsx`**

Build it by copying `NewCaseDrawer.tsx` and changing, in order:
1. Props: `{ caseRecord: CaseView; onClose(): void }`. Title `Edit case`, `aria-labelledby="edit-case-title"`, subtitle `Every field can be changed at any stage. Status, billing and custody keep their own controls on the case page.`
2. State: one `const [caseDraft, setCaseDraft] = useState<CaseDraft>(() => draftFromCase(caseRecord));` and `const originalDraft = useMemo(() => draftFromCase(caseRecord), [caseRecord]);`. Every input reads `caseDraft.<field>` and writes `setCaseDraft((currentDraft) => ({ ...currentDraft, <field>: value }))`. Remove the "Add a new partner…" option and its fields (partner must already exist — the desk adds partners from New Case).
3. Add inputs NewCaseDrawer lacks, each a `<label>` whose visible text is the accessible name: `Processing` (select over `crm.PROCESSING_SPEEDS` with `PROCESSING_LABELS`, first option `""` "Not set"), `Submission date` (date), `Appointment date` (date). Keep labels `REF`, `Type`, `Partner`, `Destination`, `Visa type`, `Entry type`, `Received`, `Collection date`, `Remarks`, `Group name`, `Client email`, `Applicant N name`, `Passport`, `Applicant N REF NO` exactly — tests select by them.
4. Under the applicants legend add `<p className="text-xs text-ink-soft">A name change applies to this person on every case they are on.</p>`. The Remove button stays disabled when one applicant remains. "Add another applicant" appends `{ fullName: "", passportNumber: "", refNo: "" }` (no `applicantRef`).
5. Validation: reuse NewCaseDrawer's `describeValidationProblem` rules (REF required, partner required, country required, full dates, collection ≥ received, email pattern, every applicant named), plus `if (caseDraft.caseType === "VISA" && caseDraft.visaType === "") return "Choose the visa type for a visa case.";`. When `caseType` changes away from `VISA`, the submit also sends `visaType`/`entryType` cleared: do this by setting both to `""` in the `Type` select's onChange when the new value is not `VISA`.
6. Mutation (`useMutation`), replacing `createCaseMutation`:

```tsx
  const [partialSaveMessage, setPartialSaveMessage] = useState<string | null>(null);
  const saveChangesMutation = useMutation({
    async mutationFn(): Promise<void> {
      const caseDetailsPatch = buildCaseDetailsPatch(originalDraft, caseDraft);
      const applicantPlan = planApplicantChanges(originalDraft, caseDraft);
      const completedSteps: string[] = [];
      try {
        if (Object.keys(caseDetailsPatch).length > 0) {
          await crmClient.updateCaseDetails(idToken!, caseRecord.caseId, caseDetailsPatch);
          completedSteps.push("case details");
        }
        for (const applicantUpdate of applicantPlan.updates) {
          await crmClient.updateApplicant(idToken!, caseRecord.caseId, applicantUpdate.applicantRef, applicantUpdate.body);
          completedSteps.push(`applicant ${applicantUpdate.applicantRef}`);
        }
        // Additions before removals: removing everyone first would hit the
        // "a case needs at least one applicant" refusal.
        for (const newApplicantRow of applicantPlan.additions) {
          const passportNumber = newApplicantRow.passportNumber.trim().toUpperCase() || undefined;
          const existingTraveller =
            passportNumber === undefined ? undefined : await crmClient.findTravellerByPassport(idToken!, passportNumber);
          const traveller =
            existingTraveller ??
            (await crmClient.upsertTraveller(idToken!, {
              fullName: newApplicantRow.fullName.trim(),
              ...(passportNumber === undefined ? {} : { passportNumber }),
            }));
          const refNo = newApplicantRow.refNo.trim();
          await crmClient.addApplicant(idToken!, caseRecord.caseId, {
            travellerId: traveller.travellerId,
            ...(passportNumber === undefined ? {} : { passportNumber }),
            ...(refNo === "" ? {} : { refNo }),
          });
          completedSteps.push(`new applicant ${newApplicantRow.fullName.trim()}`);
        }
        for (const removedApplicantRef of applicantPlan.removals) {
          await crmClient.removeApplicant(idToken!, caseRecord.caseId, removedApplicantRef);
          completedSteps.push(`removed ${removedApplicantRef}`);
        }
      } catch (error) {
        setPartialSaveMessage(completedSteps.length === 0 ? null : `Saved: ${completedSteps.join(", ")}.`);
        throw error;
      }
    },
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
    },
    onSuccess() {
      onClose();
    },
  });
```

Check the real query-key helpers in `apps/admin/src/crm/api/hooks.ts` (`crmQueryKeys.case`, and the events key used by `useCaseEvents`) and use their exact names.

7. Submit handler:

```tsx
  function submit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const problem = describeValidationProblem();
    if (problem !== null) {
      setValidationMessage(problem);
      return;
    }
    const nothingChanged =
      Object.keys(buildCaseDetailsPatch(originalDraft, caseDraft)).length === 0 &&
      (() => {
        const applicantPlan = planApplicantChanges(originalDraft, caseDraft);
        return applicantPlan.updates.length + applicantPlan.additions.length + applicantPlan.removals.length === 0;
      })();
    if (nothingChanged) {
      setValidationMessage("Nothing changed.");
      return;
    }
    setValidationMessage(null);
    setPartialSaveMessage(null);
    saveChangesMutation.mutate();
  }
```

8. Footer: error block `Not saved: {saveChangesMutation.error.message}` plus `{partialSaveMessage}` on its own line when set; primary button text `isPending ? "Saving…" : "Save changes"`.

- [ ] **Step 5: Wire into `CasePage.tsx`**

- In `CaseScreen`: `const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);` and the write-permission flag the Ledger uses (search `canWriteCrm` in `LedgerPage.tsx` and reuse the same expression/hook).
- Pass `onOpenEdit={canWriteCrm ? () => setIsEditDrawerOpen(true) : undefined}` into `CaseHeader`; add `onOpenEdit?: () => void` to its props.
- In `CaseHeader`'s title row (the `div` holding the `h1`), last child:

```tsx
        {onOpenEdit !== undefined && (
          <button type="button" onClick={onOpenEdit} className={`${SECONDARY_BUTTON_CLASS} ml-auto`}>
            Edit details
          </button>
        )}
```

- After the header block in `CaseScreen`: `{isEditDrawerOpen && caseRecord !== undefined && <EditCaseDrawer caseRecord={caseRecord} onClose={() => setIsEditDrawerOpen(false)} />}`.
- Add a test to `CasePage.test.tsx`: with an Ops-role auth state, `screen.getByRole("button", { name: "Edit details" })` exists and clicking it shows `screen.getByRole("dialog", { name: "Edit case" })`; with a Viewer-role auth state the button is absent.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm && pnpm --filter @rgs/admin typecheck`
Expected: PASS (minus the pre-existing LedgerTable failure).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(admin): Edit details drawer edits every case field and the applicant list"`

---

### Task 10: Export to Excel on the Ledger

**Files:**
- Modify: `apps/admin/package.json` (dependency)
- Create: `apps/admin/src/crm/ledger/ledgerExport.ts`
- Modify: `apps/admin/src/crm/ledger/LedgerPage.tsx` (toolbar `div` ~:233)
- Test: `apps/admin/test/crm/ledgerExport.test.ts`, `apps/admin/test/crm/LedgerPage.test.tsx` (append)

**Interfaces:**
- Consumes: `crmClient.fetchExportRows` (Task 8), `crm.MAX_EXPORT_CASE_IDS` (Task 7), label maps in `apps/admin/src/crm/labels.ts`.
- Produces:
  - `EXPORT_COLUMNS: readonly { header: string; value: (row: crm.CaseExportRow) => string | number }[]`
  - `fetchAllExportRows(fetchBatch: (caseIds: string[]) => Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }>, caseIds: readonly string[], onProgress?: (doneCount: number, totalCount: number) => void): Promise<{ rows: crm.CaseExportRow[]; missingCaseIds: string[] }>`
  - `buildLedgerWorkbookBytes(rows: readonly crm.CaseExportRow[]): Promise<ArrayBuffer>` (dynamic-imports `exceljs`)
  - `exportFileName(todayIso: string): string` → `rgs-ledger-${todayIso}.xlsx`

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @rgs/admin add exceljs@^4.4.0`
Expected: `apps/admin/package.json` lists `exceljs`; lockfile updated.

- [ ] **Step 2: Write the failing test** — `apps/admin/test/crm/ledgerExport.test.ts`:

```ts
import ExcelJS from "exceljs";
import { crm } from "@rgs/shared";
import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_COLUMNS,
  buildLedgerWorkbookBytes,
  exportFileName,
  fetchAllExportRows,
} from "../../src/crm/ledger/ledgerExport";

function exportRow(overrides: Partial<crm.CaseExportRow> = {}): crm.CaseExportRow {
  return {
    caseId: "case_1",
    caseRef: "38017",
    partnerName: "Ozzy Travels",
    destinationCountry: "JP",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-09-01",
    totalInr: 4500,
    applicantRefNo: "38017",
    applicantName: "ASHA RAO",
    custody: "NOT_HELD",
    outcome: "PENDING",
    ...overrides,
  };
}

describe("fetchAllExportRows", () => {
  it("asks in batches of MAX_EXPORT_CASE_IDS, keeps order, and collects missing ids", async () => {
    const caseIds = Array.from({ length: crm.MAX_EXPORT_CASE_IDS + 3 }, (_, index) => `case_${index}`);
    const fetchBatch = vi.fn(async (batchCaseIds: string[]) => ({
      rows: batchCaseIds.slice(0, 1).map((caseId) => exportRow({ caseId })),
      missingCaseIds: batchCaseIds.slice(-1),
    }));
    const progressCalls: [number, number][] = [];

    const result = await fetchAllExportRows(fetchBatch, caseIds, (doneCount, totalCount) =>
      progressCalls.push([doneCount, totalCount]),
    );

    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch.mock.calls[0]?.[0]).toHaveLength(crm.MAX_EXPORT_CASE_IDS);
    expect(result.rows.map((row) => row.caseId)).toEqual(["case_0", `case_${crm.MAX_EXPORT_CASE_IDS}`]);
    expect(result.missingCaseIds).toEqual([`case_${crm.MAX_EXPORT_CASE_IDS - 1}`, `case_${crm.MAX_EXPORT_CASE_IDS + 2}`]);
    expect(progressCalls.at(-1)).toEqual([caseIds.length, caseIds.length]);
  });
});

describe("buildLedgerWorkbookBytes", () => {
  it("writes a header row and one labelled row per export row", async () => {
    const workbookBytes = await buildLedgerWorkbookBytes([exportRow(), exportRow({ applicantName: "RAVI RAO", applicantRefNo: "A2" })]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBytes);
    const worksheet = workbook.getWorksheet("Cases")!;

    expect(worksheet.getRow(1).getCell(1).value).toBe(EXPORT_COLUMNS[0]!.header);
    expect(worksheet.rowCount).toBe(3);
    const headerTexts = EXPORT_COLUMNS.map((column) => column.header);
    const statusColumnNumber = headerTexts.indexOf("Status") + 1;
    expect(worksheet.getRow(2).getCell(statusColumnNumber).value).toBe("New");
    const nameColumnNumber = headerTexts.indexOf("Applicant") + 1;
    expect(worksheet.getRow(3).getCell(nameColumnNumber).value).toBe("RAVI RAO");
  });
});

it("names the file after the day", () => {
  expect(exportFileName("2026-09-29")).toBe("rgs-ledger-2026-09-29.xlsx");
});
```

(`"New"` must equal `CASE_STATUS_LABELS.NEW` in `labels.ts:12` — read it and use the real label.)

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm/ledgerExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ledgerExport.ts`**

```ts
import { crm } from "@rgs/shared";
import {
  BILLING_LABELS,
  CASE_STATUS_LABELS,
  CASE_TYPE_LABELS,
  CUSTODY_LABELS,
  ENTRY_TYPE_LABELS,
  OUTCOME_LABELS,
  PROCESSING_LABELS,
  VISA_TYPE_LABELS,
} from "../labels";

type ExportRowsBatch = { rows: crm.CaseExportRow[]; missingCaseIds: string[] };

/**
 * The sheet's columns, in order, and how each reads a row. Labels, not raw
 * enum values: the file is for people, and "APPOINTMENT_SET" is not how the
 * desk says it.
 */
export const EXPORT_COLUMNS: readonly { header: string; value: (row: crm.CaseExportRow) => string | number }[] = [
  { header: "REF", value: (row) => row.caseRef },
  { header: "Group", value: (row) => row.groupName ?? "" },
  { header: "Applicant REF NO", value: (row) => row.applicantRefNo },
  { header: "Applicant", value: (row) => row.applicantName },
  { header: "Passport", value: (row) => row.passportNumber ?? "" },
  { header: "Partner", value: (row) => row.partnerName },
  { header: "Country", value: (row) => row.destinationCountry },
  { header: "Type", value: (row) => CASE_TYPE_LABELS[row.caseType] },
  { header: "Visa type", value: (row) => (row.visaType === undefined ? "" : VISA_TYPE_LABELS[row.visaType]) },
  { header: "Entry", value: (row) => (row.entryType === undefined ? "" : ENTRY_TYPE_LABELS[row.entryType]) },
  { header: "Processing", value: (row) => (row.processing === undefined ? "" : PROCESSING_LABELS[row.processing]) },
  { header: "Status", value: (row) => CASE_STATUS_LABELS[row.caseStatus] },
  { header: "Billing", value: (row) => BILLING_LABELS[row.billingStatus] },
  { header: "Received", value: (row) => row.receivedDate },
  { header: "Submitted", value: (row) => row.submissionDate ?? "" },
  { header: "Appointment", value: (row) => row.appointmentDate ?? "" },
  { header: "Collection", value: (row) => row.expectedCollectionDate ?? "" },
  { header: "Custody", value: (row) => CUSTODY_LABELS[row.custody] },
  { header: "Outcome", value: (row) => OUTCOME_LABELS[row.outcome] },
  { header: "Tracking", value: (row) => row.trackingNumber ?? "" },
  { header: "Total (INR)", value: (row) => row.totalInr },
  { header: "Client email", value: (row) => row.clientEmail ?? "" },
  { header: "Remarks", value: (row) => row.remarks ?? "" },
];

export async function fetchAllExportRows(
  fetchBatch: (caseIds: string[]) => Promise<ExportRowsBatch>,
  caseIds: readonly string[],
  onProgress?: (doneCount: number, totalCount: number) => void,
): Promise<ExportRowsBatch> {
  const collected: ExportRowsBatch = { rows: [], missingCaseIds: [] };
  // Sequential on purpose: each batch is one Lambda call near its budget, and
  // firing fifteen at once would trade a slower export for throttled ones.
  for (let batchStart = 0; batchStart < caseIds.length; batchStart += crm.MAX_EXPORT_CASE_IDS) {
    const batchCaseIds = caseIds.slice(batchStart, batchStart + crm.MAX_EXPORT_CASE_IDS);
    const batchResult = await fetchBatch(batchCaseIds);
    collected.rows.push(...batchResult.rows);
    collected.missingCaseIds.push(...batchResult.missingCaseIds);
    onProgress?.(batchStart + batchCaseIds.length, caseIds.length);
  }
  return collected;
}

export async function buildLedgerWorkbookBytes(rows: readonly crm.CaseExportRow[]): Promise<ArrayBuffer> {
  // Loaded on click, not with the Ledger: exceljs is large and most visits never export.
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Cases", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.addRow(EXPORT_COLUMNS.map((column) => column.header));
  worksheet.getRow(1).font = { bold: true };
  for (const exportRow of rows) {
    worksheet.addRow(EXPORT_COLUMNS.map((column) => column.value(exportRow)));
  }
  EXPORT_COLUMNS.forEach((column, columnIndex) => {
    worksheet.getColumn(columnIndex + 1).width = Math.max(12, column.header.length + 2);
  });
  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

export function exportFileName(todayIso: string): string {
  return `rgs-ledger-${todayIso}.xlsx`;
}
```

If `import("exceljs")` fails under Vite's build (`pnpm --filter @rgs/admin build`) with a Node-builtin error, change the import to `import("exceljs/dist/exceljs.min.js")` and add a `declare module "exceljs/dist/exceljs.min.js" { export { default } from "exceljs"; }` in `apps/admin/src/vite-env.d.ts` (or the admin's existing `.d.ts`). Keep the test's static `import ExcelJS from "exceljs"` as is.

- [ ] **Step 5: Wire the button in `LedgerPage.tsx`**

State and handler inside the page component:

```tsx
  const [exportProgressText, setExportProgressText] = useState<string | null>(null);
  const [exportErrorText, setExportErrorText] = useState<string | null>(null);

  async function exportVisibleRowsToExcel() {
    if (idToken === null || visibleLedgerRows.length === 0) return;
    setExportErrorText(null);
    const visibleCaseIds = visibleLedgerRows.map((ledgerRow) => ledgerRow.caseId);
    try {
      setExportProgressText(`Exporting 0 of ${visibleCaseIds.length.toLocaleString("en-IN")}…`);
      const exportResult = await fetchAllExportRows(
        (batchCaseIds) => crmClient.fetchExportRows(idToken, batchCaseIds),
        visibleCaseIds,
        (doneCount, totalCount) =>
          setExportProgressText(`Exporting ${doneCount.toLocaleString("en-IN")} of ${totalCount.toLocaleString("en-IN")}…`),
      );
      const workbookBytes = await buildLedgerWorkbookBytes(exportResult.rows);
      const downloadUrl = URL.createObjectURL(
        new Blob([workbookBytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      );
      const downloadLink = document.createElement("a");
      downloadLink.href = downloadUrl;
      downloadLink.download = exportFileName(localTodayIso());
      downloadLink.click();
      URL.revokeObjectURL(downloadUrl);
      if (exportResult.missingCaseIds.length > 0) {
        setExportErrorText(`${exportResult.missingCaseIds.length} case(s) could not be read and are not in the file.`);
      }
    } catch (error) {
      setExportErrorText(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportProgressText(null);
    }
  }
```

(Use the page's existing `idToken` source — `useAuth()` — and the existing `localTodayIso` import from `./filters`.)

Toolbar, before the `Review queue` link:

```tsx
            <button
              type="button"
              onClick={() => void exportVisibleRowsToExcel()}
              disabled={exportProgressText !== null || visibleLedgerRows.length === 0}
              title={
                isLedgerPartial
                  ? "Exports the rows loaded so far — the Ledger is not fully loaded."
                  : "Exports every row matching the current view."
              }
              className={SECONDARY_BUTTON_CLASS}
            >
              {exportProgressText ?? "Export to Excel"}
            </button>
```

Directly under the toolbar row: `{exportErrorText !== null && <p role="alert" className="text-sm text-rgs-red-deep">{exportErrorText}</p>}` and, when `isLedgerPartial`, a small `text-xs text-ink-soft` line next to the button reading `Export holds only the loaded rows.`

Append to `LedgerPage.test.tsx` (use its existing render harness and fetch stub; stub `POST .../cases/export-rows` to answer `{ rows: [<one row>], missingCaseIds: [] }`, and stub `URL.createObjectURL = vi.fn(() => "blob:x")`, `URL.revokeObjectURL = vi.fn()`):

```ts
it("exports exactly the visible case ids when Export to Excel is clicked", async () => {
  // render with two loaded rows, apply a search that leaves one visible (use the file's existing search helper)
  fireEvent.click(await screen.findByRole("button", { name: "Export to Excel" }));
  await waitFor(() => expect(exportRequestBodies).toHaveLength(1));
  expect(exportRequestBodies[0]).toEqual({ caseIds: [visibleCaseId] });
});
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @rgs/admin exec vitest run test/crm && pnpm --filter @rgs/admin typecheck && pnpm --filter @rgs/admin build`
Expected: tests PASS (minus pre-existing); build succeeds and `exceljs` lands in its own chunk (a separate `exceljs*.js` / lazy chunk in `dist/assets`).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(admin): Export to Excel downloads the Ledger's current view"`

---

### Task 11: Full verification, staging deploy, backfill

- [ ] **Step 1: Whole-repo checks**

Run: `pnpm -r typecheck && pnpm -r test 2>&1 | tail -60`
Expected: typecheck clean; test failures are exactly the two pre-existing ones. Paste the counts into the final report.

- [ ] **Step 2: Deploy staging** (same path as previous CRM releases):

```bash
pnpm --filter @rgs/admin build
cd infra && AWS_PROFILE=hireloop npx cdk deploy RgsPlatform-staging --require-approval never
```

Expected: code-only diff (API Lambdas + admin bundle); no new routes in the diff because the admin proxy already allows DELETE.

- [ ] **Step 3: Backfill staging claims**

Run the new CLI against staging with the same environment the earlier backfills used (see how `backfill:search-text` was run — `TABLE_NAME=rgs-platform-staging AWS_PROFILE=hireloop AWS_REGION=ap-south-1`):

```bash
TABLE_NAME=rgs-platform-staging AWS_PROFILE=hireloop AWS_REGION=ap-south-1 pnpm --filter @rgs/migration backfill:ref-claims
```

Expected summary: `scanned 7160`, `duplicates 1` (REF `38017`), `unreadable 0`. Run it a second time: `claimed 0`, `duplicates 1`, and no second review item.

- [ ] **Step 4: Smoke test on staging (by hand, in the admin)**

1. New case with REF `38017` → drawer shows `REF "38017" is already used by another case.`
2. Open any case → **Edit details** → change REF, country, remarks, add an applicant with a REF NO → Save → timeline shows `Case details updated` and `Applicant A2 added`.
3. Remove that applicant → timeline shows `Applicant A2 removed`.
4. Ledger → filter to one partner → **Export to Excel** → the file opens in Excel with one row per applicant and only that partner's cases.
5. Review queue shows the `38017` `DUPLICATE_REF` item.

- [ ] **Step 5:** Report back to the developer: commit list, test counts, backfill summary, smoke results. Do NOT merge to main, push, or deploy prod — those are the owner's call.

---

## Known limits (accepted, do not build)

- Renaming a traveller refreshes the Ledger search text only on the case that was edited; their other cases pick it up on their next write.
- Moving a REF NO from one applicant to another in a single save can be refused as "used twice on this case" (updates run before removals). Save twice.
- Changing the country does not re-stamp the document checklist.
- The agent's `update_case_details` tool is not widened to the new fields.
- The importer does not write ref claims; it is a one-off historical tool. Re-running it would need the backfill again.
