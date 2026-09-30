# Admin portal shell redesign + Cases dual-pane + catalog checklist merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one admin sidebar shell for the whole portal, polish Cases (table chrome, dual-pane detail, new-case drawer), surface Doc checklists as a top-level nav item, and make marketing country docs come from CRM country checklists via the live catalog.

**Architecture:** Replace `AdminShell`’s top header with a permission-filtered left rail (nested children under Cases). Reflow `CasePage` into sticky work header + primary/secondary columns without changing mutation contracts. Enrich `GET /api/v1/config/countries` with `requiredDocumentLabels` from CRM `CountryChecklist`, and teach marketing `LiveDocsList` to prefer those labels.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest + Testing Library (admin/marketing), React Router admin app, Next.js marketing, Dynamo via existing `findCountryChecklist` / `listCountryChecklists`, Tailwind + existing CRM control tokens.

**Spec:** `docs/superpowers/specs/2026-09-30-admin-portal-shell-redesign-design.md`

## Global Constraints

- Spec decisions D1–D11 are closed; do not reopen (dual-pane, drawer new-case, Doc checklists top-level, catalog merge A).
- Descriptive names only (no `e`/`x`/`res`/`tmp` outside trivial indexes).
- Match file comment density and named-field construction of the code you edit.
- Prefer layout/chrome changes; do not rewrite CRM write paths, status machine, or AgentPanel contracts.
- Case routes stay under `/crm/...` even when the nav label is **Cases**.
- Doc checklists route stays `/crm/country-checklists` (top-level nav only).
- Deploy target: staging when asked; do not push or deploy prod unless asked.
- Commit: conventional commits, one commit per task after tests pass.
- Work from a feature branch / worktree; prefer `.worktrees/admin-portal-shell-redesign` if using worktrees.

## Review Focus

1. **Viewer still sees Cases + Doc checklists, not Config/Users** — sidebar filters by `canAccess` (pinned Task 1).
2. **Finance landing is still Activity, not Cases** — `landingPath` uses top-level links only (pinned Task 1).
3. **Case dual-pane keeps applicants before context fields** — DOM order / testids prove applicants section appears in primary column (pinned Task 3).
4. **Catalog: CRM checklist labels win over Config `docsRequired`** when a checklist exists (pinned Task 6).
5. **Catalog: missing CRM checklist falls back to DocType labels** so marketing does not go blank (pinned Task 6).
6. **Auth page has no sidebar** — `/auth` unchanged full-bleed (pinned Task 1).

## File map

| File | Responsibility |
|------|----------------|
| `apps/admin/src/lib/navLinks.ts` | Nested nav model; `landingPath` on top-level only; Cases label; Doc checklists top-level |
| `apps/admin/src/components/AdminShell.tsx` | Sidebar + main outlet; drop top black header; no CRM-only mist sheet |
| `apps/admin/test/AdminShell.test.tsx` | Sidebar labels, nesting, role filtering |
| `apps/admin/test/adminAccess.test.tsx` | `landingPath` still Finance → `/activity` |
| `apps/admin/src/crm/CrmLayout.tsx` | Agent rail inside Cases main only; no second global chrome |
| `apps/admin/src/crm/ledger/LedgerPage.tsx` | Cases page header; remove orphan settings link row clutter (nav owns settings) |
| `apps/admin/src/crm/case/CasePage.tsx` | Dual-pane layout (extract presentational sections if file already huge) |
| `apps/admin/test/crm/CasePage.test.tsx` | Dual-pane structure + existing mutation tests still pass |
| `apps/admin/src/crm/statusEmails/StatusEmailsPage.tsx` | Master–detail editor chrome |
| `apps/admin/src/crm/countryChecklists/CountryChecklistsPage.tsx` | Master–detail + chips; drop “Back to ledger” |
| `apps/admin/src/crm/newCase/NewCaseDrawer.tsx` | Keep checklist preview; align copy with Doc checklists nav name |
| `packages/shared/src/countryProducts.ts` (or small companion type) | Optional `requiredDocumentLabels: string[]` on public product |
| `services/api/src/domain/config.ts` | `listActiveCountryConfig` merges CRM checklists → labels |
| `services/api/test/...` (config / countries) | Merge + fallback tests |
| `apps/marketing/src/components/LiveCountryHydration.tsx` | `LiveDocsList` prefers `requiredDocumentLabels` |
| `apps/marketing` test if present, else add focused unit test next to component logic |

---

### Task 1: Nested nav model + sidebar `AdminShell`

