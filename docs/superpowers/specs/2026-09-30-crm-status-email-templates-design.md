# CRM: expanded case statuses + configurable status email templates

Date: 2026-09-30
Status: approved 2026-09-30 — implementation plan next
Origin: owner feedback doc "Visa status CZrm.docx" (2026-09-30), plus
clarifications in chat: path C (new statuses 1:1 with templates); group cases
use one Decision Received template listing per-person outcomes while
individuals use Visa Granted / Visa Refused; templates editable in Admin UI
(Approach A: one DB row per status).

Related: `2026-09-09-rgs-crm-design.md` (status machine),
`2026-09-25-crm-family-groups-client-email-design.md` (status mail trigger,
D6 same body to vendor + client).

## 1. Problem

The desk has twelve client-facing visa-stage messages (Application Received
through Application Closed). Today's CRM only has nine `CaseStatus` values and
sends one generic body on status change:

```
Case {ref} (destination {country}) is now {toLabel} (was {fromLabel}).
```

Gaps:

- Several feedback stages have no case status (`ADDITIONAL_DOCS_REQUIRED`,
  `READY_FOR_SUBMISSION`, `UNDER_PROCESS`, `PASSPORT_RECEIVED`, and distinct
  Granted / Refused).
- Copy is hard-coded; the owner cannot edit wording without a deploy.
- Feedback warns not to say "Visa Approved" unless the CRM has captured the
  decision; family cases can mix APPROVED and REJECTED on one case.

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Expand `CaseStatus` so each of the twelve feedback stages is a first-class status (path C). | Owner chose 1:1 status↔template over mapping-only or outcome/custody triggers. |
| D2 | Rename `IN_PROGRESS` → `DOCS_UNDER_REVIEW` (enum + stored values + GSI1). | Matches feedback label "Documents Under Review"; avoid a dead alias. |
| D3 | Group cases (has `groupName` **or** more than one applicant) never auto-derive to `VISA_GRANTED` / `VISA_REFUSED`. When every applicant is APPROVED or REJECTED, derive `DECIDED` and send the Decision Received template with an applicants list. | Owner: groups one template, individuals another; preserves mixed-outcome families (D1 of 2026-09-25). |
| D4 | Individual cases (exactly one applicant, no group name): all APPROVED → `VISA_GRANTED`; all REJECTED → `VISA_REFUSED`; otherwise stay on / reopen rules below. | Matches feedback templates 10 and 11. |
| D5 | Templates are Approach A: one Dynamo row per `CaseStatus` (tenant-scoped), edited in Admin UI. | Owner chose Admin UI over repo config; status-keyed rows match desk mental model. |
| D6 | Client and vendor still receive the **same** rendered subject and body. | Keeps 2026-09-25 D6; splitting audiences is YAGNI this round. |
| D7 | Mail fires on **case status change** (including derived) **and** once on **case create** (template for the initial status, normally `NEW` / Application Received). Outcome or custody alone does not send unless derivation flips `caseStatus`. | Feedback template 1 is Application Received; today's change-only trigger never sends it. |
| D8 | `enabled: false` on a template skips that send only; the status change itself still succeeds. | Desk can silence a stage without breaking the machine. |
| D9 | Off-ramps (`NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`) keep existing meaning; each gets a short default template so the admin screen is complete. | Feedback did not define copy; defaults beat a blank row. |
| D10 | Existing `DECIDED` rows are **not** split into Granted/Refused by migration. | Historical mixed families and missing outcome data; desk can move individuals forward by hand. |

## 3. Case statuses

### 3.1 Full set

Happy path (labels = admin / email defaults):

| Status | Label | Feedback # |
|--------|-------|------------|
| `NEW` | Application Received | 1 |
| `DOCS_UNDER_REVIEW` | Documents Under Review | 2 (was `IN_PROGRESS`) |
| `ADDITIONAL_DOCS_REQUIRED` | Additional Documents Required | 3 |
| `READY_FOR_SUBMISSION` | Application Ready for Submission | 4 |
| `APPOINTMENT_SET` | Appointment Booked | 5 |
| `SUBMITTED` | Application Submitted | 6 |
| `UNDER_PROCESS` | Under Embassy/Consulate Processing | 7 |
| `PASSPORT_RECEIVED` | Passport Ready / Received | 8 |
| `DECIDED` | Decision Received | 9 |
| `VISA_GRANTED` | Visa Granted | 10 |
| `VISA_REFUSED` | Visa Refused | 11 |
| `CLOSED` | Application Closed | 12 |

