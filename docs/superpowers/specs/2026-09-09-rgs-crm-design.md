# RGS CRM — Design

**Date:** 2026-09-09
**Status:** Approved, ready for implementation planning
**Supersedes:** nothing. Extends the existing RGS visa platform.

---

## 1. Why

Rays Global Services runs its visa-processing desk out of a shared Excel
workbook, `CRM - RAYS GLOBAL SERVICES.xlsx`. The sheet works, and it is
failing at the edges.

| Sheet | Purpose | Size |
|---|---|---|
| `Mini CRM` | master ledger, Dec 2024 – Jun 2026 | 7,161 rows × 24 cols |
| `2025 YEAR` | earlier copy; retains a `Phone` column the master lost | 6,549 rows |
| `REQURIED INFORMATION` | 31 countries → Google Drive links | 33 rows |
| `CHECKLIST` | 81 countries → Google Drive folder links | 284 rows |

Volume has grown from ~220 applications/month in early 2025 to ~490/month by
May 2026.

Where it bleeds:

| Column | Fill | Problem |
|---|---|---|
| Status | 62% | 27 free-text variants, mixing case progress with physical logistics |
| Country | 97% | 166 spellings for ~90 countries |
| Entries | 49% | 34 variants encoding three independent facts in one string |
| Visa Type | 62% | 30 variants, several of which are not visa types at all |
| Payment status | 0.5% | billing is not tracked here |
| Phone | 0% | column dropped when the current sheet was created |
| Passport No. | 26% | no dedup; repeat travellers are invisible |
| Dates | mixed | `30-12-2024`, `01/05/2025`, `2030-01`, one row in 2006 |

There are also column-shift errors: a passport number sitting in `Status`, a
date in `Visa Type`, the literal header `Entries` repeated as a data value.

Nothing in the sheet can answer "whose passport are we holding right now",
"which files have gone quiet", or "what did this partner bill last quarter".

**Goal:** replace the workbook with a CRM that does everything the sheet does,
plus the things a sheet fundamentally cannot — and make it agentic, per the AX
Handbook. RGS is the pilot tenant; the product is intended to be sold to other
small businesses afterwards.

---

## 2. Decisions

Recorded with the reasoning, so a later reader knows what was traded away.

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | CRM lives as a namespaced module inside `apps/admin` | Separate `apps/crm`; standalone repo; refactoring the platform around the CRM |
| 2 | v1 logins are RGS staff only | Partner logins; traveller logins; public status links |
| 3 | Migrate all 7,161 rows, agent-assisted normalization with a human review queue | Clean rows only; start fresh; last 12 months only |
| 4 | Agent does intake, watchdog, ask-the-ledger, and country checklists | A narrower subset |
| 5 | Three independent state axes: case status, passport custody, billing | One flat status; two axes without billing |
| 6 | A Case groups 1..n Applicants; Travellers persist across cases | One record per applicant (Excel shape); adding a first-class Partner tier above Case |
| 7 | Case has a type plus billable line items | Everything is a visa case; free-text add-ons with no pricing |
| 8 | LLM provider is pluggable; model and key come from env | Hardcoding Claude |
| 9 | Watchdog thresholds are tenant defaults, overridable per case | Hardcoded thresholds |

**On decision 1** — extending `apps/admin` was chosen for a single staff login
over a cleaner separation. The mitigation is strict namespacing: `crm/` folders, `/crm/*` routes, CRM-only
domain modules, and CRM entities living under their own tenant-scoped key space
(`TENANT#<t>#CASE#...`, never mixed into the existing `USER#`/`CONFIG#` items).
Extraction later is a move, not a rewrite.

**On decision 8** — at RGS's volume the provider abstraction saves roughly
$24/month, which would not justify it. It is justified by the multi-tenant plan:
at 100 tenants the same choice is a four-figure monthly margin lever. The
abstraction is paid for by the roadmap, not the pilot.

---

## 3. Scope

**In:** case management across the three axes, partner and traveller records,
line items and billing state, country checklists, the four agent capabilities,
agent memory, the watchdog, full migration of the workbook, audit trail.

**Out of v1, deliberately:** partner or traveller logins, payment collection or
gateway integration, invoice PDF generation, tenant signup and subscription
billing, a tenant-management UI, WhatsApp or email ingestion (staff paste
manually in v1), mobile app.

**Non-functional, non-negotiable:** the CRM must remain fully usable by hand
when the LLM provider is unavailable. The agent is an accelerator, never a
dependency.

