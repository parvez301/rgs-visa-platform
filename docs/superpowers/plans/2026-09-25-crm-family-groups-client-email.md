# CRM Family Groups, Client Email and Vendor Email Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-applicant case can carry a group name, a per-person REF NO and a manually typed client email, and every case-level status change emails both the vendor (partner) and the client with one consolidated message that is recorded on the timeline.

**Architecture:** No new entities. Three optional fields are added to the existing shared Zod schemas (`groupName`, `clientEmail` on the case; `refNo` on the applicant). The API's status-notify module grows a second recipient and a richer body, the partner gains a contact-update route, and the single-case GET resolves traveller names so the admin can finally show them. The admin New Case form, Case page, ledger REF cell, applicant sub-rows and timeline copy render the new fields.

**Tech Stack:** TypeScript, Zod, DynamoDB single table (in-memory client in tests), Vitest, React 19 + TanStack Query + React Router (jsdom tests with a URL-routed `fetch` stub), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-25-crm-family-groups-client-email-design.md`

## Global Constraints

- Package test commands: `pnpm --filter ./packages/shared exec vitest run <file>`, `pnpm --filter ./services/api exec vitest run <file>`, `pnpm --filter ./apps/admin exec vitest run <file>`. Whole suite: `pnpm test`. Types: `pnpm typecheck`.
- The admin app imports only from `@rgs/shared`, never from `services/api`. Wire types the admin needs are mirrored in `apps/admin/src/crm/api/crmClient.ts`.
- `applicantRef` stays the internal applicant key. It is in URLs and the storage sort key and must not change meaning (spec D4).
- No uniqueness constraint on `refNo` (spec D5).
- Email subject format stays exactly `REF – STATUS – NAME – COUNTRY` with en-dashes surrounded by spaces (`" – "`).
- Vendor and client receive the same subject and body (spec D6).
- Each email send and its event are independent of the other recipient's (spec 5.1).
- No migration or backfill. Every new field is optional and absent on the 7,156 imported cases.
- Commit after every task with the message given in that task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Two tests on main already fail for reasons unrelated to this work: `LedgerTable.test.tsx` "renders the spec's columns" (9 columns vs 8 expected) and `caseStore.test.ts` "round-trips" (19 fields vs 18). Do not count them as regressions. Do not fix them unless a task here touches the same assertion.
- Branch: `crm-family-groups` (already created; the spec is its first commit).

## Review Focus

Inputs the spec implies but does not enumerate. Each line names the task whose tests pin it.

1. **Client email typed with spaces or capitals** (`"  Priya@Example.com "`) must be trimmed before it is sent and stored, never rejected as malformed. Pinned in Task 7 (form trims) and Task 1 (schema trims).
2. **Clearing the client email on the Case page** (deleting the text and tabbing away) must send `null`, not `""`, or the server rejects it as an invalid email and the field snaps back with no explanation. Pinned in Task 8.
3. **Partner has an email, case has none** must still email the vendor and record only `PARTNER_NOTIFIED`; the reverse must email only the client. Pinned in Task 5.
4. **An applicant whose traveller record cannot be read** (deleted, corrupt) must not fail the status email or the case page: the email says "Unnamed applicant", the page shows the applicant's fallback ref. Pinned in Task 4 and Task 5.
5. **A single-applicant imported case** (`applicantRef: "1"`, no `refNo`, no `groupName`) must produce the same email body it does today (no "Applicants:" block) and a sub-row that shows the case REF, not `"1"`. Pinned in Task 1 and Task 5.

---

### Task 1: Shared schema fields and the applicant display helper

**Files:**
- Modify: `packages/shared/src/crm/schemas.ts:84-94` (applicant), `:103-158` (case)
- Modify: `packages/shared/src/crm/ledger.ts:81-97` (`buildLedgerSearchText`), `:115-135` (`LedgerRowSchema`)
- Create: `packages/shared/src/crm/applicantDisplay.ts`
- Modify: `packages/shared/src/crm/index.ts`
- Test: `packages/shared/test/crm/schemas.test.ts`, `packages/shared/test/crm/ledger.test.ts`, `packages/shared/test/crm/applicantDisplay.test.ts` (new)

**Interfaces:**
- Produces: `CrmCase.groupName?: string`, `CrmCase.clientEmail?: string`, `CaseApplicant.refNo?: string`, `LedgerRow.groupName?: string`.
- Produces: `buildLedgerSearchText(applicants, extraTerms: readonly string[] = []): string | undefined`.
- Produces (new module, exported through `crm.*`):
  ```ts
  export const CaseTravellerSummarySchema: z.ZodObject<{ fullName: z.ZodString; passportNumber: z.ZodOptional<z.ZodString> }>;
  export type CaseTravellerSummary = { fullName: string; passportNumber?: string };
  export type CaseTravellerMap = Record<string, CaseTravellerSummary>;
  export const UNNAMED_APPLICANT = "Unnamed applicant";
  export function displayApplicantRef(caseRef: string, applicantCount: number, applicant: Pick<CaseApplicant, "applicantRef" | "refNo">): string;
  export function displayApplicantName(travellers: CaseTravellerMap | undefined, applicant: Pick<CaseApplicant, "travellerId">): string;
  ```

- [ ] **Step 1: Write the failing schema tests**

Append to `packages/shared/test/crm/schemas.test.ts` inside the existing `describe` that uses `validCase` / `validApplicant`:

```ts
describe("family group fields", () => {
  it("round-trips groupName, clientEmail and a per-applicant refNo", () => {
    const parsed = CrmCaseSchema.parse({
      ...validCase,
      groupName: "Sharma Family",
      clientEmail: "priya@example.com",
      applicants: [{ ...validApplicant, refNo: "RGS-2026-0912" }],
    });
    expect(parsed.groupName).toBe("Sharma Family");
    expect(parsed.clientEmail).toBe("priya@example.com");
    expect(parsed.applicants[0]!.refNo).toBe("RGS-2026-0912");
  });

  it("trims groupName and clientEmail", () => {
    const parsed = CrmCaseSchema.parse({
      ...validCase,
      groupName: "  Sharma Family ",
      clientEmail: " priya@example.com ",
    });
    expect(parsed.groupName).toBe("Sharma Family");
    expect(parsed.clientEmail).toBe("priya@example.com");
  });

  it("rejects a clientEmail that is not an email address", () => {
    expect(() => CrmCaseSchema.parse({ ...validCase, clientEmail: "priya at example" })).toThrow();
  });

  it("rejects a groupName over 120 characters and a refNo over 40", () => {
    expect(() => CrmCaseSchema.parse({ ...validCase, groupName: "x".repeat(121) })).toThrow();
    expect(() => CaseApplicantSchema.parse({ ...validApplicant, refNo: "x".repeat(41) })).toThrow();
  });

  it("leaves every one of the three fields absent when not supplied", () => {
    const parsed = CrmCaseSchema.parse(validCase);
    expect(parsed).not.toHaveProperty("groupName");
    expect(parsed).not.toHaveProperty("clientEmail");
    expect(parsed.applicants[0]).not.toHaveProperty("refNo");
  });
});
```

Append to `packages/shared/test/crm/ledger.test.ts`:

```ts
describe("LedgerRow groupName", () => {
  it("accepts an optional groupName on the row", () => {
    const row = LedgerRowSchema.parse({
      caseId: "case_1",
      caseRef: "RGS-1",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseType: "VISA",
      caseStatus: "NEW",
      billingStatus: "UNBILLED",
      receivedDate: "2026-09-01",
      totalInr: 0,
      updatedAt: "2026-09-01T00:00:00.000Z",
      groupName: "Sharma Family",
    });
    expect(row.groupName).toBe("Sharma Family");
  });
});

describe("buildLedgerSearchText extra terms", () => {
  it("appends lowercased extra terms after the applicant tokens", () => {
    expect(
      buildLedgerSearchText([{ fullName: "Asha Rao", passportNumber: "Z1" }], ["Sharma Family"]),
    ).toBe("asha rao z1 sharma family");
  });

  it("ignores blank extra terms and still returns undefined when nothing is searchable", () => {
    expect(buildLedgerSearchText([], ["  "])).toBeUndefined();
  });
});
```

Create `packages/shared/test/crm/applicantDisplay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  UNNAMED_APPLICANT,
  displayApplicantName,
  displayApplicantRef,
} from "../../src/crm/applicantDisplay";

describe("displayApplicantRef", () => {
  it("prefers the applicant's own refNo", () => {
    expect(displayApplicantRef("RGS-1", 3, { applicantRef: "A2", refNo: "RGS-2" })).toBe("RGS-2");
  });

  it("shows the case REF for a single-applicant case with no refNo (the imported shape)", () => {
    expect(displayApplicantRef("31377", 1, { applicantRef: "1" })).toBe("31377");
  });

  it("falls back to applicantRef on a multi-applicant case with no refNo", () => {
    expect(displayApplicantRef("RGS-1", 2, { applicantRef: "A2" })).toBe("A2");
  });
});