**Files:**
- Modify: `apps/admin/src/lib/navLinks.ts`
- Modify: `apps/admin/src/components/AdminShell.tsx`
- Modify: `apps/admin/test/AdminShell.test.tsx`
- Modify: `apps/admin/test/adminAccess.test.tsx` (only if `landingPath` signature/behavior changes)
- Test: `apps/admin/test/AdminShell.test.tsx`

**Interfaces:**
- Consumes: `canAccessScreen` / `useAdminAccess().canAccess`, existing `AdminScreen`
- Produces:
  ```ts
  export interface AdminNavChildLink {
    label: string;
    to: string;
    screen: AdminScreen;
  }
  export interface AdminNavLink {
    label: string;
    to: string;
    screen: AdminScreen;
    children?: readonly AdminNavChildLink[];
  }
  export const ADMIN_NAV_LINKS: readonly AdminNavLink[];
  export function landingPath(role: AdminRole | null): string;
  ```

- [ ] **Step 1: Write the failing tests**

In `AdminShell.test.tsx`, replace expectations that look for link name `"CRM"` with `"Cases"`, and add:

```tsx
it("shows Doc checklists as a top-level link and nests Status emails under Cases", () => {
  renderShell("Owner");

  expect(screen.getByRole("link", { name: "Cases" })).toHaveAttribute("href", "/crm");
  expect(screen.getByRole("link", { name: "Doc checklists" })).toHaveAttribute(
    "href",
    "/crm/country-checklists",
  );
  expect(screen.getByRole("link", { name: "Status emails" })).toHaveAttribute(
    "href",
    "/crm/status-emails",
  );
  expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/crm/review");
  expect(screen.queryByRole("link", { name: "CRM" })).not.toBeInTheDocument();
});

it("hides Cases children when the role cannot access crm", () => {
  // Use a role that has queue but not crm if one exists; otherwise assert Viewer keeps Cases.
  renderShell("Viewer");
  expect(screen.getByRole("link", { name: "Cases" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Doc checklists" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Config" })).not.toBeInTheDocument();
});
```

Keep Finance `landingPath("Finance") === "/activity"` green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/admin && pnpm exec vitest run test/AdminShell.test.tsx test/adminAccess.test.tsx`  
Expected: FAIL — no "Cases" / "Doc checklists" links yet; still "CRM".

- [ ] **Step 3: Implement nav model**

Rewrite `ADMIN_NAV_LINKS` roughly as:

```ts
export const ADMIN_NAV_LINKS: readonly AdminNavLink[] = [
  { label: "Queue", to: "/", screen: "queue" },
  { label: "Leads", to: "/leads", screen: "leads" },
  {
    label: "Cases",
    to: "/crm",
    screen: "crm",
    children: [
      { label: "Review", to: "/crm/review", screen: "crmReview" },
      { label: "Status emails", to: "/crm/status-emails", screen: "crm" },
    ],
  },
  { label: "Doc checklists", to: "/crm/country-checklists", screen: "crm" },
  { label: "Activity", to: "/activity", screen: "activity" },
  { label: "Notices", to: "/notices", screen: "notices" },
  { label: "Config", to: "/config", screen: "config" },
  { label: "Users", to: "/admin/users", screen: "adminUsers" },
] as const;
```

Keep `landingPath` iterating **top-level** `ADMIN_NAV_LINKS` only (ignore children).

- [ ] **Step 4: Implement sidebar shell**

Replace the top `<header className="bg-ink ...">` in `AdminShell` with a flex layout:

- Left `<aside>` (~`w-[220px]`), dark ink, brand mark + “Admin”, nav links (parent then indented children when `canAccess(child.screen)`), email + Sign out at bottom.
- Right `<main className="flex-1 overflow-auto bg-paper ...">` for children.
- Remove CRM-only mist/`rounded-t-2xl` special case for `contentWidth === "wide"` (spec D2). `contentWidth` may remain for max-width capping only, same for all screens.
- Active state: `NavLink` for exact paths; parent **Cases** active for `/crm` and `/crm/cases/:id` (use `end` carefully — Cases parent should stay active on case detail; Status emails only on its path).
- Do **not** wrap `/auth` — AuthPage must not import this shell (already true).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/admin && pnpm exec vitest run test/AdminShell.test.tsx test/adminAccess.test.tsx`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/navLinks.ts apps/admin/src/components/AdminShell.tsx \
  apps/admin/test/AdminShell.test.tsx apps/admin/test/adminAccess.test.tsx