Off-ramps (unchanged): `NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`.

### 3.2 Live vs terminal

- **Live:** `NEW`, `DOCS_UNDER_REVIEW`, `ADDITIONAL_DOCS_REQUIRED`, `READY_FOR_SUBMISSION`, `APPOINTMENT_SET`, `SUBMITTED`, `UNDER_PROCESS`, `PASSPORT_RECEIVED`, `DECIDED`, `VISA_GRANTED`, `VISA_REFUSED`.
- **Terminal:** `CLOSED`, `NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`.

`VISA_GRANTED` and `VISA_REFUSED` are live so the desk can still move to `CLOSED` (and reopen rules can undo a mistaken decide). They are not off-ramps.

### 3.3 Forward transitions

Happy-path order above. Skip-ahead remains legal from any live status to a later happy-path status and to `CLOSED`, same spirit as today's machine (e-visa / attestation shortcuts). Off-ramps remain reachable from every live status.

Reopen: from `DECIDED` / `VISA_GRANTED` / `VISA_REFUSED`, `SUBMITTED` stays the reopen edge when work returns (see derivation).

Exact adjacency table lives in `packages/shared/src/crm/stateMachines.ts` and is the source of truth for tests; this section defines intent, not every cell.

### 3.4 Derivation from applicant outcomes

Replaces "every decided → `DECIDED`":

```
if terminal: keep
if no applicants: keep
if every applicant is APPROVED or REJECTED:
  if isGroup(case): return DECIDED
  if every APPROVED: return VISA_GRANTED
  if every REJECTED: return VISA_REFUSED
  // individual with mixed is impossible (one applicant)
  return DECIDED
if current in {DECIDED, VISA_GRANTED, VISA_REFUSED}: return SUBMITTED  // reopen
else: keep
```

`isGroup(case)` = `groupName` is set **or** `applicants.length > 1`.

`SENT_BACK` still does not count as decided (unchanged).

Only this outcome-driven derivation auto-moves status. Stages 3–8
(`ADDITIONAL_DOCS_REQUIRED` … `PASSPORT_RECEIVED`) are **desk-set** (or
skip-ahead); nothing in custody or checklist flips them this round.

Closability (`isCaseClosable`) unchanged: every custody `RETURNED` and billing settled.

### 3.5 Normalization / import

`packages/shared/src/crm/normalize/status.ts` maps Excel "In Progress" / "Working on It" → `DOCS_UNDER_REVIEW`. New stage strings map when known; unknown strings stay on today's unresolved path. Import does not invent `VISA_GRANTED` / `VISA_REFUSED` from "Approved"/"Rejected" — those still land as `DECIDED` + per-applicant outcome (D10), matching historical sheets.

## 4. Email templates

### 4.1 Storage

Per tenant, one item per status:

```
PK = TENANT#<tenantId>#STATUS_EMAIL_TEMPLATE#<caseStatus>
SK = META
```

Attributes:

| Field | Type | Notes |
|-------|------|-------|
| `caseStatus` | CaseStatus | partition identity |
| `subject` | string | placeholders allowed; max length enforced in schema |
| `body` | string | plain text; placeholders allowed |
| `enabled` | boolean | default true |
| `updatedAt` | ISO | |
| `updatedBy` | email | |

Defaults for the twelve feedback stages are seeded from "Visa status CZrm.docx" (phone footer `+91 98180 67432 / 011-41011617`). Off-ramp defaults are short plain notices. Seed is idempotent: insert-if-absent so desk edits survive re-runs.

### 4.2 Placeholders

| Token | Resolved from |
|-------|----------------|
| `{{clientName}}` | `groupName` if set, else first applicant display name |
| `{{countryVisaType}}` | country name + visa type label |
| `{{applicationId}}` | `caseRef` |
| `{{appointmentDate}}` | case appointment date as `DD MMM YYYY`, else empty |
| `{{appointmentTime}}` | empty until a time field exists (reserved) |
| `{{centre}}` | empty until a centre field exists (reserved) |
| `{{applicantsBlock}}` | multi-line list `ref – name – outcome` (group template); empty for individuals |
| `{{phone}}` | default RGS numbers above (constant until a tenant setting exists) |