describe("displayApplicantName", () => {
  it("reads the traveller's full name from the map", () => {
    expect(displayApplicantName({ trv_1: { fullName: "Asha Rao" } }, { travellerId: "trv_1" })).toBe("Asha Rao");
  });

  it("says Unnamed applicant when the map is missing or has no entry", () => {
    expect(displayApplicantName(undefined, { travellerId: "trv_1" })).toBe(UNNAMED_APPLICANT);
    expect(displayApplicantName({}, { travellerId: "trv_1" })).toBe(UNNAMED_APPLICANT);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter ./packages/shared exec vitest run test/crm/schemas.test.ts test/crm/ledger.test.ts test/crm/applicantDisplay.test.ts`
Expected: FAIL. `applicantDisplay` module not found; `groupName` / `refNo` stripped so the round-trip assertions fail; `buildLedgerSearchText` ignores its second argument.

- [ ] **Step 3: Add the schema fields**

In `packages/shared/src/crm/schemas.ts`, inside `CaseApplicantSchema` after `applicantRef`:

```ts
  /**
   * The person's own REF NO, typed by the desk (spec 2026-09-25 D4). Optional:
   * a single-applicant case leaves it blank and shows `caseRef`. `applicantRef`
   * above stays the internal key.
   */
  refNo: z.string().trim().min(1).max(40).optional(),
```

Inside `CrmCaseSchema`'s object, after `remarks`:

```ts
    /** "Sharma Family": one name over every applicant on the case (spec 2026-09-25 D1). */
    groupName: z.string().trim().min(1).max(120).optional(),
    /** The client's address for status mail, typed by the desk (spec 2026-09-25 D3). */
    clientEmail: z.string().trim().email().optional(),
```

- [ ] **Step 4: Add `groupName` to the ledger row and extra terms to the search text**

In `packages/shared/src/crm/ledger.ts`, add to `LedgerRowSchema` after `visaType`:

```ts
  groupName: z.string().min(1).optional(),
```

Replace `buildLedgerSearchText` with:

```ts
export function buildLedgerSearchText(
  applicants: readonly { fullName?: string; passportNumber?: string }[],
  extraTerms: readonly string[] = [],
): string | undefined {
  const tokens: string[] = [];
  for (const applicant of applicants) {
    const fullName = applicant.fullName?.trim().toLowerCase();
    if (fullName !== undefined && fullName.length > 0) tokens.push(fullName);
    const passportNumber = applicant.passportNumber?.trim().toLowerCase();
    if (passportNumber !== undefined && passportNumber.length > 0) tokens.push(passportNumber);
  }
  for (const extraTerm of extraTerms) {
    const normalizedTerm = extraTerm.trim().toLowerCase();
    if (normalizedTerm.length > 0) tokens.push(normalizedTerm);
  }
  if (tokens.length === 0) return undefined;
  return [...new Set(tokens)].join(" ");
}
```

- [ ] **Step 5: Create the display helper module**

Create `packages/shared/src/crm/applicantDisplay.ts`:

```ts
import { z } from "zod";
import type { CaseApplicant } from "./schemas";

/**
 * What `GET /cases/{caseId}` attaches per traveller so the admin can show a
 * name beside each applicant (spec 2026-09-25 D7). Keyed by `travellerId`.
 */
export const CaseTravellerSummarySchema = z.object({
  fullName: z.string().min(1),
  passportNumber: z.string().optional(),
});
export type CaseTravellerSummary = z.infer<typeof CaseTravellerSummarySchema>;
export type CaseTravellerMap = Record<string, CaseTravellerSummary>;

export const UNNAMED_APPLICANT = "Unnamed applicant";

/**
 * The one display rule for an applicant's reference (spec 2026-09-25 §3.2):
 * their own `refNo` when set; the case REF when the case has exactly one
 * applicant (every imported case); otherwise the internal `applicantRef`.
 */
export function displayApplicantRef(
  caseRef: string,
  applicantCount: number,
  applicant: Pick<CaseApplicant, "applicantRef" | "refNo">,
): string {
  if (applicant.refNo !== undefined) return applicant.refNo;
  if (applicantCount === 1) return caseRef;
  return applicant.applicantRef;
}

export function displayApplicantName(
  travellers: CaseTravellerMap | undefined,
  applicant: Pick<CaseApplicant, "travellerId">,
): string {
  return travellers?.[applicant.travellerId]?.fullName ?? UNNAMED_APPLICANT;
}
```

Add to `packages/shared/src/crm/index.ts`:

```ts
export * from "./applicantDisplay";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter ./packages/shared exec vitest run test/crm/schemas.test.ts test/crm/ledger.test.ts test/crm/applicantDisplay.test.ts`
Expected: PASS. Then `pnpm --filter ./packages/shared typecheck` passes.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/crm/schemas.ts packages/shared/src/crm/ledger.ts packages/shared/src/crm/applicantDisplay.ts packages/shared/src/crm/index.ts packages/shared/test/crm/schemas.test.ts packages/shared/test/crm/ledger.test.ts packages/shared/test/crm/applicantDisplay.test.ts
git commit -m "feat(shared): groupName, clientEmail, per-applicant refNo and the applicant display rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: API create and update paths carry the new fields; search text includes the group name

**Files:**
- Modify: `services/api/src/domain/crm/cases.ts:22-37` (inputs), `:54-131` (`createCase`), `:149-254` (`updateCaseDetails`)
- Modify: `services/api/src/domain/crm/ledgerSearchText.ts`
- Modify: `services/api/src/domain/crm/caseStore.ts:21-24`
- Modify: `services/api/src/http/crmApi.ts:60-79` (`CreateCaseBody`), `:100-108` (`UpdateCaseDetailsBody`)
- Test: `services/api/test/crm/cases.test.ts`, `services/api/test/crm/updateCaseDetails.test.ts`, `services/api/test/crm/caseStore.test.ts`

**Interfaces:**
- Consumes: Task 1's schema fields and `buildLedgerSearchText(applicants, extraTerms)`.
- Produces:
  ```ts
  interface CreateCaseApplicantInput { applicantRef: string; travellerId: string; passportNumber?: string; refNo?: string }
  interface CreateCaseInput { ...existing; groupName?: string; clientEmail?: string }
  interface UpdateCaseDetailsInput { ...existing; groupName?: string | null; clientEmail?: string | null }
  resolveLedgerSearchText(context, tenantId, applicants, extraTerms: readonly string[] = []): Promise<string | undefined>
  ```

- [ ] **Step 1: Write the failing create test**

Append to `services/api/test/crm/cases.test.ts` (use the file's existing `buildTestContext`, `createPartner`, `upsertTraveller`, `createCase` imports; add any missing import from the same modules as `partnerStatusEmail.test.ts` uses):

```ts
describe("createCase family group fields", () => {
  it("stores groupName, clientEmail and each applicant's refNo", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, "rgs", { canonicalName: "Skyline Travels" }, "ops@rgs.test");
    const first = await upsertTraveller(context, "rgs", { fullName: "Rahul Sharma" });
    const second = await upsertTraveller(context, "rgs", { fullName: "Priya Sharma" });

    const created = await createCase(
      context,
      "rgs",
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        receivedDate: "2026-09-20",
        groupName: "Sharma Family",
        clientEmail: "priya@example.com",
        applicants: [
          { applicantRef: "A1", travellerId: first.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: second.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      "ops@rgs.test",
    );

    expect(created.groupName).toBe("Sharma Family");
    expect(created.clientEmail).toBe("priya@example.com");
    expect(created.applicants.map((applicant) => applicant.refNo)).toEqual(["RGS-2026-0912", "RGS-2026-0913"]);

    const reloaded = await getCase(context, "rgs", created.caseId);
    expect(reloaded).toEqual(created);
  });
});
```

(`getCase` is exported from `services/api/src/domain/crm/cases.ts`; add it to the import if the file does not already import it.)

- [ ] **Step 2: Write the failing update tests**

Append to `services/api/test/crm/updateCaseDetails.test.ts` inside `describe("updateCaseDetails")`:

```ts
  it("sets and then clears groupName and clientEmail", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    const withFields = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { groupName: "Rao Family", clientEmail: "asha@example.com" },
      ACTOR,
    );
    expect(withFields.groupName).toBe("Rao Family");
    expect(withFields.clientEmail).toBe("asha@example.com");

    const cleared = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { groupName: null, clientEmail: null },
      ACTOR,
    );
    expect(cleared).not.toHaveProperty("groupName");
    expect(cleared).not.toHaveProperty("clientEmail");

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvents = events.filter((event) => event.eventType === "CASE_UPDATED");
    expect(updateEvents.map((event) => event.meta["changedFields"])).toEqual([
      "groupName,clientEmail",
      "groupName,clientEmail",
    ]);
  });

  it("treats clearing an already-absent clientEmail as no change", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    const unchanged = await updateCaseDetails(context, TENANT_ID, seeded.caseId, { clientEmail: null }, ACTOR);

    expect(unchanged.updatedAt).toBe(seeded.updatedAt);
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    expect(events.some((event) => event.eventType === "CASE_UPDATED")).toBe(false);
  });

  it("rejects a malformed clientEmail with a 400 naming the field", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { clientEmail: "not an address" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("clientEmail") });
  });
```

- [ ] **Step 3: Write the failing search-text test**

Append to `services/api/test/crm/caseStore.test.ts` inside its main `describe` (the file already has `buildCase`, `writeCase`, `casePartitionKey`, `META_SORT_KEY` available; add `META_SORT_KEY` to the keys import if absent):

```ts
  it("stamps the group name into searchText so the ledger can find a family by name", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase({ groupName: "Sharma Family" } as Partial<crm.CrmCase>));

    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(String(metaItem!["searchText"])).toContain("sharma family");
    expect(metaItem!["groupName"]).toBe("Sharma Family");
  });
```

- [ ] **Step 4: Run the three files to verify they fail**

Run: `pnpm --filter ./services/api exec vitest run test/crm/cases.test.ts test/crm/updateCaseDetails.test.ts test/crm/caseStore.test.ts`
Expected: FAIL. TypeScript rejects `groupName` on `CreateCaseInput`; `updateCaseDetails` ignores the new keys; `searchText` lacks the group name.

- [ ] **Step 5: Extend the domain inputs and `createCase`**

In `services/api/src/domain/crm/cases.ts`:

```ts
export interface CreateCaseApplicantInput {
  applicantRef: string;
  travellerId: string;
  passportNumber?: string;
  refNo?: string;
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
  expectedCollectionDate?: string;
  remarks?: string;
  groupName?: string;
  clientEmail?: string;
  applicants: CreateCaseApplicantInput[];
}
```

In `createCase`'s `CrmCaseSchema.parse({...})` add after the `remarks` spread:

```ts
      ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
      ...(input.clientEmail !== undefined ? { clientEmail: input.clientEmail } : {}),
```

and in the applicants map add after the `passportNumber` spread:

```ts
        ...(applicant.refNo !== undefined ? { refNo: applicant.refNo } : {}),
```

- [ ] **Step 6: Extend `updateCaseDetails`**

Add to `UpdateCaseDetailsInput`:

```ts
  /** `null` clears the field; `undefined` leaves it alone. */
  groupName?: string | null;
  clientEmail?: string | null;
```

After the `remarks` changed-field check, add:

```ts
  // `null` means "clear". Comparing through `?? undefined` makes "clear an
  // absent field" read as no change, so it neither bumps updatedAt nor
  // records an event naming a change nobody made.
  const groupNameChanging =
    input.groupName !== undefined && (input.groupName ?? undefined) !== currentCase.groupName;
  if (groupNameChanging) changedFieldNames.push("groupName");
  const clientEmailChanging =
    input.clientEmail !== undefined && (input.clientEmail ?? undefined) !== currentCase.clientEmail;
  if (clientEmailChanging) changedFieldNames.push("clientEmail");
