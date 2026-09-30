# Unified country documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `CountryProduct.requiredDocuments` list (`label` + optional `portalDocType`) edited in Config, stamped onto New cases, shown on marketing, and driving portal upload slots — deleting the live CRM Doc checklists split.

**Architecture:** Change the shared country product schema; migrate Dynamo products from `docsRequired` + optional CRM checklist rows into `requiredDocuments`; point create-case / ensure-checklist / public catalog / portal / marketing at that field; replace Config DocType checkboxes with a chip+dropdown editor; remove Doc checklists nav, page, and live checklist HTTP.

**Tech Stack:** TypeScript, pnpm workspaces, Zod, Vitest, Testing Library, React admin/portal, Next marketing, Dynamo via existing config + CRM table helpers, Tailwind admin tokens.

**Spec:** `docs/superpowers/specs/2026-09-30-unified-country-documents-design.md`

## Global Constraints

- Spec decisions D1–D6 are closed; do not reopen.
- Descriptive names only (no `e`/`x`/`res`/`tmp` outside trivial indexes).
- Match file comment density and named-field construction of the code you edit.
- Staging migrate + deploy when asked; do not push or deploy prod unless asked.
- Conventional commits; one commit per task after that task’s tests pass.
- Prefer a feature branch / worktree (e.g. `.worktrees/unified-country-documents`).
- Do not rewrite case document checklist *after* stamp (case-local rows stay).
- Do not require deleting orphan CRM checklist Dynamo rows in this plan.

## Review Focus

1. **Legacy Dynamo rows with only `docsRequired`** — list/upsert still works until migrate runs (pinned Task 1 + Task 2).
2. **Create case with no matching country product** — stamps empty checklist, does not throw (pinned Task 4).
3. **Two products same `countryCode`** — stamp/marketing labels come from a defined merge (union by label, FULFILLED-active first) (pinned Task 4).
4. **Duplicate `portalDocType` on two rows** — upsert rejected (pinned Task 1).
5. **Portal Docs step** — only rows with `portalDocType` become upload slots (pinned Task 8).
6. **Doc checklists nav gone** — Viewer/Owner sidebar tests updated; route 404 or removed (pinned Task 7).

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/countryProducts.ts` | `RequiredDocument` type, schema, seeds, helpers |
| `packages/shared/src/docTypeLabels.ts` | Keep labels; add `docTypeForLabel` (case-insensitive) |
| `packages/shared/src/index.ts` | Re-export new types/helpers if needed |
| `services/migration/src/migrateCountryDocumentsToProducts.ts` (+ cli) | One-shot fold checklists + docsRequired → products |
| `services/api/src/domain/config.ts` | Persist/read `requiredDocuments`; drop CRM label merge |
| `services/api/src/domain/crm/cases.ts` | Stamp from product labels |
| `services/api/src/domain/crm/caseDocumentChecklist.ts` | `ensureCaseDocumentChecklist` from product |
| `services/api/src/http/crmApi.ts` | Remove country-checklists routes |
| `apps/admin/src/pages/ConfigPage.tsx` | Document list editor |
| `apps/admin/src/lib/configCsv.ts` | Import/export new column |
| `apps/admin/src/lib/navLinks.ts` / `main.tsx` | Drop Doc checklists |
| `apps/admin/src/crm/newCase/NewCaseDrawer.tsx` | Preview from config countries |
| `apps/marketing/src/lib/documentLabels.ts` | Labels from `requiredDocuments` |
| `apps/portal/src/pages/wizard/steps/DocsStep.tsx` | Slots from `portalDocType` |

---

### Task 1: Shared `requiredDocuments` schema + helpers

**Files:**
- Modify: `packages/shared/src/countryProducts.ts`
- Modify: `packages/shared/src/docTypeLabels.ts`
- Modify: `packages/shared/src/index.ts` (if exports are explicit)
- Test: `packages/shared/test/countryProducts.test.ts` (create if missing) or extend nearest shared country-product test

**Interfaces:**
- Produces:
  ```ts
  export interface RequiredDocument {
    label: string;
    portalDocType?: DocType;
  }
  // on CountryProduct: requiredDocuments: readonly RequiredDocument[];
  // docsRequired and requiredDocumentLabels removed from the type
  export function documentLabelsFromProduct(product: CountryProduct): string[];
  export function portalDocTypesFromProduct(product: CountryProduct): DocType[];
  export function requiredDocumentsFromLegacyDocTypes(docTypes: readonly DocType[]): RequiredDocument[];
  export function docTypeForLabel(label: string): DocType | undefined; // in docTypeLabels.ts
  ```

- [ ] **Step 1: Failing tests for schema + helpers**

```ts
import { describe, expect, it } from "vitest";
import {
  CountryProductSchema,
  requiredDocumentsFromLegacyDocTypes,
  documentLabelsFromProduct,
} from "../src/countryProducts";
import { docTypeForLabel, DOC_TYPE_LABELS } from "../src/docTypeLabels";