---

## 4. Architecture

Everything reuses the deployed platform: one DynamoDB table, the admin Cognito
pool, S3, SES, one CDK stack per environment in `ap-south-1`.

```
                    apps/admin  (React SPA, existing)
                    ├── existing visa-portal ops screens   (untouched)
                    └── /crm/*  ledger · case · today · partners · memory
                            │                        │
                     REST (JWT)                 SSE (JWT)
                            │                        │
                            ▼                        ▼
                  AdminApiFunction          AgentFunction
                  (API Gateway)             (Lambda Function URL,
                                             RESPONSE_STREAM mode)
                            │                        │
                            │                  agent/loop.ts
                            │                  ├── approval gate
                            │                  ├── tool dispatch
                            │                  └── providers/{anthropic,gemini}
                            │                        │
                            └────────┬───────────────┘
                                     ▼
                        services/api/src/domain/crm/*
                                     │
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
                 DynamoDB          S3              SES
               (single table)  (documents)    (notifications)

              WatchdogFunction  ◄── EventBridge cron (nightly)
                     └── deterministic rules → nudges → one digest LLM call
```

The agent loop calls the **same** `domain/crm/*` functions the REST handlers
call. There is exactly one data path; tools are a Zod-typed shell over the
domain layer.

**Why a Function URL rather than API Gateway** for the agent: API Gateway's HTTP
API has a hard 30-second timeout, which a multi-tool agent turn exceeds
routinely. Function URLs support response streaming. The cost is a second entry
point with its own CORS configuration and its own JWT verification, since
Function URLs do not get API Gateway's authorizer. Accepted.

---

## 5. Data model

Single-table DynamoDB. The table already has `GSI1`, `GSI2`, `GSI3` with generic
`GSInPK`/`GSInSK` attributes; CRM entities share them via key prefixes. No new
index is required.

Every CRM key carries a tenant segment from day one.

```
TENANT#<t>#PARTNER#<partnerId>     META
    canonicalName, aliases[], type: AGENCY|CORPORATE|DIRECT,
    contact{phone,email,whatsapp}, notes, createdAt
    GSI1PK = TENANT#<t>#PARTNERS          (list all)

TENANT#<t>#TRAVELLER#<travellerId>  META
    fullName, normalizedName, dateOfBirth?, phone?, passportNumber?
    GSI3PK = TENANT#<t>#PASSPORT#<passportNumber>   (repeat-traveller lookup)
    GSI2PK = TENANT#<t>#TRAVELLER_NAME#<normalizedName>  (fuzzy fallback)

TENANT#<t>#CASE#<caseId>            META
    caseRef              human-facing, continues the Excel REF NO sequence
    caseType             VISA | ATTESTATION | APOSTILLE | PASSPORT | OTHER
    partnerId
    destinationCountry   ISO-3166 alpha-2
    visaType             enum (VISA cases only)
    entryType            SINGLE | DOUBLE | MULTIPLE
    processing           NORMAL | EXPRESS | PREMIUM_LOUNGE
    validity             optional, e.g. "10Y", "1Y", "6M"
    caseStatus           axis 1
    billingStatus        axis 3
    receivedDate, submissionDate, appointmentDate,
    expectedCollectionDate, courierDate
    lineItems[]          {code, label, amountInr, qty, kind}
    totalInr             derived, stored
    watchdogOverrides{}  per-rule threshold overrides
    mutedRules[]         rule ids silenced on this case
    snoozedUntil?        whole-case snooze
    sourceRow, sourceSheet, legacyRaw{}   migration provenance
    createdAt, updatedAt, createdByEmail
    GSI1PK = TENANT#<t>#CASE_STATUS#<caseStatus>   GSI1SK = <updatedAt>
    GSI2PK = TENANT#<t>#PARTNER#<partnerId>        GSI2SK = <receivedDate>

                                    APPLICANT#<nn>
    travellerId, applicantRef, passportNumber
    custody              axis 2
    custodySince         timestamp of last custody change
    outcome              PENDING | APPROVED | REJECTED | SENT_BACK
    courierMode          DTDC | SPEEDPOST | BLUEDART | PORTER | HANDOVER | PICKUP
    trackingNumber?, visaResultKey?

                                    NOTE#<ts>
                                    EVENT#<ts>#<id>     audit trail
                                    NUDGE#<nudgeId>     open watchdog items

TENANT#<t>#COUNTRY#<iso2>           PROFILE
    checklistItems[], driveFolderUrl?, processingDays?, notes

TENANT#<t>#CRM_MEMORY#<scope>       <memoryKey>
    scope: ORG | PARTNER#<id> | USER#<email>
    text, sourceCaseId?, createdBy: agent|human, createdAt

TENANT#<t>#CRM_USER#<email>         PREFS
    trustLevel: 0|1|2, autoApplyOptIn: bool, defaultFilters{}

TENANT#<t>#CONFIG                   WATCHDOG
    per-rule default thresholds
```