```

Replace the `caseForParse` computation so cleared fields are dropped before the parse. The two clearable fields are removed from the base and re-added only when they have a value:

```ts
    const nextGroupName = groupNameChanging ? (input.groupName ?? undefined) : currentCase.groupName;
    const nextClientEmail = clientEmailChanging ? (input.clientEmail ?? undefined) : currentCase.clientEmail;
    const {
      appointmentReminderSentFor,
      groupName: _storedGroupName,
      clientEmail: _storedClientEmail,
      ...caseBase
    } = currentCase;
    const caseForParse = {
      ...caseBase,
      ...(appointmentDateChanging || appointmentReminderSentFor === undefined ? {} : { appointmentReminderSentFor }),
      ...(nextGroupName !== undefined ? { groupName: nextGroupName } : {}),
      ...(nextClientEmail !== undefined ? { clientEmail: nextClientEmail } : {}),
    };
```

The existing `updatedCase = crm.CrmCaseSchema.parse({ ...caseForParse, ...input spreads, updatedAt })` stays as is. Do not add `groupName` or `clientEmail` to those input spreads; `caseForParse` already carries the resolved values. The `badRequest(describeFirstZodIssue(error))` already turns a Zod issue on `clientEmail` into a 400 whose message contains the path.

- [ ] **Step 7: Thread the group name into search text**

`services/api/src/domain/crm/ledgerSearchText.ts`: change the signature and last line:

```ts
export async function resolveLedgerSearchText(
  context: AppContext,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
  extraTerms: readonly string[] = [],
): Promise<string | undefined> {
  // ...existing loop unchanged...
  return crm.buildLedgerSearchText(searchParts, extraTerms);
}
```

`services/api/src/domain/crm/caseStore.ts` `writeCase`:

```ts
  const searchText = await resolveLedgerSearchText(
    context,
    crmCase.tenantId,
    applicants,
    crmCase.groupName === undefined ? [] : [crmCase.groupName],
  );
```

- [ ] **Step 8: Extend the HTTP bodies**

In `services/api/src/http/crmApi.ts`, `CreateCaseBody`: add after `remarks`:

```ts
  groupName: z.string().trim().min(1).max(120).optional(),
  clientEmail: z.string().trim().email().optional(),
```

and inside the applicants object:

```ts
        refNo: z.string().trim().min(1).max(40).optional(),
```

`UpdateCaseDetailsBody`: add after `remarks`:

```ts
  groupName: z.string().trim().min(1).max(120).nullable().optional(),
  clientEmail: z.string().trim().email().nullable().optional(),
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter ./services/api exec vitest run test/crm/cases.test.ts test/crm/updateCaseDetails.test.ts test/crm/caseStore.test.ts test/crm/crmApi.test.ts`
Expected: PASS (the pre-existing "round-trips" failure in caseStore.test.ts is allowed to persist). `pnpm --filter ./services/api typecheck` passes. Also run `pnpm --filter ./services/migration typecheck` because the backfill calls `resolveLedgerSearchText` with three arguments, which still compiles.

- [ ] **Step 10: Commit**

```bash
git add services/api/src/domain/crm/cases.ts services/api/src/domain/crm/ledgerSearchText.ts services/api/src/domain/crm/caseStore.ts services/api/src/http/crmApi.ts services/api/test/crm/cases.test.ts services/api/test/crm/updateCaseDetails.test.ts services/api/test/crm/caseStore.test.ts
git commit -m "feat(api): create and update paths carry groupName, clientEmail and refNo; group name is searchable

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Partner contact update

**Files:**
- Modify: `services/api/src/domain/crm/partners.ts`
- Modify: `services/api/src/http/crmApi.ts` (body schema near line 51; route after `POST /partners` at line 187)
- Test: `services/api/test/crm/partners.test.ts`, `services/api/test/crm/crmApi.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UpdatePartnerContactInput { contactEmail?: string | null; contactPhone?: string | null; contactWhatsapp?: string | null }
  export async function updatePartnerContact(context: AppContext, tenantId: string, partnerId: string, input: UpdatePartnerContactInput): Promise<crm.Partner>
  ```
- Produces route: `PUT /api/v1/admin/crm/partners/{partnerId}/contact` (write-guarded), body `UpdatePartnerContactBody`, returns the partner.

- [ ] **Step 1: Write the failing domain tests**

Append to `services/api/test/crm/partners.test.ts` (add `updatePartnerContact` to the partners import):

```ts
describe("updatePartnerContact", () => {
  it("sets the contact email on a partner created without one, leaving everything else intact", async () => {
    const context = buildTestContext();
    const created = await createPartner(context, "rgs", { canonicalName: "Skyline Travels", aliases: ["Skyline"] }, "ops@rgs.test");

    const updated = await updatePartnerContact(context, "rgs", created.partnerId, { contactEmail: "desk@skyline.test" });

    expect(updated.contactEmail).toBe("desk@skyline.test");
    expect(updated.canonicalName).toBe("Skyline Travels");
    expect(updated.aliases).toEqual(["Skyline"]);
    expect(await getPartnerOrThrow(context, "rgs", created.partnerId)).toEqual(updated);
    // The listing index key survives the rewrite: the partner is still findable by name.
    expect((await findPartnerByName(context, "rgs", "Skyline Travels"))?.partnerId).toBe(created.partnerId);
  });

  it("clears a contact field when given null and leaves an omitted field alone", async () => {
    const context = buildTestContext();
    const created = await createPartner(
      context,
      "rgs",
      { canonicalName: "Ozzy Travels", contactEmail: "old@ozzy.test", contactPhone: "+91 98100 00000" },
      "ops@rgs.test",
    );

    const updated = await updatePartnerContact(context, "rgs", created.partnerId, { contactEmail: null });

    expect(updated).not.toHaveProperty("contactEmail");
    expect(updated.contactPhone).toBe("+91 98100 00000");
  });

  it("404s for a partner that does not exist", async () => {
    const context = buildTestContext();
    await expect(
      updatePartnerContact(context, "rgs", "prt_missing", { contactEmail: "x@y.test" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Write the failing route tests**

Append to `services/api/test/crm/crmApi.test.ts` inside the top-level `describe` (the file has `buildRouter`, `call`, `callUnauthenticated`, `buildTestContext`):

```ts
  it("updates a partner's contact email through PUT /partners/{partnerId}/contact", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const { payload: partner } = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Skyline Travels",
    });

    const response = await call(router, "PUT", `/api/v1/admin/crm/partners/${partner.partnerId}/contact`, {
      contactEmail: "desk@skyline.test",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.contactEmail).toBe("desk@skyline.test");

    const listing = await call(router, "GET", "/api/v1/admin/crm/partners");
    expect(listing.payload.partners[0].contactEmail).toBe("desk@skyline.test");
  });

  it("rejects a malformed contact email on the partner contact route with 400", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const { payload: partner } = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Skyline Travels",
    });

    const response = await call(router, "PUT", `/api/v1/admin/crm/partners/${partner.partnerId}/contact`, {
      contactEmail: "desk at skyline",
    });

    expect(response.statusCode).toBe(400);
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter ./services/api exec vitest run test/crm/partners.test.ts test/crm/crmApi.test.ts`
Expected: FAIL. `updatePartnerContact` is not exported; the route answers 404 (no route matched).

- [ ] **Step 4: Implement the domain function**

Append to `services/api/src/domain/crm/partners.ts`:

```ts
export interface UpdatePartnerContactInput {
  /** `null` clears the field; `undefined` leaves it alone. */
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactWhatsapp?: string | null;
}

/**
 * The desk types a vendor's email onto the system by hand (owner, 2026-09-25),
 * usually well after the partner was created by the importer with no contact
 * details at all. Only the three contact fields move; the name, aliases and
 * type have their own rules and stay exactly as stored. The raw item is
 * re-put with its GSI1 keys intact so the partner stays listed and findable.
 */
export async function updatePartnerContact(
  context: AppContext,
  tenantId: string,
  partnerId: string,
  input: UpdatePartnerContactInput,
): Promise<crm.Partner> {
  const partnerItem = await context.table.get(partnerPartitionKey(tenantId, partnerId), META_SORT_KEY);
  if (!partnerItem) throw notFound("Partner");
  const currentPartner = parseStoredPartner(partnerItem);

  const { contactEmail: _email, contactPhone: _phone, contactWhatsapp: _whatsapp, ...partnerWithoutContact } = currentPartner;
  const resolveField = (next: string | null | undefined, current: string | undefined): string | undefined =>
    next === undefined ? current : next === null ? undefined : next;
  const contactEmail = resolveField(input.contactEmail, currentPartner.contactEmail);
  const contactPhone = resolveField(input.contactPhone, currentPartner.contactPhone);
  const contactWhatsapp = resolveField(input.contactWhatsapp, currentPartner.contactWhatsapp);

  const updatedPartner = crm.PartnerSchema.parse({
    ...partnerWithoutContact,
    ...(contactEmail !== undefined ? { contactEmail } : {}),
    ...(contactPhone !== undefined ? { contactPhone } : {}),
    ...(contactWhatsapp !== undefined ? { contactWhatsapp } : {}),
  });

  // `TableItem` (lib/db.ts) types PK/SK as strings and GSI1PK/GSI1SK as
  // optional strings, so these read back typed. GSI1SK is the canonical name
  // key createPartner stored; it is not on PartnerSchema and must be carried
  // over by hand or the partner drops out of every by-name lookup.
  await context.table.put({
    PK: partnerItem.PK,
    SK: partnerItem.SK,
    GSI1PK: partnerListGsi1Pk(tenantId),
    ...(partnerItem.GSI1SK !== undefined ? { GSI1SK: partnerItem.GSI1SK } : {}),
    ...updatedPartner,
  });
  return updatedPartner;
}
```

- [ ] **Step 5: Wire the route**

In `services/api/src/http/crmApi.ts` add near `CreatePartnerBody`:

```ts
const UpdatePartnerContactBody = z.object({
  contactEmail: z.string().trim().email().nullable().optional(),
  contactPhone: z.string().trim().min(1).nullable().optional(),
  contactWhatsapp: z.string().trim().min(1).nullable().optional(),
});
```

Import `updatePartnerContact` from `../domain/crm/partners` and register right after the `POST /partners` route:

```ts
    .add("PUT", "/api/v1/admin/crm/partners/{partnerId}/contact", async (requestContext) => {
      requireWrite(requestContext, "crm");
      const body = parseBody(UpdatePartnerContactBody, requestContext.body);
      return updatePartnerContact(context, tenantId, requestContext.pathParams["partnerId"]!, body);
    })
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm --filter ./services/api exec vitest run test/crm/partners.test.ts test/crm/crmApi.test.ts`
Expected: PASS. `pnpm --filter ./services/api typecheck` passes.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/domain/crm/partners.ts services/api/src/http/crmApi.ts services/api/test/crm/partners.test.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(api): PUT /partners/{partnerId}/contact so the desk can type a vendor email

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Single-case GET returns resolved traveller names

**Files:**
- Create: `services/api/src/domain/crm/caseTravellers.ts`
- Modify: `services/api/src/http/crmApi.ts:284-287` (`GET /cases/{caseId}`)
- Test: `services/api/test/crm/caseTravellers.test.ts` (new), `services/api/test/crm/crmApi.test.ts`

**Interfaces:**
- Consumes: `crm.CaseTravellerMap`, `crm.CrmTravellerSchema`, `travellerPartitionKey`, `META_SORT_KEY`, `stripStorageKeys`.
- Produces:
  ```ts
  export async function resolveCaseTravellers(context: AppContext, tenantId: string, applicants: readonly crm.CaseApplicant[]): Promise<crm.CaseTravellerMap>
  ```
- Produces wire shape for `GET /cases/{caseId}`: `{ ...crmCase, travellers: CaseTravellerMap }`.

- [ ] **Step 1: Write the failing domain test**

Create `services/api/test/crm/caseTravellers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { resolveCaseTravellers } from "../../src/domain/crm/caseTravellers";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { META_SORT_KEY, travellerPartitionKey } from "../../src/domain/crm/keys";

