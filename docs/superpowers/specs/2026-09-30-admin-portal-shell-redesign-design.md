# Admin portal shell redesign + Cases dual-pane + shared country checklists

Date: 2026-09-30  
Status: approved — implemented in progress on branch `feat/admin-portal-shell-redesign` (not shipped to prod)  
Origin: brainstorm 2026-09-30 (sidebar shell, Cases table/detail/drawer, dual-pane
case layout, Doc checklists as top-level nav, marketing catalog merge).  
Interactive prototype (staging seed):
`.superpowers/brainstorm/admin-redesign-prototype.html`

Related:

- `2026-09-09-rgs-crm-design.md` / `2026-09-11-rgs-crm-ledger-design.md` (CRM
  domain; this spec changes chrome and hierarchy, not the case machine)
- Country checklist CRM ownership (plan
  `2026-09-30-crm-country-document-checklists.md`) — admin-editable
  `CountryChecklist`; this spec adds marketing as a consumer
- Status email templates (`2026-09-30-crm-status-email-templates-design.md`) —
  stay under Cases settings in the new shell

## 1. Problem

The admin app still uses a top black header and treats CRM as a special wide
“sheet” bolted onto visa Queue/Config screens. Cases detail is a long single
column that leads with a dense shared-field grid, so the desk’s real work
(status, applicants, documents) sits below the fold. Doc checklists and status
emails are orphan pages reached by “Back to ledger” links. Marketing still
renders `countryProducts.docsRequired` while CRM stamps cases from
`CountryChecklist` — two sources that can drift after checklist edits.

## 2. Goals

- One admin portal chrome: left sidebar for every authenticated screen.
- Cases as the polished proof of the redesign (table → dual-pane detail → new
  case drawer).
- Doc checklists as a first-class admin nav item (not nested under Cases).
- Marketing country pages show the same checklist the CRM uses, via the live
  catalog (no separate marketing-only doc list).
- Other admin screens (Queue, Leads, Activity, Notices, Config, Users) wrap in
  the new shell in v1 without redesigning their guts.

## 3. Non-goals (v1)

- Redesigning Queue / Leads / Activity / Notices / Config / Users content.
- Changing CRM status machine, email template domain, or case write APIs
  beyond what dual-pane layout requires (same fields and mutations).
- Master–detail (split) case route; case stays a full page.
- New case as a full page; stays a drawer over the Cases table.
- Replacing the agent panel with a modal; it remains a collapsible right rail
  on Cases surfaces only.
- Pixel-perfect recreation of the HTML prototype; prototype is hierarchy and
  density guidance.

## 4. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Classic app rail: fixed left sidebar (~220px), dark ink, RGS red active; user + sign-out at bottom. No top black header. | Owner chose approach 1 over icon-rail or CRM-only sidebar. |
| D2 | One portal: Cases is a screen in admin, not a special CRM theme/sheet. Same shell tokens for Queue and Cases. | Owner: do not treat admin different from CRM. |
| D3 | v1 ships shell + Cases polish (table, dual-pane detail, new-case drawer, status emails UI, doc checklists UI). Other routes only wrap in shell. | Owner chose phased scope A. |
| D4 | Case detail = full page `/crm/cases/:id` (keep route). | Owner chose A over master–detail or drawer. |
| D5 | Case layout = dual-pane: sticky work header (ref, status, billing, primary actions); primary column = applicants + document checklist + compact timeline; secondary column = context fields + line items; agent rail optional on the right. | Owner rejected keep-stack reskin; dual-pane is the desk hierarchy. |
| D6 | New case = right drawer over Cases table; country select shows checklist stamp preview. | Owner chose B. |
| D7 | Nav under Cases: Review, Status emails. **Doc checklists is a top-level nav item** (sibling of Cases, Queue, …). | Owner correction after settings section. |
| D8 | Sidebar label for the ledger: **Cases** (route may remain `/crm` and `/crm/...` under the hood). | Matches “one portal” language; avoids “CRM app” framing. |
| D9 | Marketing live catalog **merges** CRM `CountryChecklist.requiredDocuments` into each country product’s public doc list (option A). `LiveDocsList` keeps consuming `docsRequired` (or the catalog field that replaces it); editors change lists only in Admin → Doc checklists. | Single runtime source; marketing already hydrates from catalog. |
| D10 | Existing case fields, inline edits, EditCaseDrawer, ConflictPrompt, undo toasts, and AgentPanel behavior stay; v1 is layout/chrome. | Avoid rewriting domain while redesigning shell. |
| D11 | Status emails settings UI: master–detail (list + editor with preview). Doc checklists UI: searchable country list + item chips. | Agreed in design sections; improves today’s table/modal feel. |

## 5. Information architecture

### 5.1 Sidebar (permission-filtered, same screens as today)

Order (adjust only if landing-path rules require it):

1. Queue  
2. Leads  
3. Cases → nested: Review, Status emails  
4. Doc checklists *(top-level)*  
5. Activity  
6. Notices  
7. Config  
8. Users  

Sign-out + signed-in email at the foot of the rail.

### 5.2 Routes (keep unless a rename is trivial)

| UI | Route |
|----|--------|
| Cases table | `/crm` |
| Case detail | `/crm/cases/:caseId` |
| Review | `/crm/review` |
| Status emails | `/crm/status-emails` |
| Doc checklists | `/crm/country-checklists` (or `/admin/doc-checklists` if rename is cheap; either way, top-level nav) |

### 5.3 Cases table