### The three axes

```
caseStatus    NEW → IN_PROGRESS → APPOINTMENT_SET → SUBMITTED → DECIDED → CLOSED
              terminal off-ramps: NOT_SUBMITTED, WITHDRAWN, DUPLICATE

custody       NOT_HELD → WITH_RGS → AT_EMBASSY → WITH_RGS → IN_TRANSIT → RETURNED
              (per applicant — custody is a property of a passport, not a file)

outcome       PENDING → APPROVED | REJECTED | SENT_BACK        (per applicant)

billingStatus UNBILLED → BILL_SENT → PAID | PART_PAID | WRITTEN_OFF
              UNKNOWN — migrated rows only; never set by the CRM itself
```

Derived rules:
- A case becomes `DECIDED` when every applicant has a non-`PENDING` outcome.
- A case becomes `CLOSED` when every applicant is `RETURNED` **and**
  `billingStatus` is `PAID` or `WRITTEN_OFF`.

These derivations apply to cases created in the CRM. Migrated cases keep the
status the import assigned them and are never retroactively reopened by the
derivation — the source sheet fills `payment status` on 0.5% of rows, so almost
every historical case would otherwise be dragged back out of `CLOSED`. Migrated
rows with no billing evidence import as `billingStatus: UNKNOWN`, which is
excluded from the `billing_overdue` watchdog rule.

Outcome lives on the applicant, not the case, because the Excel shows mixed
results within a single group booking. The cost is a rollup on every list view.

---

## 6. Normalization

The three-axis model exists because the Excel's `Status` column is two things
at once. Full mappings below; these are the migration's contract and the source
of its unit tests.

### Status (27 distinct) → three axes

| Excel value | caseStatus | custody | outcome |
|---|---|---|---|
| `Working on It`, `In Progress` | IN_PROGRESS | — | — |
| `Appoinment Scheduled` | APPOINTMENT_SET | — | — |
| `Submitted`, `ONLINE SUBMITTED` | SUBMITTED | AT_EMBASSY | — |
| `Approved` | DECIDED | — | APPROVED |
| `Rejected` | DECIDED | — | REJECTED |
| `SENT BACK` | DECIDED | — | SENT_BACK |
| `Sent on Courier`, `SPEED POST`, `DTDC` | — | IN_TRANSIT | — |
| `Handover`, `Delivered`, `Pickup`, `PORTER` | CLOSED | RETURNED | — |
| `PASSPORT COLLECTION`, `PASSPORT ONLY` | — | WITH_RGS | — |
| `Not submitted`, `NOT PROCESSED` | NOT_SUBMITTED | — | — |
| `WITHDRAWAL` | WITHDRAWN | — | — |
| `duplicate entry` | DUPLICATE | — | — |
| `Payment Only` | → `caseType: OTHER` | — | — |
| `Documents attestation` | → `caseType: ATTESTATION` | — | — |
| `TICKET BOOKED` | → line item, not a status | — | — |
| `REC: Bio Letter` | IN_PROGRESS + note | — | — |
| `DEU/DEL/190126/...`, `Visa Category: Short Stay` | column-shift junk → review queue | | |

Courier mode is captured separately from custody: `Sent on Courier` alone
leaves `courierMode` unknown, while `DTDC`/`SPEED POST`/`PORTER`/`Pickup`/
`Handover` set it.

### Entries (34 distinct) → three fields

One string encodes entry count, processing speed, and validity.