describe("resolveCaseTravellers", () => {
  it("maps each applicant's travellerId to the traveller's name and passport", async () => {
    const context = buildTestContext();
    const asha = await upsertTraveller(context, "rgs", { fullName: "Asha Rao", passportNumber: "Z1" });
    const ravi = await upsertTraveller(context, "rgs", { fullName: "Ravi Rao" });

    const travellers = await resolveCaseTravellers(context, "rgs", [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: ravi.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(travellers).toEqual({
      [asha.travellerId]: { fullName: "Asha Rao", passportNumber: "Z1" },
      [ravi.travellerId]: { fullName: "Ravi Rao" },
    });
  });

  it("leaves out a traveller that is missing or corrupt rather than failing the read", async () => {
    const context = buildTestContext();
    const asha = await upsertTraveller(context, "rgs", { fullName: "Asha Rao" });
    await context.table.put({ PK: travellerPartitionKey("rgs", "trv_corrupt"), SK: META_SORT_KEY, fullName: 42 });

    const travellers = await resolveCaseTravellers(context, "rgs", [
      { applicantRef: "A1", travellerId: asha.travellerId, custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A2", travellerId: "trv_missing", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "A3", travellerId: "trv_corrupt", custody: "NOT_HELD", outcome: "PENDING" },
    ]);

    expect(Object.keys(travellers)).toEqual([asha.travellerId]);
  });
});
```

- [ ] **Step 2: Write the failing route test**

Append to `services/api/test/crm/crmApi.test.ts`:

```ts
  it("attaches resolved traveller names to GET /cases/{caseId}", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const { payload: partner } = await call(router, "POST", "/api/v1/admin/crm/partners", { canonicalName: "Skyline Travels" });
    const { payload: traveller } = await call(router, "POST", "/api/v1/admin/crm/travellers", { fullName: "Asha Rao", passportNumber: "Z1" });
    const { payload: created } = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "RGS-T-1",
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "AE",
      receivedDate: "2026-09-16",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId, passportNumber: "Z1" }],
    });

    const response = await call(router, "GET", `/api/v1/admin/crm/cases/${created.caseId}`);

    expect(response.statusCode).toBe(200);
    expect(response.payload.caseRef).toBe("RGS-T-1");
    expect(response.payload.travellers).toEqual({
      [traveller.travellerId]: { fullName: "Asha Rao", passportNumber: "Z1" },
    });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter ./services/api exec vitest run test/crm/caseTravellers.test.ts test/crm/crmApi.test.ts`
Expected: FAIL. Module not found; `travellers` undefined on the GET payload.

- [ ] **Step 4: Create the resolver**

Create `services/api/src/domain/crm/caseTravellers.ts`:

```ts
import { crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { stripStorageKeys } from "../../lib/storedRecords";
import { META_SORT_KEY, travellerPartitionKey } from "./keys";

/**
 * The names behind a case's applicants, keyed by `travellerId` (spec
 * 2026-09-25 D7). Best-effort on purpose, the same discipline as
 * `resolveLedgerSearchText`: a traveller that is missing or will not parse is
 * simply absent from the map, and the reader falls back to
 * `crm.displayApplicantName`'s "Unnamed applicant". One `get` per distinct
 * traveller; a family of four costs four reads.
 */
export async function resolveCaseTravellers(
  context: AppContext,
  tenantId: string,
  applicants: readonly crm.CaseApplicant[],
): Promise<crm.CaseTravellerMap> {
  const travellers: crm.CaseTravellerMap = {};
  const distinctTravellerIds = [...new Set(applicants.map((applicant) => applicant.travellerId))];
  for (const travellerId of distinctTravellerIds) {
    const travellerItem = await context.table.get(travellerPartitionKey(tenantId, travellerId), META_SORT_KEY);
    if (travellerItem === undefined) continue;
    const parsedTraveller = crm.CrmTravellerSchema.safeParse(stripStorageKeys(travellerItem));
    if (!parsedTraveller.success) continue;
    travellers[travellerId] = {
      fullName: parsedTraveller.data.fullName,
      ...(parsedTraveller.data.passportNumber !== undefined
        ? { passportNumber: parsedTraveller.data.passportNumber }
        : {}),
    };
  }
  return travellers;
}
```

- [ ] **Step 5: Attach it to the GET route**

In `services/api/src/http/crmApi.ts`, import `resolveCaseTravellers` from `../domain/crm/caseTravellers` and change the single-case route:

```ts
    .add("GET", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireScreen(requestContext, "crm");
      const crmCase = await getCase(context, tenantId, requestContext.pathParams["caseId"]!);
      // Names ride on the single-case read only (spec 2026-09-25 §4.4). The
      // mutation routes still answer a bare CrmCase; the admin refetches this
      // route after every settled write, so the names come back on their own.
      const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
      return { ...crmCase, travellers };
    })