git commit -m "$(cat <<'EOF'
feat(admin): sidebar shell with Cases nav and top-level doc checklists

EOF
)"
```

---

### Task 2: Cases table chrome + drop orphan settings buttons

**Files:**
- Modify: `apps/admin/src/crm/ledger/LedgerPage.tsx`
- Modify: `apps/admin/src/crm/CrmLayout.tsx` (only if needed to sit cleanly in new main)
- Modify: `apps/admin/src/crm/review/ReviewPage.tsx`, `StatusEmailsPage.tsx`, `CountryChecklistsPage.tsx` — remove “Back to the ledger” primary escapes (sidebar replaces them); keep in-page back only where useful on case detail
- Test: `apps/admin/test/crm/LedgerPage.test.tsx` (update link name assertions if any)

**Interfaces:**
- Consumes: Task 1 shell
- Produces: Ledger titled **Cases** with **New case** CTA; no Status emails / Country checklists button row in the ledger header

- [ ] **Step 1: Write / update failing test**

Assert ledger heading is “Cases” (or accessible name) and that header no longer exposes links named “Status emails” / “Country checklists” (those live in the shell):

```tsx
expect(screen.getByRole("heading", { name: /cases/i })).toBeInTheDocument();
expect(screen.queryByRole("link", { name: /status emails/i })).not.toBeInTheDocument();
expect(screen.queryByRole("link", { name: /country checklists|doc checklists/i })).not.toBeInTheDocument();
```

(Adjust if Ledger currently uses a different heading — change product copy to Cases.)

- [ ] **Step 2: Run test — expect FAIL** (links still in LedgerPage)

- [ ] **Step 3: Implement**

- Remove the settings `Link`s from `LedgerPage` header.
- Title the page **Cases**.
- Keep New case opening `NewCaseDrawer`.
- Ensure `CrmLayout` does not reintroduce a top black bar; agent button stays bottom-right as today.
- On Status emails / Doc checklists / Review pages, remove redundant “Back to the ledger” buttons (optional keep a subtle breadcrumb; prefer none).

- [ ] **Step 4: Run ledger + shell tests — expect PASS**

Run: `cd apps/admin && pnpm exec vitest run test/crm/LedgerPage.test.tsx test/AdminShell.test.tsx`

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): Cases ledger chrome without orphan settings links

EOF
)"
```

---

### Task 3: Case detail dual-pane layout

**Files:**
- Modify: `apps/admin/src/crm/case/CasePage.tsx` (split into `CaseWorkHeader.tsx` / `CasePrimaryColumn.tsx` / `CaseContextColumn.tsx` **only if** the file is already too large to edit safely — prefer extract when touching layout)
- Modify: `apps/admin/test/crm/CasePage.test.tsx`

**Interfaces:**
- Consumes: existing `CaseHeader` fields/controls, `ApplicantsTable`, `DocumentChecklistSection`, `LineItemsTable`, `Timeline`, `EditCaseDrawer`, conflict prompts
- Produces: DOM structure with testids:
  - `data-testid="case-work-header"`
  - `data-testid="case-primary-column"`
  - `data-testid="case-context-column"`

- [ ] **Step 1: Write the failing structure test**

```tsx
it("renders dual-pane hierarchy: applicants in primary, context fields secondary", async () => {
  // use existing CasePage render harness with a loaded case
  expect(await screen.findByTestId("case-work-header")).toBeInTheDocument();
  expect(screen.getByTestId("case-primary-column")).toContainElement(
    screen.getByTestId("document-checklist"), // or applicants table testid already used
  );
  // Partner field lives in context column, not above applicants
  expect(screen.getByTestId("case-context-column")).toContainElement(
    screen.getByTestId("case-field-partner"),
  );
});
```

Reuse the existing mounted case fixture from `CasePage.test.tsx`.

- [ ] **Step 2: Run — expect FAIL** (testids missing / partner still in old header card)

- [ ] **Step 3: Implement dual-pane**

Layout sketch (Tailwind, existing tokens):

1. Sticky `case-work-header`: back link “← Cases”, `caseRef` + `groupName`, status + billing selects (move from old header), Edit details button, country/type summary text.
2. `case-body` flex row:
   - `case-primary-column`: ApplicantsTable → DocumentChecklistSection → Timeline (compact: show first 8 events if list is long — no API change).
   - `case-context-column`: remaining CaseFields (partner, emails, dates, remarks) + LineItemsTable.