| Excel value | entryType | processing | validity |
|---|---|---|---|
| `Single`, `single`, `Single entry`, `X1` | SINGLE | NORMAL | — |
| `Single Exp`, `SINGLE/EXPRESS` | SINGLE | EXPRESS | — |
| `Single Nrml`, `Single Normal`, `Single Nrmal`, `SINGLE/NORMAL` | SINGLE | NORMAL | — |
| `Single PL` | SINGLE | PREMIUM_LOUNGE | — |
| `Double`, `Double entry` | DOUBLE | NORMAL | — |
| `Double Exp`, `DOUBLE EXPRESS`, `DOUBLE/EXPRESS` | DOUBLE | EXPRESS | — |
| `Double Nrml` | DOUBLE | NORMAL | — |
| `Double PL` | DOUBLE | PREMIUM_LOUNGE | — |
| `Multiple`, `MULTIPLE/NORMAL` | MULTIPLE | NORMAL | — |
| `MULTIPLE EXPRESS` | MULTIPLE | EXPRESS | — |
| `Multiple PL` | MULTIPLE | PREMIUM_LOUNGE | — |
| `Multiple 10 Yr`, `Multiple 10 Yr/` | MULTIPLE | NORMAL | 10Y |
| `Multiple 1 Yr` | MULTIPLE | NORMAL | 1Y |
| `Multiple 1 Yr/E` | MULTIPLE | EXPRESS | 1Y |
| `Multiple 6 Months` | MULTIPLE | NORMAL | 6M |
| `5 YR MULT` | MULTIPLE | NORMAL | 5Y |
| `3 MONTHS SINGLE URGENT` | SINGLE | EXPRESS | 3M |
| `1 Yr Exp`, `6M Exp` | unknown | EXPRESS | 1Y / 6M |
| `Business`, `Entries`, blank | junk → review queue | | |

### Visa Type (30 distinct) → caseType × visaType

`Attestation`, `DOCUMENTS ATTESTED` → `caseType: ATTESTATION`.
`APPOSTIAL`, `PCC APPOSTILE` → `caseType: APOSTILLE`.
`PASSPORT APPLY`, `PASSPORT SUBMISSION` → `caseType: PASSPORT`.
`DEGREE` → `caseType: ATTESTATION`.
Everything else stays `caseType: VISA` with a normalized `visaType`
(`Tourist`, `Business`, `Evisa - Tourist`, `B1/B2`, `Family Visit`, `Dependent`,
`Study`, `Work Visa`/`WORK PERMIT`/`EMPLOYMENT VISA`, `SEAMAN VISA`,
`RELATIVE VISA`, `TRADE FAIR`, `SPORTS`, `TRANSIT SEA FAIR`, `MDAC`, `STP`,
`STR`, `F VISA`, `VEVO`, `E-VISA`).
`2025-01-03 00:00:00`, `DOM(GUADELOUPE,ST MARTIN` → review queue.

### Country (166 spellings) → ISO-3166 alpha-2

Case-folded exact match first, then an explicit alias table:
`SWISS`/`SWIZTERLAND` → CH, `NETHERLAND`/`NETHERLANDS` → NL,
`VEITNAM` → VN, `SRILANKA`/`Sri Lanka ETA` → LK (with `Sri Lanka ETA`
additionally setting `visaType: E-VISA`), `KOREA`/`SOUTH KOREA` → KR,
`Cote d'Ivoire (Ivory Coast)` → CI, `CROTIA` → HR, `ETHOPIA` → ET,
`ALGERIA` → DZ, `CZECH REPUBLIC`/`CZECH GROUP` → CZ, `DUBAI` → AE.
Unmatched → review queue.

### Partner (257 strings) → canonical partners with aliases

`VWI`, `VWI BOM`, `VWI Mumbai`, `VWI HYDERABAD` collapse to one partner with
branch aliases. `MEHUL MEHUL` / `MEHUL MANOJ` and `SAMMY A/C` are reviewed by
hand — they may be one person or two. `Customer A/C` becomes a partner of type
`DIRECT`.

### Line items

Seeded from what the workbook already sells, drawn from `Visa Type` and
`Additional Items`: visa service fee, government/embassy fee, photo making,
form filling, hotel booking, ticket booking, collection charge, courier charge,
Chinese translation, attestation, apostille, PCC.

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

---

## 7. Agent layer

### Provider abstraction

The approval gate is a safety invariant, so it lives in our own loop, above the
provider — not in any vendor's tool-runner hooks.

```
services/api/src/agent/
  loop.ts              our agent loop: dispatch, approval gate, memory, audit
  tools/               Zod schemas, provider-agnostic
  providers/
    types.ts           LlmProvider interface
    anthropic.ts       @anthropic-ai/sdk
    gemini.ts          @google/genai
    index.ts           factory on LLM_PROVIDER
```

```ts
export interface LlmProvider {
  name: string;
  complete(request: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
    responseSchema?: JsonSchema;
  }): Promise<{
    text: string;
    toolCalls: ToolCall[];
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  }>;
}
```