```

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm --filter ./services/api exec vitest run test/crm/caseTravellers.test.ts test/crm/crmApi.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/domain/crm/caseTravellers.ts services/api/src/http/crmApi.ts services/api/test/crm/caseTravellers.test.ts services/api/test/crm/crmApi.test.ts
git commit -m "feat(api): GET /cases/{caseId} resolves traveller names for the case page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Status email to vendor and client, with the group body and CLIENT_NOTIFIED

**Files:**
- Rename: `services/api/src/domain/crm/partnerStatusNotify.ts` → `services/api/src/domain/crm/statusNotify.ts`
- Modify: `services/api/src/domain/crm/cases.ts:20` (import), `:277-284`, `:448-455` (call sites)
- Modify: `services/api/src/domain/crm/crmEvents.ts:5-24` (event union)
- Rename: `services/api/test/crm/partnerStatusEmail.test.ts` → `services/api/test/crm/statusNotify.test.ts`
- Check: `grep -rn "partnerStatusNotify\|notifyPartnerOfCaseStatusChange" services/ apps/ packages/` must return nothing after this task (the agent write tools and appointment reminders do not import it today; confirm).

**Interfaces:**
- Consumes: Task 4's `resolveCaseTravellers`; Task 1's `displayApplicantRef`, `displayApplicantName`.
- Produces:
  ```ts
  export async function buildStatusEmailSubject(context, tenantId, crmCase, toStatus): Promise<string>  // unchanged signature
  export function buildStatusEmailBody(crmCase: crm.CrmCase, fromStatus: crm.CaseStatus, toStatus: crm.CaseStatus, travellers: crm.CaseTravellerMap): string
  export async function notifyOnCaseStatusChange(context, tenantId, crmCase, fromStatus, toStatus, actorEmail): Promise<void>
  ```
- Produces event type `"CLIENT_NOTIFIED"` with meta `{channel: "email", toAddress, fromStatus, toStatus}`.

- [ ] **Step 1: Rename the module and test file, update imports**

```bash
git mv services/api/src/domain/crm/partnerStatusNotify.ts services/api/src/domain/crm/statusNotify.ts
git mv services/api/test/crm/partnerStatusEmail.test.ts services/api/test/crm/statusNotify.test.ts
```

In `cases.ts` change the import to `import { notifyOnCaseStatusChange } from "./statusNotify";` and both call sites to `await notifyOnCaseStatusChange(`. In `crmEvents.ts` add `| "CLIENT_NOTIFIED"` after `"PARTNER_NOTIFIED"`.

- [ ] **Step 2: Write the failing tests**

Replace the contents of `services/api/test/crm/statusNotify.test.ts` with the four existing tests (kept verbatim, but the `describe` renamed to `"status-change email"`) plus these. Add imports: `buildStatusEmailBody` from `../../src/domain/crm/statusNotify`, `updateCaseDetails` from `../../src/domain/crm/cases`, `META_SORT_KEY, travellerPartitionKey` from `../../src/domain/crm/keys`.

```ts
  it("emails the client too when the case carries a clientEmail, and records CLIENT_NOTIFIED", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-5",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        clientEmail: "asha@example.com",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["desk@skyline.test", "asha@example.com"]);
    expect(context.email.sentEmails[0]!.subject).toBe(context.email.sentEmails[1]!.subject);
    expect(context.email.sentEmails[0]!.bodyText).toBe(context.email.sentEmails[1]!.bodyText);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    const clientEvent = events.find((event) => event.eventType === "CLIENT_NOTIFIED");
    expect(clientEvent?.meta).toEqual({ channel: "email", toAddress: "asha@example.com", fromStatus: "NEW", toStatus: "IN_PROGRESS" });
    expect(events.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(true);
  });

  it("emails only the client when the partner has no address, and only the partner when the case has none", async () => {
    const context = buildTestContext();
    const partnerWithoutEmail = await createPartner(context, TENANT_ID, { canonicalName: "Quiet Travels" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const clientOnly = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-6",
        caseType: "VISA",
        partnerId: partnerWithoutEmail.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        clientEmail: "asha@example.com",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await changeCaseStatus(context, TENANT_ID, clientOnly.caseId, "IN_PROGRESS", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["asha@example.com"]);
    const clientOnlyEvents = await listCaseEvents(context, TENANT_ID, clientOnly.caseId);
    expect(clientOnlyEvents.some((event) => event.eventType === "PARTNER_NOTIFIED")).toBe(false);
    expect(clientOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(true);

    const partnerWithEmail = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const partnerOnly = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-MAIL-7",
        caseType: "VISA",
        partnerId: partnerWithEmail.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await changeCaseStatus(context, TENANT_ID, partnerOnly.caseId, "IN_PROGRESS", ACTOR);
    expect(context.email.sentEmails.map((email) => email.toAddress)).toEqual(["asha@example.com", "desk@skyline.test"]);
    const partnerOnlyEvents = await listCaseEvents(context, TENANT_ID, partnerOnly.caseId);
    expect(partnerOnlyEvents.some((event) => event.eventType === "CLIENT_NOTIFIED")).toBe(false);
  });

  it("uses the group name as NAME in the subject when the case has one", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const priya = await upsertTraveller(context, TENANT_ID, { fullName: "Priya Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: priya.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails[0]!.subject).toBe("RGS-2026-0912 – In progress – Sharma Family – France");
  });

  it("lists every applicant with their REF NO, name and outcome, and the appointment date, for a group", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const priya = await upsertTraveller(context, TENANT_ID, { fullName: "Priya Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: priya.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      ACTOR,
    );
    await updateCaseDetails(context, TENANT_ID, created.caseId, { appointmentDate: "2026-10-03" }, ACTOR);

    await changeCaseStatus(context, TENANT_ID, created.caseId, "APPOINTMENT_SET", ACTOR);

    const bodyText = context.email.sentEmails.at(-1)!.bodyText;
    expect(bodyText).toContain("Applicants:");
    expect(bodyText).toContain("  RGS-2026-0912 – Rahul Sharma – Pending");
    expect(bodyText).toContain("  RGS-2026-0913 – Priya Sharma – Pending");
    expect(bodyText).toContain("Appointment date: 03 Oct 2026");
  });

  it("keeps the single-applicant body free of an Applicants block or an appointment line", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "Asha Rao" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "31377",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        applicants: [{ applicantRef: "1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    const bodyText = context.email.sentEmails[0]!.bodyText;
    expect(bodyText).not.toContain("Applicants:");
    expect(bodyText).not.toContain("Appointment date");
    expect(bodyText).toContain("Case 31377 (destination United Arab Emirates) is now In progress (was New).");
  });

  it("writes Unnamed applicant for a traveller that cannot be read, without failing the send", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }, ACTOR);
    const rahul = await upsertTraveller(context, TENANT_ID, { fullName: "Rahul Sharma" });
    const ghost = await upsertTraveller(context, TENANT_ID, { fullName: "Ghost Sharma" });
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "RGS-G-1",
        caseType: "VISA",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        visaType: "TOURIST",
        receivedDate: "2026-09-16",
        groupName: "Sharma Family",
        applicants: [
          { applicantRef: "A1", travellerId: rahul.travellerId },
          { applicantRef: "A2", travellerId: ghost.travellerId },
        ],
      },
      ACTOR,
    );
    await context.table.delete(travellerPartitionKey(TENANT_ID, ghost.travellerId), META_SORT_KEY);

    await changeCaseStatus(context, TENANT_ID, created.caseId, "IN_PROGRESS", ACTOR);

    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.bodyText).toContain("  A2 – Unnamed applicant – Pending");
  });

  it("builds the body as plain text in the documented order", () => {
    const bodyText = buildStatusEmailBody(
      {
        tenantId: "rgs",
        caseId: "case_1",
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: "prt_1",
        destinationCountry: "FR",
        caseStatus: "APPOINTMENT_SET",
        billingStatus: "UNBILLED",
        receivedDate: "2026-09-16",
        appointmentDate: "2026-10-03",
        groupName: "Sharma Family",
        lineItems: [],
        totalInr: 0,
        documentChecklist: [],
        applicants: [
          { applicantRef: "A1", travellerId: "trv_1", refNo: "RGS-2026-0912", custody: "NOT_HELD", outcome: "APPROVED" },
          { applicantRef: "A2", travellerId: "trv_2", refNo: "RGS-2026-0913", custody: "NOT_HELD", outcome: "REJECTED" },
        ],
        watchdogOverrides: {},
        mutedRules: [],
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      },
      "SUBMITTED",
      "APPOINTMENT_SET",
      { trv_1: { fullName: "Rahul Sharma" }, trv_2: { fullName: "Priya Sharma" } },
    );

    expect(bodyText).toBe(
      [
        "Hello,",
        "",
        "Case RGS-2026-0912 (destination France) is now Appointment set (was Submitted).",
        "",
        "Applicants:",
        "  RGS-2026-0912 – Rahul Sharma – Approved",
        "  RGS-2026-0913 – Priya Sharma – Rejected",
        "",
        "Appointment date: 03 Oct 2026",
        "",
        "— Rays Global Services",
      ].join("\n"),
    );
  });
```

Also update the existing first test's body assertion if it asserted the old `destination AE` wording: the body now prints the country name (`United Arab Emirates`), and the existing assertions `toContain("In progress")` and `toContain("New")` still hold.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusNotify.test.ts`
Expected: FAIL. `buildStatusEmailBody` and `notifyOnCaseStatusChange` do not exist yet (the module still exports the partner-only function).

- [ ] **Step 4: Rewrite `statusNotify.ts`**

Replace the file body below the `CASE_STATUS_EMAIL_LABELS` constant with:

```ts
import { COUNTRY_PRODUCTS, crm } from "@rgs/shared";
import type { AppContext } from "../../lib/context";
import { resolveCaseTravellers } from "./caseTravellers";
import { recordCrmEvent } from "./crmEvents";
import { getPartnerOrThrow } from "./partners";

/** Desk-facing words for status emails — keep in sync with admin CASE_STATUS_LABELS. */
const CASE_STATUS_EMAIL_LABELS: Record<crm.CaseStatus, string> = {
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

/** Keep in sync with admin OUTCOME_LABELS. */
const OUTCOME_EMAIL_LABELS: Record<crm.ApplicantOutcome, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT_BACK: "Sent back",
};

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-03` → `03 Oct 2026`. String arithmetic only: no Date, no timezone. */
function formatDateForEmail(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  const monthIndex = Number(month) - 1;
  return `${day} ${MONTH_ABBREVIATIONS[monthIndex] ?? month} ${year}`;
}

function countryNameOf(destinationCountry: string): string {
  return (
    COUNTRY_PRODUCTS.find((product) => product.countryCode === destinationCountry)?.countryName ??
    destinationCountry
  );
}

/**
 * `REF – STATUS – NAME – COUNTRY`: the desk's own filing convention for
 * status mail (feedback round 1, 2026-09-24). NAME is the group name when the
 * case has one (spec 2026-09-25 §5.2), otherwise the first applicant plus a
 * head-count for the rest.
 */
export async function buildStatusEmailSubject(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  toStatus: crm.CaseStatus,
): Promise<string> {
  const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
  return `${crmCase.caseRef} – ${CASE_STATUS_EMAIL_LABELS[toStatus]} – ${subjectName(crmCase, travellers)} – ${countryNameOf(crmCase.destinationCountry)}`;
}

function subjectName(crmCase: crm.CrmCase, travellers: crm.CaseTravellerMap): string {
  if (crmCase.groupName !== undefined) return crmCase.groupName;
  const firstApplicant = crmCase.applicants[0];
  if (firstApplicant === undefined) return crm.UNNAMED_APPLICANT;
  const firstName = crm.displayApplicantName(travellers, firstApplicant);
  const extraApplicantCount = crmCase.applicants.length - 1;
  return extraApplicantCount > 0 ? `${firstName} +${extraApplicantCount}` : firstName;
}

/**
 * Plain text, in the order spec 2026-09-25 §5.3 fixes. The "Applicants:" block
 * appears only for a group (a group name, or more than one applicant); the
 * appointment line only when a date is set. Vendor and client get this same
 * text (D6).
 */
export function buildStatusEmailBody(
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  travellers: crm.CaseTravellerMap,
): string {
  const lines: string[] = [
    "Hello,",
    "",
    `Case ${crmCase.caseRef} (destination ${countryNameOf(crmCase.destinationCountry)}) is now ${CASE_STATUS_EMAIL_LABELS[toStatus]} (was ${CASE_STATUS_EMAIL_LABELS[fromStatus]}).`,
  ];
  const isGroup = crmCase.groupName !== undefined || crmCase.applicants.length > 1;
  if (isGroup) {
    lines.push("", "Applicants:");
    for (const applicant of crmCase.applicants) {
      lines.push(
        `  ${crm.displayApplicantRef(crmCase.caseRef, crmCase.applicants.length, applicant)} – ${crm.displayApplicantName(travellers, applicant)} – ${OUTCOME_EMAIL_LABELS[applicant.outcome]}`,
      );
    }
  }
  if (crmCase.appointmentDate !== undefined) {
    lines.push("", `Appointment date: ${formatDateForEmail(crmCase.appointmentDate)}`);
  }
  lines.push("", "— Rays Global Services");
  return lines.join("\n");
}

/**
 * Best-effort mail to the vendor (partner) and the client when a case status
 * moves. Each recipient is independent: no address → no send and no event for
 * that recipient only. Send failures are the email adapter's problem
 * (`BestEffortEmailSender` in production); this module records the matching
 * *_NOTIFIED event after each send attempt returns.
 */
export async function notifyOnCaseStatusChange(
  context: AppContext,
  tenantId: string,
  crmCase: crm.CrmCase,
  fromStatus: crm.CaseStatus,
  toStatus: crm.CaseStatus,
  actorEmail: string,
): Promise<void> {
  const partner = await getPartnerOrThrow(context, tenantId, crmCase.partnerId);
  const travellers = await resolveCaseTravellers(context, tenantId, crmCase.applicants);
  const subject = `${crmCase.caseRef} – ${CASE_STATUS_EMAIL_LABELS[toStatus]} – ${subjectName(crmCase, travellers)} – ${countryNameOf(crmCase.destinationCountry)}`;
  const bodyText = buildStatusEmailBody(crmCase, fromStatus, toStatus, travellers);

  const recipients: { eventType: "PARTNER_NOTIFIED" | "CLIENT_NOTIFIED"; toAddress: string | undefined }[] = [
    { eventType: "PARTNER_NOTIFIED", toAddress: partner.contactEmail },
    { eventType: "CLIENT_NOTIFIED", toAddress: crmCase.clientEmail },
  ];
  for (const recipient of recipients) {
    if (recipient.toAddress === undefined || recipient.toAddress.trim() === "") continue;
    await context.email.send({ toAddress: recipient.toAddress, subject, bodyText });
    await recordCrmEvent(context, tenantId, crmCase.caseId, recipient.eventType, actorEmail, {
      channel: "email",
      toAddress: recipient.toAddress,
      fromStatus,
      toStatus,
    });
  }
}
```

`buildStatusEmailSubject` stays exported because `appointmentReminders.ts` or tests may import it; grep and keep it if referenced, otherwise it is still harmless.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter ./services/api exec vitest run test/crm/statusNotify.test.ts test/crm/cases.test.ts test/crm/crmApi.test.ts test/crm/appointmentReminders.test.ts`
Expected: PASS. Then `grep -rn "partnerStatusNotify\|notifyPartnerOfCaseStatusChange" services apps packages` prints nothing, and `pnpm --filter ./services/api typecheck` passes.