3. Keep `CrmLayout` agent rail as the third column when open (do not put agent inside primary scroll).
4. Preserve every existing `data-testid` used by tests (`case-field-*`, `case-applicant-row`, etc.).
5. Do not change mutation hooks or conflict prompts.

- [ ] **Step 4: Run full CasePage tests**

Run: `cd apps/admin && pnpm exec vitest run test/crm/CasePage.test.tsx`  
Expected: PASS (structure + prior mutation tests)

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): dual-pane Cases detail layout

EOF
)"
```

---

### Task 4: New case drawer copy + checklist empty state

**Files:**
- Modify: `apps/admin/src/crm/newCase/NewCaseDrawer.tsx`
- Modify: `apps/admin/test/crm/NewCaseDrawer.test.tsx`

**Interfaces:**
- Consumes: existing country checklist query
- Produces: empty-state copy pointing at **Doc checklists** (not “Country checklists”)

- [ ] **Step 1: Failing test** — empty checklist message mentions Doc checklists:

```tsx
expect(await screen.findByText(/doc checklists/i)).toBeInTheDocument();
```

- [ ] **Step 2: Run — FAIL** if old copy remains

- [ ] **Step 3: Update empty-state string** to tell the desk to configure under Doc checklists; keep stamp preview list when documents exist.

- [ ] **Step 4: Run NewCaseDrawer tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(admin): point new-case checklist empty state at Doc checklists

EOF
)"
```

---

### Task 5: Status emails + Doc checklists master–detail chrome

**Files:**
- Modify: `apps/admin/src/crm/statusEmails/StatusEmailsPage.tsx`
- Modify: `apps/admin/src/crm/countryChecklists/CountryChecklistsPage.tsx`
- Modify: matching tests under `apps/admin/test/crm/`

**Interfaces:**
- Consumes: existing list/put APIs (`crmClient.listStatusEmailTemplates`, country checklist list/put)
- Produces: list-left / editor-right layout; checklist items as removable chips + add field (not a single textarea of all lines, if that is current UX)

- [ ] **Step 1: Tests for selection behavior**

Status emails: clicking a status row shows that template’s subject in an input.  
Doc checklists: selecting a country shows its `requiredDocuments` as separate chip-like elements (`data-testid="checklist-doc-chip"`).

```tsx
expect(screen.getAllByTestId("checklist-doc-chip").map((node) => node.textContent)).toEqual(
  expect.arrayContaining(["Passport bio page"]), // use fixture labels
);
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement master–detail**

- Left list with active row styling (RGS red border/background mist).
- Right editor: emails keep preview render helper; checklists use chip row + input to add + save/clear using existing mutations.
- Remove “Back to ledger” buttons (Task 2 may have done this).

- [ ] **Step 4: Run page tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(admin): master-detail chrome for status emails and doc checklists

EOF
)"
```

---

### Task 6: Catalog merge — CRM checklist labels on public countries

**Files:**
- Modify: `packages/shared/src/countryProducts.ts` (add optional `requiredDocumentLabels`)
- Modify: `packages/shared/src/schemas.ts` if CountryProduct schema lives there / keep zod in sync
- Modify: `services/api/src/domain/config.ts` — enrich `listActiveCountryConfig` (and optionally `listCountryConfig` for admin consistency, **or** only the public active list — prefer enriching a shared helper used by `listActiveCountryConfig` so marketing sees it)
- Create or modify: `services/api/src/domain/crm/countryChecklist.ts` — ensure `findCountryChecklist` / batch list helper exists for many codes without N+1 if easy (`listCountryChecklists` from country-checklists work)
- Test: `services/api/test/...` config countries / new `catalogChecklistMerge.test.ts`
- Modify: `apps/marketing/src/components/LiveCountryHydration.tsx` — `LiveDocsList`
- Test: marketing unit test for label preference (add `apps/marketing` vitest or extract pure `docsForDisplay(product)` helper in `apps/marketing/src/lib/` and test that)

**Interfaces:**
- Consumes: `findCountryChecklist(context, tenantId, countryCode)` or `listCountryChecklists`
- Produces:
  ```ts
  // on each active country product in GET /api/v1/config/countries
  requiredDocumentLabels?: string[]; // present when CRM checklist has items; else omitted or []
  ```
  Marketing:
  ```ts
  function documentLabelsForMarketing(product: CountryProduct): string[] {
    if (product.requiredDocumentLabels && product.requiredDocumentLabels.length > 0) {
      return [...product.requiredDocumentLabels];
    }
    return product.docsRequired.map((docType) => DOC_TYPE_LABELS[docType]);
  }
  ```

- [ ] **Step 1: API failing tests**