```bash
LLM_PROVIDER=            # anthropic | gemini
LLM_MODEL=               # model id — never hardcoded
LLM_API_KEY=             # from Secrets Manager
LLM_FALLBACK_PROVIDER=   # optional
```

Provider-specific capabilities (prompt caching shape, adaptive thinking, effort
levels) stay behind the adapter and degrade to no-ops where unsupported.

**Provider selection is an empirical question, not a price question.** A model
that misreads a passport number is not cheaper. Building the intake eval set
(§10) and running both providers against it is a first-class task in the
implementation plan, not a follow-up.

### Tools

| Read — run automatically | Write — staged for approval |
|---|---|
| `search_cases` | `create_case` |
| `get_case` | `update_case` |
| `find_traveller` | `add_line_item` |
| `get_country_checklist` | `set_custody` |
| `list_partners` | `set_billing` |
| `aggregate` | `remember` / `forget` |
| `recall` | |

Write tools do not touch the database. They return a proposed change; the loop
parks it and the UI renders a diff card with Approve / Edit / Discard. Approval
is what invokes the domain function. This is AX Principle 3 enforced as a code
invariant rather than a prompt instruction, and it is covered by a test that
asserts no write tool can reach the database without an approval token.

`aggregate` computes in code and returns numbers. The model never holds the
ledger in context.

### Capabilities

**Intake.** Staff paste WhatsApp text, an email, or passport MRZ. The agent
extracts, resolves against existing travellers and partners, checks the country
checklist, and plays back a schema-valid draft case for approval.

**Watchdog.** Nightly EventBridge cron. **Detection is deterministic code**, not
LLM — running an LLM over 7,000 rows nightly would be expensive and
non-reproducible. The model only writes the human sentence and ranks the day's
list: one call per day.

| Rule id | Condition | Default |
|---|---|---|
| `custody_held` | custody `WITH_RGS`, `custodySince` older than N | 7 days |
| `case_quiet` | `SUBMITTED`, no event for N | 5 days |
| `appointment_docs` | `appointmentDate` tomorrow, checklist incomplete | — |
| `courier_unconfirmed` | custody `IN_TRANSIT` longer than N | 4 days |
| `duplicate_passport` | same passport on a second open case | — |
| `billing_overdue` | `BILL_SENT` older than N | 30 days |

Thresholds resolve as `case.watchdogOverrides[rule] ?? tenant default`
(`TENANT#<t>#CONFIG / WATCHDOG`). A case may also mute individual rules
(`mutedRules[]`) or snooze entirely (`snoozedUntil`). Muting and snoozing
require a reason and write an audit event — nothing goes quiet without a trace.
This exists because legitimately parked files (embassy backlogs, partner
delays) should not generate noise nightly.

**Ask-the-ledger.** Natural-language query over the CRM. Every answer states the
filter it used and links the underlying cases.

**Checklist.** `COUNTRY#<iso2>` profiles seeded from the 81 Drive folders.
Answers what is missing on a file and drafts the chase message. Drafts are
editable and never auto-sent.

### Memory

Three scopes — `ORG`, `PARTNER#<id>`, `USER#<email>` — each row carrying its
text, the case that taught it, and who created it. A Memory screen lists them,
editable and deletable. The agent proposes memories through the `remember`
write tool: staged and confirmed like any other write, never silently absorbed.

### Trust ladder

`trustLevel` on `TENANT#<t>#CRM_USER#<email> / PREFS`, advanced by
confirmed-without-edit approvals.

| Level | Behaviour |
|---|---|
| 0 | Every write staged. Full reasoning shown. Every tool call visible. |
| 1 | Reasoning collapsed to one line. Writes still staged. |
| 2 | Low-stakes writes auto-apply with undo. High-stakes always staged. |

Level 2 is opt-in per user. Anything touching money, outcome, or deletion is
staged at every level.

---

## 8. UI

Five screens under `/crm/*`, with the agent panel persistent across all of them.

| Screen | Purpose |
|---|---|
| **Ledger** | Dense table, one row per applicant, saved filters, inline edit, keyboard navigation |
| **Case** | Group view: shared fields once, applicants below, three axes, line items, notes, timeline |
| **Today** | Ranked watchdog nudges, each with a one-click action |
| **Partners** | 257 agencies, alias management, volume and revenue, open files |
| **Memory** | What the agent remembers, by scope, editable |

The Ledger is deliberately Excel-shaped. The main adoption risk is not technical
but behavioural: staff abandoning the tool and reopening the sheet. Day one
should feel like their sheet with a brain attached.