- [ ] **Step 6: Commit**

```bash
git add -A services/api/src/domain/crm services/api/test/crm
git commit -m "feat(api): status change emails vendor and client with a group body; CLIENT_NOTIFIED event

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Admin wire types and client methods

**Files:**
- Modify: `apps/admin/src/crm/api/crmClient.ts` (`CrmEventType`, `UpdateCaseDetailsBody`, `CreateCaseInput`, `getCase`, new `updatePartnerContact`, new `CaseView`)
- Modify: `apps/admin/src/crm/api/hooks.ts:72-78` (`useCase` return type follows `getCase` automatically; no code change unless the compiler asks)
- Test: `apps/admin/test/crm/crmClient.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CaseView = crm.CrmCase & { travellers?: crm.CaseTravellerMap };
  export interface UpdateCaseDetailsBody { ...existing; groupName?: string | null; clientEmail?: string | null }
  export interface CreateCaseInput { ...existing; groupName?: string; clientEmail?: string; applicants: Array<{ applicantRef; travellerId; passportNumber?; refNo? }> }
  export interface UpdatePartnerContactInput { contactEmail?: string | null; contactPhone?: string | null; contactWhatsapp?: string | null }
  crmClient.getCase(idToken, caseId): Promise<CaseView>
  crmClient.updatePartnerContact(idToken, partnerId, input): Promise<crm.Partner>
  ```
- `CrmEventType` gains `"CLIENT_NOTIFIED"`.

- [ ] **Step 1: Write the failing client test**

`apps/admin/test/crm/crmClient.test.ts` has `stubFetch(responses: unknown[]): RecordedRequest[]`, which returns the recorded requests. Append a new top-level `describe` at the end of the file:

```ts
describe("crmClient.updatePartnerContact", () => {
  it("PUTs to /partners/{partnerId}/contact with the id encoded and the body as given", async () => {
    const recorded = stubFetch([{ partnerId: "prt_1", canonicalName: "Skyline Travels", contactEmail: "desk@skyline.test" }]);

    const partner = await crmClient.updatePartnerContact("token", "prt 1/x", { contactEmail: "desk@skyline.test" });

    expect(partner.contactEmail).toBe("desk@skyline.test");
    expect(recorded[0]).toMatchObject({
      method: "PUT",
      url: expect.stringMatching(/\/api\/v1\/admin\/crm\/partners\/prt%201%2Fx\/contact$/),
      body: { contactEmail: "desk@skyline.test" },
      authorization: "Bearer token",
    });
  });

  it("sends null through untouched so the server clears the address", async () => {
    const recorded = stubFetch([{ partnerId: "prt_1", canonicalName: "Skyline Travels" }]);

    await crmClient.updatePartnerContact("token", "prt_1", { contactEmail: null });

    expect(recorded[0]!.body).toEqual({ contactEmail: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/crmClient.test.ts`
Expected: FAIL, `updatePartnerContact` is not a function.

- [ ] **Step 3: Extend the client**

In `apps/admin/src/crm/api/crmClient.ts`:

- Add `| "CLIENT_NOTIFIED"` to `CrmEventType` after `"PARTNER_NOTIFIED"`.
- Add to `UpdateCaseDetailsBody`:
  ```ts
  /** `null` clears; mirrors `UpdateCaseDetailsBody`'s `.nullable()` on the server. */
  groupName?: string | null;
  clientEmail?: string | null;
  ```
- Change `CreateCaseInput`:
  ```ts
  groupName?: string;
  clientEmail?: string;
  applicants: Array<{ applicantRef: string; travellerId: string; passportNumber?: string; refNo?: string }>;
  ```
- Add near `UpdateCaseDetailsBody`:
  ```ts
  /**
   * `GET /cases/{caseId}` (crmApi.ts) attaches the resolved traveller names.
   * Optional on the type because every mutation route still answers a bare
   * CrmCase, and an optimistic patch spreads whatever the cache held.
   */
  export type CaseView = crm.CrmCase & { travellers?: crm.CaseTravellerMap };

  export interface UpdatePartnerContactInput {
    contactEmail?: string | null;
    contactPhone?: string | null;
    contactWhatsapp?: string | null;
  }
  ```
- Change `getCase` to return `Promise<CaseView>` (`apiFetch<CaseView>`).
- Add after `createPartner`:
  ```ts
  updatePartnerContact(idToken: string, partnerId: string, input: UpdatePartnerContactInput): Promise<crm.Partner> {
    return apiFetch<crm.Partner>(`${CRM_BASE}/partners/${encodeURIComponent(partnerId)}/contact`, {
      method: "PUT",
      body: input,
      idToken,
    });
  },
  ```

- [ ] **Step 4: Run to verify it passes and the app still type-checks**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/crmClient.test.ts && pnpm --filter ./apps/admin typecheck`
Expected: PASS. If `typecheck` complains that `useCase`'s consumers expect `crm.CrmCase`, `CaseView` is assignable to it, so the complaint will be the reverse (something assigning a `CrmCase` into a `CaseView` slot); `travellers` is optional so that is assignable too. Fix any residual by importing `CaseView` where needed.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/crm/api/crmClient.ts apps/admin/test/crm/crmClient.test.ts
git commit -m "feat(admin): client types for group fields, CaseView travellers and partner contact update

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: New Case form: group name, client email, per-applicant REF NO

**Files:**
- Modify: `apps/admin/src/crm/newCase/NewCaseDrawer.tsx`
- Test: `apps/admin/test/crm/NewCaseDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 6's `CreateCaseInput`.
- Labels (exact, tests key on them): "Group name", "Client email", "Applicant N REF NO".

- [ ] **Step 1: Write the failing tests**

Append to `apps/admin/test/crm/NewCaseDrawer.test.tsx` inside `describe("NewCaseDrawer")`:

```ts
  it("sends group name, trimmed client email and each applicant's REF NO", async () => {
    const { requestLog } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.change(screen.getByLabelText("Group name"), { target: { value: "  Sharma Family " } });
    fireEvent.change(screen.getByLabelText("Client email"), { target: { value: "  Priya@Example.com " } });
    fireEvent.change(screen.getByLabelText("Applicant 1 REF NO"), { target: { value: " RGS-2026-0912 " } });
    fireEvent.click(screen.getByRole("button", { name: "Add another applicant" }));
    fireEvent.change(screen.getByLabelText("Applicant 2 name"), { target: { value: "Priya Sharma" } });
    fireEvent.change(screen.getByLabelText("Applicant 2 REF NO"), { target: { value: "RGS-2026-0913" } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    const caseWrite = requestLog.find((request) => request.method === "POST" && request.url.endsWith("/cases"));
    expect(caseWrite!.body).toMatchObject({
      groupName: "Sharma Family",
      clientEmail: "Priya@Example.com",
      applicants: [
        { applicantRef: "A1", refNo: "RGS-2026-0912" },
        { applicantRef: "A2", refNo: "RGS-2026-0913" },
      ],
    });
  });

  it("omits group name, client email and REF NO when left blank", async () => {
    const { requestLog } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));
    await screen.findByText("Landed on the case page");

    const caseWrite = requestLog.find((request) => request.method === "POST" && request.url.endsWith("/cases"));
    expect(caseWrite!.body).not.toHaveProperty("groupName");
    expect(caseWrite!.body).not.toHaveProperty("clientEmail");
    expect((caseWrite!.body as { applicants: object[] }).applicants[0]).not.toHaveProperty("refNo");
  });

  it("refuses a client email with no @ before sending anything", async () => {
    const { requestLog } = renderDrawer();
    await fillTheCommonFields();
    fireEvent.change(screen.getByLabelText("Partner"), { target: { value: "partner_1" } });
    fireEvent.change(screen.getByLabelText("Client email"), { target: { value: "priya at example" } });

    fireEvent.click(screen.getByRole("button", { name: "Create case" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the client email as a full address.");
    expect(requestLog.filter((request) => request.method === "POST")).toHaveLength(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/NewCaseDrawer.test.tsx`
Expected: FAIL, `getByLabelText("Group name")` finds nothing.

- [ ] **Step 3: Implement the form fields**

In `apps/admin/src/crm/newCase/NewCaseDrawer.tsx`:

Applicant draft gains a ref:

```ts
interface ApplicantDraft {
  fullName: string;
  passportNumber: string;
  refNo: string;
}

const EMPTY_APPLICANT: ApplicantDraft = { fullName: "", passportNumber: "", refNo: "" };
```

State, after `remarks`:

```ts
  const [groupName, setGroupName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
```

In `mutationFn`, the applicants push becomes:

```ts
        const refNo = applicantDraft.refNo.trim();
        applicants.push({
          applicantRef: `A${applicantIndex + 1}`,
          travellerId: traveller.travellerId,
          ...(passportNumber === undefined ? {} : { passportNumber }),
          ...(refNo === "" ? {} : { refNo }),
        });
```

and the `createCase` call gains, after the `remarks` spread:

```ts
        ...(groupName.trim() !== "" ? { groupName: groupName.trim() } : {}),
        ...(clientEmail.trim() !== "" ? { clientEmail: clientEmail.trim() } : {}),
```

In `describeValidationProblem()`, before the applicant-name check:

```ts
    const trimmedClientEmail = clientEmail.trim();
    if (trimmedClientEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedClientEmail)) {
      return "Enter the client email as a full address.";
    }
```

Markup: replace the `Applicants` fieldset legend area with a group section above the applicants. Insert after the Remarks label and before `<fieldset>`:

```tsx
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Group name</span>
              <input
                value={groupName}
                onChange={(changeEvent) => setGroupName(changeEvent.target.value)}
                placeholder="e.g. Sharma Family (optional)"
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Client email</span>
              <input
                type="email"
                value={clientEmail}
                onChange={(changeEvent) => setClientEmail(changeEvent.target.value)}
                placeholder="For status updates (optional)"
                className={FIELD_CLASS}
              />
            </label>
          </div>
```

Inside each applicant row, change the grid to `sm:grid-cols-[1fr_1fr_1fr_auto]` and add after the Passport label:

```tsx
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL_CLASS}>Applicant {applicantIndex + 1} REF NO</span>
                  <input
                    value={applicantDraft.refNo}
                    onChange={(changeEvent) => updateApplicant(applicantIndex, { refNo: changeEvent.target.value })}
                    placeholder="Own REF (optional)"
                    className={`${FIELD_CLASS} mrz`}
                  />
                </label>
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/NewCaseDrawer.test.tsx`
Expected: PASS, including the older tests (the "omits blank optional fields" test still passes because blank fields are omitted).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/crm/newCase/NewCaseDrawer.tsx apps/admin/test/crm/NewCaseDrawer.test.tsx
git commit -m "feat(admin): New Case form takes a group name, client email and per-applicant REF NO

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Case page: group name, inline client and vendor email, applicant names and REF NOs

**Files:**
- Modify: `apps/admin/src/crm/case/CasePage.tsx` (`CaseScreen`, `CaseHeader`, `ApplicantsTable`; new `InlineEmailControl`)
- Test: `apps/admin/test/crm/CasePage.test.tsx`

**Interfaces:**
- Consumes: Task 6's `CaseView`, `crmClient.updatePartnerContact`, `crmClient.updateCaseDetails` with `clientEmail: string | null`; Task 1's `crm.displayApplicantRef`, `crm.displayApplicantName`; `crmQueryKeys.case`, `crmQueryKeys.partners`.
- Accessible names (tests key on them): input "Client email", input "Vendor email", column headers "REF NO", "Name".

- [ ] **Step 1: Write the failing tests**

In `apps/admin/test/crm/CasePage.test.tsx`, first widen `renderCasePage` so the stubbed case GET can carry `travellers` and so a partner `PUT .../contact` is answered. Change the `caseRecord` option type to `crm.CrmCase & { travellers?: crm.CaseTravellerMap }` and add, before the final fallthrough `return`:

```ts
    if (requestMethod === "PUT" && requestUrl.includes("/partners/") && requestUrl.endsWith("/contact")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ partnerId: "partner_1", canonicalName: "Skyline Travels", ...(requestBody as object) }),
      });
    }
```

Then append inside `describe("CasePage")`:

```ts
  it("shows the group name beside the REF and each applicant's REF NO and name", async () => {
    renderCasePage({
      caseRecord: {
        ...buildCase({
          groupName: "Sharma Family",
          applicants: [
            { applicantRef: "A1", travellerId: "trv_1", refNo: "RGS-2026-0912", custody: "WITH_RGS", outcome: "PENDING" },
            { applicantRef: "A2", travellerId: "trv_2", custody: "WITH_RGS", outcome: "PENDING" },
          ],
        }),
        travellers: { trv_1: { fullName: "Rahul Sharma" } },
      },
    });

    await screen.findByRole("heading", { name: "RGS-1001" });
    expect(screen.getByText("Sharma Family")).toBeInTheDocument();

    const applicantRows = screen.getAllByTestId("case-applicant-row");
    expect(within(applicantRows[0]!).getByText("RGS-2026-0912")).toBeInTheDocument();
    expect(within(applicantRows[0]!).getByText("Rahul Sharma")).toBeInTheDocument();
    // No refNo on a multi-applicant case falls back to the internal ref; no
    // traveller in the map falls back to the shared placeholder.
    expect(within(applicantRows[1]!).getByText("A2")).toBeInTheDocument();
    expect(within(applicantRows[1]!).getByText("Unnamed applicant")).toBeInTheDocument();
  });

  it("saves the client email on blur through PUT /cases/{caseId} and clears it with null", async () => {
    const { requestLog } = renderCasePage({ caseRecord: buildCase({ clientEmail: "old@example.com" }) });
    const clientEmailInput = await screen.findByLabelText("Client email");
    expect(clientEmailInput).toHaveValue("old@example.com");

    fireEvent.change(clientEmailInput, { target: { value: " priya@example.com " } });
    fireEvent.blur(clientEmailInput);
    await waitFor(() =>
      expect(
        requestLog.find((request) => request.method === "PUT" && request.url.endsWith("/cases/case_1")),
      ).toMatchObject({ body: { clientEmail: "priya@example.com" } }),
    );

    fireEvent.change(clientEmailInput, { target: { value: "" } });
    fireEvent.blur(clientEmailInput);
    await waitFor(() =>
      expect(
        requestLog.filter((request) => request.method === "PUT" && request.url.endsWith("/cases/case_1")).at(-1),
      ).toMatchObject({ body: { clientEmail: null } }),
    );
  });

  it("does not write when the client email is unchanged on blur", async () => {
    const { requestLog } = renderCasePage({ caseRecord: buildCase({ clientEmail: "old@example.com" }) });
    const clientEmailInput = await screen.findByLabelText("Client email");

    fireEvent.blur(clientEmailInput);

    expect(requestLog.filter((request) => request.method === "PUT")).toHaveLength(0);
  });

  it("saves the vendor email through PUT /partners/{partnerId}/contact", async () => {
    const { requestLog } = renderCasePage();
    const vendorEmailInput = await screen.findByLabelText("Vendor email");
    expect(vendorEmailInput).toHaveValue("desk@skyline.test");

    fireEvent.change(vendorEmailInput, { target: { value: "ops@skyline.test" } });
    fireEvent.keyDown(vendorEmailInput, { key: "Enter" });

    await waitFor(() =>
      expect(
        requestLog.find((request) => request.method === "PUT" && request.url.endsWith("/partners/partner_1/contact")),
      ).toMatchObject({ body: { contactEmail: "ops@skyline.test" } }),
    );
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/CasePage.test.tsx`
Expected: FAIL. No "Client email" label, no group name, no names in the applicant rows.

- [ ] **Step 3: Add the inline email control**

In `CasePage.tsx`, add after `AppointmentDateControl`:

```tsx
/**
 * One email address, committed when the human confirms it: the
 * `AppointmentDateControl` contract (blur or Enter commits, Escape reverts,
 * an unchanged draft is not a write). Unlike the date, an EMPTY draft IS a
 * write: it is how the desk clears an address, and `onCommit` receives
 * `null` for it so the caller sends `null`, never `""`, which the server
 * would reject as a malformed address.
 */
function InlineEmailControl({
  label,
  storedValue,
  onCommit,
}: {
  label: string;
  storedValue: string | undefined;
  onCommit: (confirmedValue: string | null) => void;
}) {
  const [draftValue, setDraftValue] = useState(storedValue ?? "");
  const [lastSeenStoredValue, setLastSeenStoredValue] = useState(storedValue);
  if (storedValue !== lastSeenStoredValue) {
    setLastSeenStoredValue(storedValue);
    setDraftValue(storedValue ?? "");
  }

  function commitDraft() {
    const trimmedDraft = draftValue.trim();
    if (trimmedDraft === (storedValue ?? "")) return;
    onCommit(trimmedDraft === "" ? null : trimmedDraft);
  }

  return (
    <input
      type="email"
      aria-label={label}
      value={draftValue}
      placeholder="Add an address"
      onChange={(changeEvent) => setDraftValue(changeEvent.target.value)}
      onBlur={commitDraft}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === "Enter") {
          keyboardEvent.preventDefault();
          commitDraft();
        } else if (keyboardEvent.key === "Escape") {
          keyboardEvent.preventDefault();
          setDraftValue(storedValue ?? "");
        }
      }}
      className={CONTROL_CLASS}
    />
  );
}
```

- [ ] **Step 4: Wire the two mutations in `CaseScreen` and pass them to the header**

Add imports at the top of `CasePage.tsx`: `useMutation, useQueryClient` from `@tanstack/react-query`; `crmQueryKeys` from `../api/hooks` (extend the existing `useCase, useCaseEvents, usePartners` import); `type CaseView` from `../api/crmClient` (extend the existing `crmClient` import).

Inside `CaseScreen`, after the `useApplicantEdit()` call:

```ts
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const clientEmailMutation = useMutation({
    mutationFn: (clientEmail: string | null) => crmClient.updateCaseDetails(idToken!, caseId, { clientEmail }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseId) }),
  });
  const vendorEmailMutation = useMutation({
    mutationFn: (input: { partnerId: string; contactEmail: string | null }) =>
      crmClient.updatePartnerContact(idToken!, input.partnerId, { contactEmail: input.contactEmail }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: crmQueryKeys.partners() }),
  });
```

(`useAuth` is already imported.) Pass two new props to `<CaseHeader>`:

```tsx
              onCommitClientEmail={(clientEmail) => clientEmailMutation.mutate(clientEmail)}
              onCommitVendorEmail={(contactEmail) =>
                vendorEmailMutation.mutate({ partnerId: caseRecord.partnerId, contactEmail })
              }
```

and pass `travellers={caseRecord.travellers}` to `<ApplicantsTable>`. Type `caseRecord` as `CaseView | undefined` (it already is, via `useCase`'s inferred return type after Task 6).

- [ ] **Step 5: Render in `CaseHeader`**

Add props `onCommitClientEmail: (clientEmail: string | null) => void` and `onCommitVendorEmail: (contactEmail: string | null) => void`. In the title row, after the `<h1>`:

```tsx
        {caseRecord.groupName !== undefined && (
          <span className="text-base font-semibold text-ink-soft">{caseRecord.groupName}</span>
        )}
```

Replace the Partner field's email line with the control and add a Client email field after it:

```tsx
        <CaseField fieldKey="partner" label="Partner">
          <span className="flex flex-col gap-1">
            <span>{partnerName}</span>
            <InlineEmailControl label="Vendor email" storedValue={partnerContactEmail} onCommit={onCommitVendorEmail} />
          </span>
        </CaseField>
        <CaseField fieldKey="clientEmail" label="Client email">
          <InlineEmailControl label="Client email" storedValue={caseRecord.clientEmail} onCommit={onCommitClientEmail} />
        </CaseField>
```

Check the existing CasePage tests that assert the partner field text (`case-field-partner`): the partner name is still rendered, the email now lives in an input's value rather than a text node. Update any assertion that used `getByText("desk@skyline.test")` to `getByLabelText("Vendor email")` + `toHaveValue`.

- [ ] **Step 6: Render names and REF NOs in `ApplicantsTable`**

Add a `travellers?: crm.CaseTravellerMap` prop. Replace the R45 doc comment above the component with:

```tsx
/**
 * Names arrive on the single-case read (`CaseView.travellers`, spec
 * 2026-09-25 D7), which lifts the old R45 ruling on evidence. A traveller the
 * server could not resolve shows the shared "Unnamed applicant" placeholder;
 * a mutation response without the map falls back the same way until the
 * refetch lands.
 */
```

Change the header row to:

```tsx
              <th className="px-4 py-2.5 font-medium">REF NO</th>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Passport</th>
              <th className="px-4 py-2.5 font-medium">Custody</th>
              <th className="px-4 py-2.5 font-medium">Outcome</th>
              <th className="px-4 py-2.5 font-medium">Courier</th>
```

and the first cell to two cells:

```tsx
                <td className="mrz px-4 py-2.5 text-xs font-semibold text-ink">
                  {crm.displayApplicantRef(caseRecord.caseRef, caseRecord.applicants.length, applicant)}
                </td>
                <td className="px-4 py-2.5 font-medium text-ink">{crm.displayApplicantName(travellers, applicant)}</td>
```

The `ApplicantAxisControl` accessible names still carry `applicantRef` ("Custody for applicant A2"); leave them, existing tests depend on them.

- [ ] **Step 7: Run to verify they pass**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/CasePage.test.tsx test/crm/applicantMutations.test.tsx test/crm/LedgerEditingIntegration.test.tsx && pnpm --filter ./apps/admin typecheck`
Expected: PASS. If an older CasePage test asserted the partner email as text, it was updated in Step 5.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/crm/case/CasePage.tsx apps/admin/test/crm/CasePage.test.tsx
git commit -m "feat(admin): case page shows group name, applicant names and REF NOs, edits client and vendor email inline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Ledger REF cell shows the group name; sub-rows show the REF NO

**Files:**
- Modify: `apps/admin/src/crm/ledger/columns.tsx:63-96` (REF column render)
- Modify: `apps/admin/src/crm/ledger/ApplicantSubRows.tsx` (line rendering and the R45 comment)
- Test: `apps/admin/test/crm/ApplicantSubRows.test.tsx`, `apps/admin/test/crm/columns.test.tsx` (new)

**Interfaces:**
- Consumes: `crm.LedgerRow.groupName`, `crm.displayApplicantRef`, `LedgerCellContext` (`{ reviewEntry?: OpenReviewSummaryEntry; isFocusedRow: boolean }`).

- [ ] **Step 1: Write the failing tests**

Create `apps/admin/test/crm/columns.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { LEDGER_COLUMNS } from "../../src/crm/ledger/columns";

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_1",
    caseRef: "RGS-2026-0912",
    partnerId: "partner_1",
    destinationCountry: "FR",
    caseType: "VISA",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-09-20",
    totalInr: 0,
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const refColumn = LEDGER_COLUMNS.find((column) => column.key === "caseRef")!;

describe("REF column", () => {
  it("renders the group name as a second line under the REF", () => {
    render(
      <MemoryRouter>{refColumn.render(buildRow({ groupName: "Sharma Family" }), "Skyline Travels", { isFocusedRow: false })}</MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "RGS-2026-0912" })).toBeInTheDocument();
    expect(screen.getByText("Sharma Family")).toBeInTheDocument();
  });

  it("renders no second line when the case has no group name", () => {
    const { container } = render(
      <MemoryRouter>{refColumn.render(buildRow(), "Skyline Travels", { isFocusedRow: false })}</MemoryRouter>,
    );
    expect(container.querySelector("[data-testid='ledger-group-name']")).toBeNull();
  });
});
```

Append to `apps/admin/test/crm/ApplicantSubRows.test.tsx` (the file has `stubLoadedCase`, `buildApplicant`, `buildCase`):

```tsx
  it("shows each applicant's own REF NO when set, and the case REF for a lone applicant without one", () => {
    stubLoadedCase([
      buildApplicant({ applicantRef: "A1", refNo: "RGS-2026-0912" }),
      buildApplicant({ applicantRef: "A2", travellerId: "traveller_2", refNo: "RGS-2026-0913" }),
    ]);
    render(<ApplicantSubRows caseId="case_1" />);
    const groupRows = screen.getAllByTestId("applicant-subrow");
    expect(within(groupRows[0]!).getByText("RGS-2026-0912")).toBeInTheDocument();
    expect(within(groupRows[1]!).getByText("RGS-2026-0913")).toBeInTheDocument();
    expect(screen.queryByText("A1")).not.toBeInTheDocument();
  });

  it("shows the case REF, not the internal '1', for an imported single-applicant case", () => {
    stubLoadedCase([buildApplicant({ applicantRef: "1" })]);
    render(<ApplicantSubRows caseId="case_1" />);
    expect(within(screen.getByTestId("applicant-subrow")).getByText("RGS-1001")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });
```

Also update the existing "lists each applicant's ref" test: with two applicants and no `refNo`, the display rule still shows `A1` / `A2`, so its assertions hold; only its R45 comment is stale. Replace that comment with `// Two applicants, no refNo: the display rule falls back to applicantRef.`

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/columns.test.tsx test/crm/ApplicantSubRows.test.tsx`
Expected: FAIL. No group-name line; the lone-applicant row shows "1".

- [ ] **Step 3: Implement**

In `columns.tsx`, the REF column `render` becomes:

```tsx
    render: (row, _partnerName, cellContext) => (
      <>
        <span className="flex flex-col leading-tight">
          <Link
            to={`/crm/cases/${row.caseId}`}
            tabIndex={-1}
            className="mrz text-xs font-semibold text-rgs-red-deep hover:underline"
          >
            {row.caseRef}
          </Link>
          {row.groupName !== undefined && (
            <span data-testid="ledger-group-name" className="truncate text-[10px] text-ink-soft">
              {row.groupName}
            </span>
          )}
        </span>
        <ReviewMarker
          caseRef={row.caseRef}
          entry={cellContext.reviewEntry}
          isFocusedRow={cellContext.isFocusedRow}
        />
      </>
    ),
```

In `ApplicantSubRows.tsx`, replace the R45 paragraph of the component doc comment with:

```ts
 * The first token is the applicant's display reference (spec 2026-09-25
 * §3.2, `crm.displayApplicantRef`): their own REF NO when set, the case REF
 * for a lone applicant, otherwise the internal `applicantRef`. Still no
 * traveller name here: the ledger row has no traveller map and the case
 * screen is one click away.
```

and change the first `<span>` in the list item to:

```tsx
            <span className="mrz font-medium">
              {crm.displayApplicantRef(loadedCase.caseRef, loadedApplicants.length, applicant)}
            </span>
```

where `loadedCase` is `caseQuery.data` (guarded non-undefined by the `loadedApplicants.length === 0` early return; read `const loadedCase = caseQuery.data!;` after that guard).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/columns.test.tsx test/crm/ApplicantSubRows.test.tsx test/crm/LedgerTable.test.tsx test/crm/ReviewMarker.test.tsx`
Expected: PASS apart from the pre-existing "renders the spec's columns" count failure in `LedgerTable.test.tsx`, which is unchanged by this task.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/crm/ledger/columns.tsx apps/admin/src/crm/ledger/ApplicantSubRows.tsx apps/admin/test/crm/columns.test.tsx apps/admin/test/crm/ApplicantSubRows.test.tsx
git commit -m "feat(admin): ledger REF cell shows the group name; applicant sub-rows show the REF NO

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Timeline copy for CLIENT_NOTIFIED

**Files:**
- Modify: `apps/admin/src/crm/case/eventCopy.ts` (table comment near line 48; `switch` near line 266)
- Test: `apps/admin/test/crm/Timeline.test.tsx`

**Interfaces:**
- Consumes: Task 6's `CrmEventType` including `"CLIENT_NOTIFIED"`.

- [ ] **Step 1: Write the failing test**

Append to `apps/admin/test/crm/Timeline.test.tsx` inside `describe("Timeline")`:

```tsx
  it("reads a CLIENT_NOTIFIED event as the client being emailed, with the transition", () => {
    render(
      <Timeline
        events={[
          { eventId: "e1", eventType: "CLIENT_NOTIFIED", caseId: "case_1", actorEmail: "ops@rgs.test", meta: { channel: "email", toAddress: "priya@example.com", fromStatus: "NEW", toStatus: "IN_PROGRESS" }, createdAt: "2026-03-04T10:00:00.000Z" },
        ]}
      />,
    );

    expect(screen.getByText("Client notified by ops@rgs.test")).toBeInTheDocument();
    expect(screen.getByText(/Email to priya@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/New/)).toBeInTheDocument();
    expect(screen.getByText(/In progress/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/Timeline.test.tsx`
Expected: FAIL; the unknown-type fallback text renders instead of "Client notified by".

- [ ] **Step 3: Add the copy**

In `eventCopy.ts`, add a row to the table comment after `PARTNER_NOTIFIED`:

```
 * | CLIENT_NOTIFIED           | channel, toAddress, fromStatus, toStatus            | statusNotify.ts          |
```

and update the `PARTNER_NOTIFIED` row's file name to `statusNotify.ts`. Add a case after `PARTNER_NOTIFIED`:

```ts
    case "CLIENT_NOTIFIED":
      return {
        title: `Client notified by ${actorEmail}`,
        detail: `Email to ${readMetaString(meta, "toAddress") ?? "unknown"} · ${describeTransition(
          meta,
          "fromStatus",
          "toStatus",
          CASE_STATUS_LABELS,
        )}`,
        isAutoApplied: false,
      };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ./apps/admin exec vitest run test/crm/Timeline.test.tsx && pnpm --filter ./apps/admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/crm/case/eventCopy.ts apps/admin/test/crm/Timeline.test.tsx
git commit -m "feat(admin): timeline copy for CLIENT_NOTIFIED

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Whole-workspace verification and spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-crm-family-groups-client-email-design.md` (status line)

- [ ] **Step 1: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck passes in every package. Test failures are limited to the two pre-existing ones named in Global Constraints. Record the exact counts per package in the commit message.

- [ ] **Step 2: Mark the spec implemented**

Change the spec's `Status:` line to `Status: implemented on branch crm-family-groups (2026-09-25)`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-25-crm-family-groups-client-email-design.md
git commit -m "docs: mark family groups / client email spec implemented

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Merge and deployment are a separate decision for the owner (see `superpowers:finishing-a-development-branch`). Prod lambdas do not yet carry `SES_CONFIGURATION_SET` (memory `rgs-crm-feedback-round-1`); that is unrelated to this branch but worth raising at deploy time.