Unresolved tokens: replace with empty string (never leave `{{…}}` on the wire).
Renderer rule: any **line** that still contains only whitespace after substitution
is dropped. Seeded Appointment Booked copy therefore keeps
`{{appointmentDate}}` / `{{appointmentTime}}` / `{{centre}}` on one line; when
time/centre fields do not exist yet, that line collapses to the date alone or
is dropped if the date is unset too.

### 4.3 Subject

Desk filing subject `REF – STATUS – NAME – COUNTRY` remains the **default** subject string in seeded templates (STATUS = template label). Admin may edit freely; send path does not force the old format if the stored subject differs.

### 4.4 Send path (`statusNotify.ts`)

Shared helper used by `changeCaseStatus` / derivation **and** `createCase`:

1. Load template for the status being announced (`toStatus`, or initial status on create).
2. If missing or `enabled === false` → skip sends (no PARTNER/CLIENT events).
3. Else render subject + body with placeholders; send to vendor and client independently as today; record `PARTNER_NOTIFIED` / `CLIENT_NOTIFIED`.

On create, meta may use `fromStatus` equal to `toStatus` (or omit from) — timeline copy should read as an initial notify, not a fake transition. Prefer meta `{ channel, toAddress, toStatus, reason: "CREATE" }` for create and keep `{ fromStatus, toStatus }` for changes; update admin `eventCopy` accordingly.

Fallback: if the template row is missing because seed has not run, do not resurrect the old hard-coded generic body — skip. Migration must seed before relying on mail in that environment.

## 5. API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/admin/crm/status-email-templates` | List all statuses with current or default-empty rows |
| `GET` | `/api/v1/admin/crm/status-email-templates/{caseStatus}` | One template |
| `PUT` | `/api/v1/admin/crm/status-email-templates/{caseStatus}` | Upsert `subject`, `body`, `enabled` |
| `POST` | `/api/v1/admin/crm/status-email-templates/{caseStatus}/reset` | Restore seeded default for that status |

Write-guarded like other CRM admin writes. Body schema in `@rgs/shared`.

## 6. Admin UI

New CRM settings screen: "Status emails".

- Table: status label, enabled toggle, updatedAt.
- Edit drawer: subject, body (textarea), placeholder cheat-sheet, live preview with sample data, Save / Reset to default.
- Case status dropdowns / chips / ledger colours gain the new statuses and labels (`CASE_STATUS_LABELS`).

No change to New Case / Edit Case beyond the expanded status picker already driven by shared enums.

## 7. Migration

1. **Rename status:** every case (and GSI1 `CASE_STATUS#IN_PROGRESS`) with `IN_PROGRESS` → `DOCS_UNDER_REVIEW`. Same for any secondary indexes / search text that embed the status string if present.
2. **Seed templates:** insert-if-absent for every `CaseStatus` including off-ramps.
3. **No** rewrite of `DECIDED` → `VISA_GRANTED` / `VISA_REFUSED`.

CLI under `services/migration`, same pattern as recent backfills.

## 8. Out of scope

- HTML / rich email
- Separate vendor vs client templates
- Per-language templates
- WhatsApp / SMS channel
- Recording send success vs failure (still tracked elsewhere)
- New case fields for appointment time / visa centre (placeholders reserved only)
- Client portal
- Auto-splitting historical `DECIDED` rows

## 9. Tests

| Package | Coverage |
|---------|----------|
| shared | New statuses in schemas/enums; transition table; derivation group vs individual; normalize `IN_PROGRESS` → `DOCS_UNDER_REVIEW` |
| api | Template CRUD + reset; render placeholders + blank-line drop; notify uses template / skips when disabled; createCase sends initial template; changeCaseStatus + derive for new statuses |
| migration | Rename backfill; seed idempotent |
| admin | Labels for new statuses; Status emails screen load/save/preview (component tests) |

## 10. Default copy source

Seeded subject/body text for the twelve happy-path statuses comes from
`/Users/parvez/Downloads/Visa status CZrm.docx` (2026-09-30), with placeholders
substituted for the bracket tokens in that doc (`[Client Name]` →
`{{clientName}}`, etc.). Item 9's editorial note is product guidance already
encoded in D3/D4 (neutral Decision Received for groups; Granted/Refused only
for individuals with a captured outcome).