Per the AX Handbook's "generative within guardrails": navigation and the ledger
table stay fixed — they are used hundreds of times a month and muscle memory
matters. The agent panel and the case detail adapt to context.

The agent panel is a persistent side panel, not a modal, and inherits the
context of whatever is on screen.

---

## 9. Migration

A re-runnable, idempotent script keyed on REF NO. Three passes.

**Pass 1 — deterministic.** The §6 mapping tables as pure functions.
Expect roughly 85% of rows through clean.

**Pass 2 — LLM for the residue.** Only rows pass 1 could not resolve.
Structured output with a confidence score; ≥0.9 auto-applies, below goes to
review.

**Pass 3 — human review queue.** A screen listing every uncertain row beside its
original, with bulk-approve for repeated patterns. This is where the
column-shift junk, the 2006 row, and the 11 `duplicate entry` rows are settled.

Rules that hold throughout:

- Every record keeps `sourceRow` and `sourceSheet`. Any value traces back.
- Nothing is discarded. Unmappable data lands in `legacyRaw`.
- Phone numbers are recovered from `2025 YEAR` by REF NO join, since `Mini CRM`
  dropped that column.
- Group detection: same partner + country + received date + adjacent REF NO
  numbers are proposed as one case, and proposed groupings are reviewed, not
  auto-applied.

Run repeatedly against staging until the review queue is boring.

---

## 10. Testing

| Layer | Approach |
|---|---|
| Normalizers | Vitest, table-driven, fed the actual 166 / 34 / 27 / 30 distinct values from the workbook |
| Status machines | All three axes: legal transitions pass, illegal ones rejected |
| Domain | Vitest against the existing in-memory `TableClient` |
| Tools | Each tool tested directly, no model in the loop |
| **Approval gate** | Assert no write tool reaches the database without an approval token. Provider-agnostic, so it survives a provider swap |
| Watchdog | Fixture ledger with known-bad cases; assert exactly which nudges fire, including override, mute, and snooze behaviour |
| Agent intake | Eval set of ~50 real pastes collected during the pilot, scored per provider |

Existing repo gates apply: `pnpm -r typecheck`,
`pnpm --filter @rgs/shared test`, `pnpm --filter @rgs/api test`,
`pnpm --filter @rgs/admin build`.

---

## 11. Multi-tenancy

Every CRM key carries a `TENANT#<id>` segment and every domain function takes a
tenant context from day one. RGS is tenant `rgs`.

No tenant signup, no tenant-management UI, no subscription billing in v1 — and
no retrofit later either. This is the cheapest available hedge on the
sell-it-later plan.

---

## 12. Error handling

- **Provider unavailable** → the agent panel shows a plain error and the CRM
  remains fully usable by hand. The CRM never requires the LLM to function.
- **Tool throws** → returned to the model as a tool error; the agent recovers or
  escalates to the human (AX Principle 6, *Loop In Other Experts*).
- **Migration partial failure** → resumable, with no half-imported cases.
- **Every agent write** lands in the case timeline attributed to `agent`, with
  the prompt that caused it.

---

## 13. AX Handbook mapping

The handbook (`AX: The Rise of Agentic Experience`, Issue 02) is the design
reference for this product. Where its patterns land:

| Pattern / Principle | Where |
|---|---|
| Intent Handshake | Intake plays back a full draft before anything is saved |
| Confidence Cues | Every answer cites its filter and links its cases; migration carries confidence scores |
| Adaptive Canvas | Fixed nav and ledger; adaptive agent panel and case detail |
| Escape Hatch | Staged writes, undo at trust level 2, per-case mute and snooze |
| Memory in Motion | Three memory scopes, visible and editable on their own screen |
| Generative Momentum | Agent drafts the case, the chase message, the nudge text |
| Transparency Tapered | The trust ladder |
| Clarify Before You Commit | The approval gate, enforced in code |
| Loop In Other Experts | Tool errors escalate to the human |
| Learn Context, Build Memory | Memory proposed via a staged write tool, never silently |

On the AX Evolution Curve this targets **Task-Aware**, reaching toward
**Personally Intelligent** as memory accumulates. Socially Embedded is not a v1
goal — the handbook is explicit that the levels cannot be skipped.

---

## 14. Deferred

Partner and traveller logins · WhatsApp and email ingestion · payment collection
· invoice PDFs · tenant signup and subscription billing · rate cards and credit
terms per partner · mobile app · embassy appointment automation.