- Page title **Cases**; primary CTA **New case** opens drawer.
- Filter chips + search (existing ledger filters can map into this chrome).
- Row click → case detail full page.
- Agent: existing floating control / right rail pattern, not a global shell column.

### 5.4 Case detail (dual-pane)

**Sticky work header**

- Back → Cases  
- `caseRef`, optional `groupName`  
- Inline case status + billing status (legal transitions unchanged)  
- Country / type / visa summary as text  
- Actions: Edit details (existing drawer), optional agent toggle  

**Primary column (work)**

- Applicants table (same columns and custody/outcome controls)  
- Document checklist section (same API)  
- Timeline compact (recent events; full list still available — default show ~8, no new API)

**Secondary column (context)**

- Partner + vendor email, client email, dates, remarks (same inline email /
  appointment commit contracts)  
- Line items + download invoice  

**Agent rail**

- Same `AgentPanel` with `selectedCaseIds=[caseId]`; collapsible/resizable as
  today; visually part of portal, not a CRM-only mist theme.

### 5.5 New case drawer

- Overlay on Cases table; Esc / Cancel / backdrop close.  
- Partner, country (full names), applicants, remaining today’s fields.  
- Checklist preview from CRM country checklist; empty/not-configured state is
  loud.

### 5.6 Status emails & Doc checklists

- Status emails: list of statuses with On/Off; editor with subject, body,
  placeholder chips, live preview.  
- Doc checklists: country list with counts / “Not configured”; chip editor for
  required documents.

## 6. Marketing + catalog merge (D9)

### 6.1 Runtime source of truth

For **document lists shown to the public** and for **stamping new CRM cases**,
the authority is CRM `CountryChecklist.requiredDocuments` (human-readable
labels already stored after the country-checklist migration).

Config / shared `COUNTRY_PRODUCTS.docsRequired` (`DocType` enums) remains a
seed/fallback for product metadata (fees, processing, applyability) but must
not win over a CRM checklist when one exists.

### 6.2 Catalog behavior

When building or hydrating the public/live catalog:

1. Load country products as today (fees, names, tiers, activity).  
2. For each country code, if a CRM `CountryChecklist` exists, set the catalog
   docs field from `requiredDocuments` (labels).  
3. If no CRM checklist exists, fall back to mapping `docsRequired` DocTypes
   through `DOC_TYPE_LABELS` (or leave empty for unfulfilled countries).  
4. Marketing `LiveDocsList` (and any static country page docs section) renders
   that catalog docs field so an admin edit in Doc checklists appears on the
   marketing country page after catalog refresh — no marketing-only editor.

Exact catalog JSON shape (keep `docsRequired` as DocType[] vs introduce
`requiredDocumentLabels: string[]`) is an implementation choice; prefer
**labels in the public payload** so free-text CRM checklist items are
representable. If DocType[] cannot express CRM strings, add a labels array and
teach `LiveDocsList` to prefer it.

### 6.3 Consistency rules

- Editing Doc checklists in admin updates CRM storage and must be visible to
  catalog consumers without a marketing redeploy (live catalog path).  
- New Case stamp and marketing docs for the same country must match when a
  checklist exists.  
- Portal Config screens are out of scope for this redesign except where
  catalog merge already reads config products.

## 7. Visual system (v1)

Reuse existing RGS admin tokens: ink, paper, mist, line, rgs-red. Sidebar is
dark ink; main column paper/mist. No purple SaaS kit; no second brand for
Cases. Density: desk tool, not marketing landing. Motion: only open/close drawer
and panel — no decorative entrance cascades.

## 8. Shell implementation sketch

- Replace `AdminShell` top header with a layout that owns the sidebar + main
  outlet for authenticated routes (auth page stays full-bleed, no rail).  
- Remove CRM-only `contentWidth="wide"` special casing that invents a separate
  paper sheet; Cases uses the same main column as Queue.  
- `CrmLayout` agent splitter becomes a child of the Cases main column, not a
  second global chrome.  
- Nav links: extend `ADMIN_NAV_LINKS` (or a nested structure) so Doc checklists
  is top-level and Cases children are Review + Status emails.  
- Landing path logic still uses first reachable top-level link.

## 9. Testing

- Shell: every allowed screen reachable from sidebar; forbidden screens hidden;
  sign-out still works; `/auth` has no rail.  
- Cases: row → detail; back → table; new case drawer open/close; dual-pane
  sections present with existing mutation test coverage still green.  
- Doc checklists: top-level nav; CRUD still covered by existing CRM tests.  
- Catalog merge: country with CRM checklist returns those labels to marketing
  hydration; country without checklist falls back safely; LiveDocsList renders
  labels (unit/integration as fits current marketing catalog tests).

## 10. Rollout

1. Shell + nav (all pages wrap).  
2. Cases table + drawer chrome.  
3. Case dual-pane layout.  
4. Status emails + Doc checklists settings UIs.  
5. Catalog merge for marketing docs.  

Staging prototype with real data may be used for desk feedback before merge.

## 11. Open implementation details (not product forks)

These are left to the implementation plan; they do not reopen product
decisions:

- Whether public catalog uses `requiredDocumentLabels: string[]` or remaps into
  existing fields.  
- Exact CSS/structure for sticky header vs scroll containers.  
- Optional rename of `/crm/country-checklists` path for friendlier URLs.

## 12. Prototype reference

File: `.superpowers/brainstorm/admin-redesign-prototype.html`  
Seed: staging DynamoDB cases, partners, status email templates, country
checklists (exported 2026-09-30). Prototype writes are fake.