it("accepts requiredDocuments and rejects duplicate portalDocType", () => {
  const base = {
    countryCode: "AE",
    productCode: "AE_TOURIST",
    countryName: "UAE",
    visaType: "E_VISA",
    region: "MIDDLE_EAST",
    tier: "FULFILLED",
    validityDays: 30,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 0,
    serviceFeeInr: 0,
    processingDays: 3,
    active: true,
  };
  expect(
    CountryProductSchema.safeParse({
      ...base,
      requiredDocuments: [
        { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
        { label: "Photo", portalDocType: "PASSPORT_BIO" },
      ],
    }).success,
  ).toBe(false);
});

it("maps DOC_TYPE_LABELS back to DocType case-insensitively", () => {
  expect(docTypeForLabel("passport bio page")).toBe("PASSPORT_BIO");
  expect(docTypeForLabel("not a type")).toBeUndefined();
});

it("builds requiredDocuments from legacy DocTypes", () => {
  expect(requiredDocumentsFromLegacyDocTypes(["PASSPORT_BIO", "PHOTO"])).toEqual([
    { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
    { label: DOC_TYPE_LABELS.PHOTO, portalDocType: "PHOTO" },
  ]);
});
```

- [ ] **Step 2: Run — FAIL** (types/schema still on `docsRequired`)

Run: `cd packages/shared && pnpm exec vitest run test/countryProducts.test.ts`  
Expected: FAIL (missing exports / schema path)

- [ ] **Step 3: Implement schema + helpers**

In `countryProducts.ts`:

```ts
export interface RequiredDocument {
  label: string;
  portalDocType?: DocType;
}

export const RequiredDocumentSchema = z.object({
  label: z.string().trim().min(1),
  portalDocType: z.enum(DOC_TYPES).optional(),
});

// CountryProduct.requiredDocuments: readonly RequiredDocument[]
// Remove docsRequired and requiredDocumentLabels from interface + Zod object

// After object, refine:
// 1) FULFILLED => requiredDocuments.length > 0
// 2) unique normalized labels
// 3) unique portalDocType among rows that set it
```

Update every seed entry: replace `docsRequired: [...]` with  
`requiredDocuments: requiredDocumentsFromLegacyDocTypes([...])`.

Update `getDocsChecklist` → `portalDocTypesFromProduct` or change return to portal types from `requiredDocuments`.

In `docTypeLabels.ts`:

```ts
export function docTypeForLabel(label: string): DocType | undefined {
  const normalized = label.trim().toLowerCase();
  for (const docType of DOC_TYPES) {
    if (DOC_TYPE_LABELS[docType].toLowerCase() === normalized) return docType;
  }
  return undefined;
}
```

- [ ] **Step 4: Run shared tests — PASS** (fix any other shared tests that reference `docsRequired`)

Run: `cd packages/shared && pnpm test`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(shared): CountryProduct.requiredDocuments replaces docsRequired

EOF
)"
```

---

### Task 2: Migration — fold checklists into products

**Files:**
- Create: `services/migration/src/migrateCountryDocumentsToProducts.ts`
- Create: `services/migration/src/migrateCountryDocumentsToProductsCli.ts`
- Create: `services/migration/src/runMigrateCountryDocumentsToProductsCli.ts`
- Modify: `services/migration/package.json` (script)
- Test: `services/migration/test/migrateCountryDocumentsToProducts.test.ts`

**Interfaces:**
- Consumes: `listCountryConfig`, `upsertCountryProduct` (or table put via existing config domain), `findCountryChecklist` / `listCountryChecklists`, `requiredDocumentsFromLegacyDocTypes`, `docTypeForLabel`
- Produces:
  ```ts
  export interface MigrateCountryDocumentsReport {
    productsUpdated: number;
    productsSkippedAlreadyMigrated: number;
    checklistLabelsMerged: number;
  }
  export async function migrateCountryDocumentsToProducts(
    context: AppContext,
    tenantId: string,
    actorEmail: string,
  ): Promise<MigrateCountryDocumentsReport>;
  ```

Merge rules (spec §6):

1. Baseline = `requiredDocumentsFromLegacyDocTypes(product.docsRequired)` if raw still has `docsRequired`, else existing `requiredDocuments` if already present.
2. If checklist for `countryCode` has labels: **checklist order wins**; map each label via `docTypeForLabel`; dedupe by normalized label.
3. Write product with `requiredDocuments`; do not write `docsRequired`.
4. Idempotent: if product already has `requiredDocuments.length > 0` and no legacy `docsRequired` in storage, skip (or re-merge only when a flag is set — default skip).

For reading legacy rows before schema-only code ships: migration should read **raw Dynamo items** (or a temporary parse that accepts either shape). Prefer a small `parseCountryProductForMigration(raw)` in the migration module that accepts `{ docsRequired?: DocType[], requiredDocuments?: RequiredDocument[] }`.

- [ ] **Step 1: Failing tests**

```ts
it("prefers checklist order and maps known labels to portalDocType", async () => {
  // seed product AE with docsRequired PASSPORT_BIO,PHOTO via legacy put
  // put checklist AE: ["Custom letter", "Passport bio page"]
  const report = await migrateCountryDocumentsToProducts(context, TENANT, "migration@…");
  const ae = (await listCountryConfig(context)).countryProducts.find((p) => p.countryCode === "AE");
  expect(ae?.requiredDocuments).toEqual([
    { label: "Custom letter" },
    { label: DOC_TYPE_LABELS.PASSPORT_BIO, portalDocType: "PASSPORT_BIO" },
  ]);
});

it("docsRequired-only countries become labeled rows with portalDocType", async () => {
  // no checklist
  // expect requiredDocumentsFromLegacyDocTypes(seed)
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd services/migration && pnpm exec vitest run test/migrateCountryDocumentsToProducts.test.ts`

- [ ] **Step 3: Implement migrate + CLI** (mirror `seedCountryChecklistsFromConfigCli` wiring)

`package.json` script:

```json
"migrate:country-documents-to-products": "tsx src/migrateCountryDocumentsToProductsCli.ts"
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(migration): fold country checklists into CountryProduct.requiredDocuments

EOF
)"
```

---

### Task 3: API config read/write without CRM merge

**Files:**
- Modify: `services/api/src/domain/config.ts`
- Modify: `services/api/test/crm/catalogChecklistMerge.test.ts` → rename/repurpose to `countryDocumentsCatalog.test.ts` (or rewrite in place)
- Fix any admin config API tests that send `docsRequired`

**Interfaces:**
- Consumes: `CountryProductSchema` with `requiredDocuments`
- Produces: `listActiveCountryConfig` returns products as stored (labels already on product); **no** `withCrmChecklistLabels`

- [ ] **Step 1: Rewrite catalog tests**

```ts
it("returns requiredDocuments labels from the product with no CRM merge", async () => {
  await upsertCountryProduct(context, adminId, adminEmail, {
    ...aeSeed,
    requiredDocuments: [{ label: "Emirates ID copy" }, { label: "Photo", portalDocType: "PHOTO" }],
  });
  const listing = await listActiveCountryConfig(context);
  const ae = listing.countryProducts.find((p) => p.countryCode === "AE");
  expect(ae?.requiredDocuments?.map((d) => d.label)).toEqual(["Emirates ID copy", "Photo"]);
  expect(ae).not.toHaveProperty("requiredDocumentLabels");
});

it("coerces a legacy docsRequired-only row on read until migrate runs", async () => {
  // put raw item with docsRequired only (bypass schema if needed)
  const listing = await listCountryConfig(context);
  // expect requiredDocuments filled via coerceLegacyCountryProduct
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

- Remove `withCrmChecklistLabels` and `findCountryChecklist` import from `config.ts`.
- On list: map each raw item through `coerceLegacyCountryProduct` then `CountryProductSchema.parse`.
- On upsert: strip any client-sent `docsRequired` / `requiredDocumentLabels`; persist `requiredDocuments` only.

```ts
export function coerceLegacyCountryProduct(raw: Record<string, unknown>): unknown {
  if (Array.isArray(raw.requiredDocuments) && raw.requiredDocuments.length > 0) {
    const { docsRequired: _drop, requiredDocumentLabels: _labels, ...rest } = raw;
    return rest;
  }
  if (Array.isArray(raw.docsRequired)) {
    const { docsRequired, requiredDocumentLabels: _labels, ...rest } = raw;
    return {
      ...rest,
      requiredDocuments: requiredDocumentsFromLegacyDocTypes(docsRequired as DocType[]),
    };
  }
  return { ...raw, requiredDocuments: raw.requiredDocuments ?? [] };
}
```

- [ ] **Step 4: API config/catalog tests PASS**

Run: `cd services/api && pnpm exec vitest run test/crm/catalogChecklistMerge.test.ts test/domain/config` (adjust paths to what exists)

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): persist country requiredDocuments; drop CRM catalog merge

EOF
)"
```

---

### Task 4: Create case + ensure checklist stamp from product

**Files:**
- Modify: `services/api/src/domain/crm/cases.ts`
- Modify: `services/api/src/domain/crm/caseDocumentChecklist.ts`
- Create helper (prefer next to config or cases):  
  `services/api/src/domain/crm/destinationRequiredDocuments.ts`
- Test: extend `services/api/test/crm/crmApi.test.ts` / case document checklist tests

**Interfaces:**
- Produces:
  ```ts
  /** Labels to stamp for a destination ISO country. Empty if no product rows. */
  export async function labelsForDestinationCountry(
    context: AppContext,
    countryCode: string,
  ): Promise<string[]>;
  ```

Merge when multiple products share a code: collect active products for that code (all if none active); sort FULFILLED before INFO_ONLY; append labels in order, skip duplicate normalized labels.

- [ ] **Step 1: Failing tests**

```ts
it("stamps create-case checklist from CountryProduct.requiredDocuments labels", async () => {
  await upsertCountryProduct(..., {
    countryCode: "AE",
    requiredDocuments: [
      { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
      { label: "Office form only" },
    ],
  });
  // create case destination AE
  expect(created.documentChecklist.map((row) => row.label)).toEqual([
    "Passport bio page",
    "Office form only",
  ]);
});

it("stamps empty checklist when no country product exists", async () => {
  // create case destination ZZ (no product)
  expect(created.documentChecklist).toEqual([]);
});
```

- [ ] **Step 2: Run — FAIL** (still uses `findCountryChecklist`)

- [ ] **Step 3: Implement**

```ts
// cases.ts createCase:
const documentChecklist = stampDocumentChecklistFromCountry(
  await labelsForDestinationCountry(context, input.destinationCountry),
);

// ensureCaseDocumentChecklist: same labels helper; no findCountryChecklist
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): stamp case document checklist from CountryProduct

EOF
)"
```

---

### Task 5: Remove live CRM country-checklist HTTP + admin client

**Files:**
- Modify: `services/api/src/http/crmApi.ts` (remove GET/PUT country-checklists routes)
- Modify: `services/api/test/crm/crmApi.test.ts` (drop or rewrite those cases)
- Modify: `apps/admin/src/crm/api/crmClient.ts` (remove checklist methods)
- Keep domain `countryChecklist.ts` for migration reads only; add file comment “legacy; not served over HTTP”

- [ ] **Step 1: Failing test** — assert routes gone

```ts
it("does not register country-checklists admin routes", async () => {
  const response = await invokeAdmin(app, "GET", "/api/v1/admin/crm/country-checklists");
  expect(response.statusCode).toBe(404);
});
```

(Use the suite’s existing HTTP harness patterns.)

- [ ] **Step 2: Run — FAIL** (still 200)

- [ ] **Step 3: Remove routes + client methods; update tests**

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(api): stop serving CRM country-checklists HTTP

EOF
)"
```

---

### Task 6: Config UI editor + CSV

**Files:**
- Modify: `apps/admin/src/pages/ConfigPage.tsx`
- Modify: `apps/admin/src/lib/configCsv.ts`
- Test: `apps/admin/test/ConfigPage.test.tsx` (create/extend)
- Test: `apps/admin/test/configCsv.test.ts` (extend)

**Interfaces:**
- Consumes: `RequiredDocument`, `DOC_TYPES`, `DOC_TYPE_LABELS`
- CSV column `requiredDocuments`:  
  `Label|DOC_TYPE;Label2` — DocType optional after `|`.  
  Import: if cell looks like old `PASSPORT_BIO|PHOTO` (every segment is a DocType enum), coerce via `requiredDocumentsFromLegacyDocTypes`.

- [ ] **Step 1: Failing UI + CSV tests**

```tsx
it("lets an admin add a document label and optional portal DocType", async () => {
  // open edit drawer for AE
  await user.type(screen.getByLabelText("Document label"), "Office form");
  await user.click(screen.getByRole("button", { name: "Add document" }));
  expect(screen.getByText("Office form")).toBeInTheDocument();
});
```

```ts
it("round-trips requiredDocuments through CSV", () => {
  const csv = countryProductsToCsv([{
    ...ae,
    requiredDocuments: [
      { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
      { label: "Custom" },
    ],
  }]);
  const parsed = parseConfigCsv(csv);
  expect(parsed[0]?.requiredDocuments).toEqual([
    { label: "Passport bio page", portalDocType: "PASSPORT_BIO" },
    { label: "Custom" },
  ]);
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Replace DocType checkbox grid with list editor**

- Label input `aria-label="Document label"`
- Add button `Add document`
- Each row: label text, `<select aria-label="Portal upload for {label}">` with `—` + DOC_TYPES, remove, move up/down
- Save still calls existing upsert with `requiredDocuments`

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): edit country requiredDocuments in Config

EOF
)"
```

---

### Task 7: Remove Doc checklists page; New case reads Config

**Files:**
- Modify: `apps/admin/src/lib/navLinks.ts`
- Modify: `apps/admin/src/main.tsx`
- Delete or gut: `apps/admin/src/crm/countryChecklists/CountryChecklistsPage.tsx`
- Delete/update: `apps/admin/test/crm/CountryChecklistsPage.test.tsx`
- Modify: `apps/admin/src/crm/newCase/NewCaseDrawer.tsx`
- Modify: `apps/admin/test/AdminShell.test.tsx`, `NewCaseDrawer.test.tsx`

**Interfaces:**
- New case preview: `adminApi.listCountries(idToken)` → find products for `destinationCountry` → `documentLabelsFromProduct` merge (same helper rules as API, or call a tiny shared `labelsForCountryProducts(products)` in shared).

- [ ] **Step 1: Failing tests**

```tsx
expect(screen.queryByRole("link", { name: "Doc checklists" })).not.toBeInTheDocument();
// New case empty copy:
expect(await screen.findByText(/config/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Remove nav + route; wire NewCaseDrawer**

```ts
const countriesQuery = useQuery({
  queryKey: ["admin-config-countries"],
  queryFn: () => adminApi.listCountries(idToken!),
  enabled: idToken !== null && destinationCountry !== "",
});
const previewLabels = labelsForCountryCode(countriesQuery.data ?? [], destinationCountry);
```

Stop calling `crmClient.getCountryChecklist`.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): drop Doc checklists page; New case preview from Config

EOF
)"
```

---

### Task 8: Marketing + portal consumers

**Files:**
- Modify: `apps/marketing/src/lib/documentLabels.ts`
- Modify: `apps/marketing/test/documentLabels.test.ts`
- Modify: `apps/portal/src/pages/wizard/steps/DocsStep.tsx`
- Test: portal docs step test if present; else add focused unit helper in portal `lib/` and test that

**Interfaces:**
- Marketing:
  ```ts
  export function documentLabelsForMarketing(product: CountryProduct): string[] {
    return documentLabelsFromProduct(product);
  }
  ```
- Portal:
  ```ts
  const requiredDocTypes = portalDocTypesFromProduct(countryProduct);
  ```

- [ ] **Step 1: Failing marketing + portal tests**

```ts
expect(
  documentLabelsForMarketing({
    ...base,
    requiredDocuments: [{ label: "Emirates ID copy" }, { label: "Photo", portalDocType: "PHOTO" }],
  }),
).toEqual(["Emirates ID copy", "Photo"]);
```

```ts
expect(portalDocTypesFromProduct(product)).toEqual(["PHOTO"]); // only mapped row
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement; remove `docsRequired` / `requiredDocumentLabels` branches**

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: marketing and portal read CountryProduct.requiredDocuments

EOF
)"
```

---

### Task 9: Spec status + staging runbook smoke

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-unified-country-documents-design.md` — Status → `approved` / `implemented` as appropriate
- Modify: this plan’s smoke checklist below if paths change

- [ ] **Step 1: Run regression slice**

```bash
cd packages/shared && pnpm test
cd services/api && pnpm exec vitest run test/crm/ test/domain/config 2>/dev/null || pnpm exec vitest run test/crm/
cd services/migration && pnpm exec vitest run test/migrateCountryDocumentsToProducts.test.ts
cd apps/admin && pnpm exec vitest run test/ConfigPage.test.tsx test/configCsv.test.ts test/AdminShell.test.tsx test/crm/NewCaseDrawer.test.tsx
cd apps/marketing && pnpm exec vitest run test/documentLabels.test.ts
cd apps/portal && pnpm test  # or the focused docs test file
```

- [ ] **Step 2: Staging migrate (when deploying)**

```bash
cd services/migration && AWS_PROFILE=hireloop pnpm migrate:country-documents-to-products
# then build admin/portal/marketing + cdk deploy RgsPlatform-staging — only when owner asks
```

- [ ] **Step 3: Manual smoke**

1. Config → UAE → edit docs (add free-text, set portal type) → Save  
2. New case → UAE → preview matches  
3. Marketing visa page for UAE → same labels  
4. Portal apply UAE → upload slots only for portal-typed rows  
5. Sidebar has no Doc checklists  

- [ ] **Step 4: Commit doc status**

```bash
git commit -m "$(cat <<'EOF'
docs: mark unified country documents design implemented

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec item | Task |
|-----------|------|
| D1 Config editor; remove Doc checklists | 6, 7 |
| D2 Storage on CountryProduct | 1, 2, 3 |
| D3 `{ label, portalDocType? }` | 1 |
| D4 New case / marketing / portal | 4, 7, 8 |
| D5 Config write permission | 6 (existing Config gate) |
| D6 Staging first | 9 |
| Migration checklist-order merge | 2 |
| CSV | 6 |
| Drop CRM merge + checklist HTTP | 3, 5 |
| Validation duplicates | 1 |
| Review Focus items | 1, 2, 4, 7, 8 |

No TBD placeholders. CSV pipe format specified. Multi-product label merge specified in Task 4.