```ts
it("prefers CRM country checklist labels on the public catalog product", async () => {
  // arrange: put CountryProduct AE active + putCountryChecklist AE with ["Passport bio page","Photo"]
  const listing = await listActiveCountryConfig(context);
  const ae = listing.countryProducts.find((p) => p.countryCode === "AE");
  expect(ae?.requiredDocumentLabels).toEqual(["Passport bio page", "Photo"]);
});

it("falls back to DocType labels when no CRM checklist exists", async () => {
  // arrange: product with docsRequired, no checklist row
  const listing = await listActiveCountryConfig(context);
  const product = listing.countryProducts.find((p) => p.countryCode === "XX" /* fixture */);
  expect(product?.requiredDocumentLabels ?? []).toEqual([]);
  // marketing helper still maps docsRequired — test helper separately
});
```

Use existing API test context builders from CRM checklist / config tests.

- [ ] **Step 2: Run — FAIL** (field missing)

- [ ] **Step 3: Schema + merge implementation**

1. Add optional `requiredDocumentLabels: z.array(z.string().min(1)).optional()` to `CountryProductSchema` (passthrough safe for old rows).
2. In `listActiveCountryConfig` (after filtering active), for each product load checklist for `product.countryCode` (batch if `listCountryChecklists` exists; else per-code find). If `requiredDocuments.length > 0`, set `requiredDocumentLabels` on the returned object (do not write back to Config Dynamo).
3. Tenant id: use the same tenant the CRM API uses for checklists (`rgs` in staging — read from existing CRM context helper; do not hardcode a magic string in five places).

- [ ] **Step 4: Marketing `LiveDocsList`**

```tsx
const labels =
  (liveProduct?.requiredDocumentLabels?.length
    ? liveProduct.requiredDocumentLabels
    : undefined) ??
  (countryProduct.requiredDocumentLabels?.length
    ? countryProduct.requiredDocumentLabels
    : undefined);

if (labels) {
  return (
    <ul>{labels.map((label) => (
      <li key={label}>...</li>
    ))}</ul>
  );
}
// fallback existing DocType map
```

- [ ] **Step 5: Run API + marketing tests — PASS**

Run:
- `cd services/api && pnpm exec vitest run test/crm/catalogChecklistMerge.test.ts` (or the file you added)
- Marketing helper test command as wired in that package

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(api): merge CRM doc checklists into public country catalog labels

EOF
)"
```

---

### Task 7: Smoke checklist + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-admin-portal-shell-redesign-design.md` — Status line → `approved` / `implemented in progress` as appropriate
- Manual smoke against staging after deploy (when asked)

- [ ] **Step 1: Run admin CRM + shell regression slice**

```bash
cd apps/admin && pnpm exec vitest run test/AdminShell.test.tsx test/crm/CasePage.test.tsx test/crm/LedgerPage.test.tsx test/crm/NewCaseDrawer.test.tsx test/crm/StatusEmailsPage.test.tsx test/crm/CountryChecklistsPage.test.tsx
```

Expected: PASS

- [ ] **Step 2: Run API merge tests**

```bash
cd services/api && pnpm exec vitest run test/crm/catalogChecklistMerge.test.ts
```

- [ ] **Step 3: Manual smoke (staging, when deploying)**

1. Sidebar: Cases nested Review / Status emails; Doc checklists top-level.  
2. Open a case: dual-pane; change custody still works.  
3. New case: country → checklist preview.  
4. Marketing visa page for a country with CRM checklist: docs match admin Doc checklists.

- [ ] **Step 4: Commit doc status touch if needed**

```bash
git commit -m "$(cat <<'EOF'
docs: mark admin shell redesign plan execution notes

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec item | Task |
|-----------|------|
| D1–D2 sidebar one portal | Task 1 |
| D3 v1 Cases polish + shell wrap | Tasks 1–5 (other pages inherit shell) |
| D4 full-page case | Task 3 (route unchanged) |
| D5 dual-pane | Task 3 |
| D6 new-case drawer | Task 4 (already drawer; copy/empty state) |
| D7 Doc checklists top-level; emails under Cases | Task 1 |
| D8 Cases label | Task 1–2 |
| D9 catalog merge A | Task 6 |
| D10 keep mutations | Task 3 constraint |
| D11 master–detail settings | Task 5 |
| Auth no rail | Task 1 |
| Review Focus items | Tasks 1, 3, 6 |

No TBD placeholders. `requiredDocumentLabels` naming is consistent across Task 6 steps.
