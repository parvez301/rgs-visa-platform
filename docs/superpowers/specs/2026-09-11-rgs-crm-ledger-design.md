# RGS CRM — Ledger, Case and the agent panel

**Parent spec:** `docs/superpowers/specs/2026-09-09-rgs-crm-design.md`. That document is the
binding authority; this one deepens its §8 (UI) into something a plan can be written from.
Where the two disagree, the parent wins — except where this document says otherwise and gives
a reason.

**Status:** approved 2026-09-11. Backend for everything below is built and merged to `main`
(Plans 1–4, `149480d`).

---

## 1. What this covers

The first buildable slice of the CRM's interface: the **Ledger**, the **Case** screen, and the
**persistent agent panel** that sits beside both.

**Out of scope, deliberately:** the Today, Partners and Memory screens; the watchdog detection
engine; mobile layout; end-to-end browser testing. Each is named again in §11.

### The decision this design rests on

The parent spec says the Ledger is "deliberately Excel-shaped" and that the real adoption risk
is behavioural — staff quietly reopening the sheet. Two readings follow from that, and the
owner chose the first: **the Ledger is the app.** A desk agent lives on that one screen; Case
is a drill-down; the agent assists from the side. Today-as-home was considered and rejected for
this slice because it asks RGS to change how they work on day one.

---

## 2. Where it lives

`apps/admin`, under a new `apps/admin/src/crm/` directory, routed at `/crm/*`.

The host app already provides React 19, Vite, Tailwind 4, react-router, TanStack Query, Cognito
auth and `@rgs/shared`. No second application, no second login, no new auth surface. The CRM
directory stays separate from the existing visa-platform pages (`ActivityPage`, `QueuePage`,
etc.) so neither bleeds into the other.

**The backend needs one new read model — see §2.1.** Everything else consumed here exists today:

| Need | Route |
|---|---|
| Ledger rows | `GET /api/v1/admin/crm/cases`, `GET .../cases/by-partner/{partnerId}` |
| Case detail | `GET /api/v1/admin/crm/cases/{caseId}` |
| Case timeline | `GET .../cases/{caseId}/events` |
| The four axes | `PUT .../cases/{caseId}/status`, `.../applicants/{applicantRef}/custody`, `.../applicants/{applicantRef}/outcome`, `.../cases/{caseId}/billing` |
| Partner names | `GET /api/v1/admin/crm/partners` |
| Traveller lookup | `GET .../travellers/by-name/{fullName}`, `.../travellers/by-passport/{passportNumber}` |
| Import review | `GET /api/v1/admin/crm/review`, `GET .../review/{reviewItemId}`, `POST .../review/{reviewItemId}/resolve` |
| Agent | `POST .../agent/turn`, `GET .../agent/proposals`, `POST .../proposals/{proposalId}/approve`, `POST .../proposals/{proposalId}/discard`, `GET/POST/DELETE .../agent/memories` |

### 2.1 The Ledger read model — the one piece of backend work in this slice

**The Ledger cannot be built on the cases API as it stands**, and this was established by
reading the code rather than assumed:

- `GET /crm/cases?status=X` calls `listCasesByStatus(context, tenantId, status)`, whose `limit`
  defaults to **50**. One status at a time, newest-`updatedAt` first. There is no all-cases
  query, no cursor, no sort control and no text search.
- `loadCasesFromMetaItems` calls `readCase` **per case** — a full partition read each. A
  faithful listing of 7,156 cases is 7,156 partition reads.

What already exists to build on, which makes this small rather than large:

- `writeCase` destructures `{ applicants, ...caseBody }` and puts `caseBody` on the META item.
  **Every case-level column the Ledger shows is already on that one item**, reachable from GSI1
  with no per-case assembly at all.
- GSI1 partitions cases by `caseStatus` sorted by `updatedAt`; GSI2 partitions by `partnerId`
  sorted by `receivedDate`.
- `DynamoTableClient.runQuery` drains pages, so an unbounded query returns a whole partition
  rather than silently truncating it.

Three things to build:

1. **An applicant summary on the META item.**
   `applicantSummary: { count: number; custody: Record<CustodyStatus, number>; outcome: Record<ApplicantOutcome, number> }`,
   computed **inside `writeCase`** from the `applicants` array it already holds.

   This is safe by construction and that is why it is the chosen design: every mutator —
   `changeApplicantCustody`, `changeApplicantOutcome`, `changeCaseStatus`,
   `changeBillingStatus` — reassembles the whole case and calls `writeCase`. There is exactly
   one place the summary can be computed and no way to persist a case without going through it.
   Pinned by a test that changes one applicant's custody and asserts the META summary moved;
   that test must go red if the computation is removed.

2. **A row projection and its route.** `GET /api/v1/admin/crm/cases/ledger`, reading GSI1 META
   items directly and projecting only the Ledger's columns — never `legacyRaw`, never
   `lineItems`. Roughly 1.4 MB for 7,156 rows, against 7–21 MB for full case records.
   Parameters: `status` (repeatable, default all nine), `partnerId` (GSI2), `sort`
   (`receivedDate` | `updatedAt`, asc/desc), `limit`, `cursor`.

3. **Full case detail stays where it is.** `GET /cases/{caseId}` is the drill-down read; the
   Ledger never asks for a whole case.

**Where filtering happens, decided here rather than left to the plan:** server-side for
predicates an index can answer — status, partner, and the two sort keys. Client-side over the
loaded window for everything else — destination country, case type, and text matching on
`caseRef` or traveller name. Anything else server-side would be a table scan.

---

## 3. Design language

Notion's brand tokens, published as a Tailwind theme extension in
`apps/admin/src/crm/theme.css`. Values are literal and not to be improvised on:

| Token | Value | Use |
|---|---|---|
| `--crm-canvas` | `#ffffff` | Row background |
| `--crm-surface` | `#f6f5f4` | Table header, panel background |
| `--crm-ink` | `#1a1a1a` | Primary text |
| `--crm-charcoal` | `#37352f` | Emphasis text |
| `--crm-steel` | `#787671` | Secondary/tertiary text, inert chips |
| `--crm-rule-row` | `#ede9e4` | Row bottom border (hairline) |
| `--crm-rule-box` | `#e5e3df` | Container borders |
| `--crm-primary` | `#5645d4` | **Reserved — see below** |
| `--crm-link` | `#0075de` | Inline links only, never a button |

Radii: 4px chips, 6px badges, 8px buttons and inputs, 12px cards. Spacing on a 4px base,
8px primary increment.

### Two departures from the fetched Notion system, with reasons

The `DESIGN.md` fetched from the design-md collection describes Notion's **marketing site** —
hero bands, pricing tiers, an 80px display scale — and explicitly carries no guidance on table
rows, inline editing, hover, selection or dense database views. Its brand language is used;
its type scale is not.

1. **Body type is 14px / 1.45, not 16px / 1.55.** Row height is 32px. A desk agent must see
   ~30 cases without scrolling. Notion's own database rows run at this density; only its
   marketing pages run at 16/1.55.
2. **Buttons are 8px rectangles, never pills** — this one is kept from the doc verbatim, and
   is called out because it is the easiest thing to get wrong by habit.

### The purple rule

`--crm-primary` (`#5645d4`) appears on exactly one control in the entire product: **Approve**
on an agent proposal card. Notion reserves purple for the dominant action; in this product the
most consequential action a human takes is authorizing the agent to write to a real client's
case. Nothing else competes for that colour — not Save, not Create Case, not Resolve.

### The four axes as property chips

The pastel tints exist to echo database properties, which is exactly what the four state axes
are. The mapping is principled, not per-value taste:

| Axis | Rule | Values |
|---|---|---|
| `caseStatus` | live → lavender `#e6e0f5`; decided → mint `#d9f3e1`; abandoned → rose `#fde0ec`; inert → steel | `LIVE_CASE_STATUSES` / `DECIDED` / `NOT_SUBMITTED`,`WITHDRAWN`,`DUPLICATE` / `CLOSED` |
| `custody` | RGS holds something → peach `#ffe8d4`; in motion → yellow `#f9e79f`; settled → mint; nothing held → steel | `WITH_RGS`,`AT_EMBASSY` / `IN_TRANSIT` / `RETURNED` / `NOT_HELD` |
| `outcome` | good → mint; bad → rose; needs action → yellow; waiting → steel | `APPROVED` / `REJECTED` / `SENT_BACK` / `PENDING` |
| `billingStatus` | paid → mint; owed → yellow; partial → peach; written off → rose; unbilled → steel | `PAID` / `BILL_SENT` / `PART_PAID` / `WRITTEN_OFF` / `UNBILLED` |

**`billingStatus: "UNKNOWN"` renders steel with a dashed border.** It is not a state the
business chose; it is what the importer wrote when it could not read the sheet. Making data
debt visibly different from a real value is deliberate — the parent spec's §9 asks 7 questions
of RGS about exactly this kind of row, and those rows should look unresolved.

---

## 4. The Ledger

### Rows

**One row per case; applicants nest beneath it** as sub-rows, collapsed by default, disclosed
by a `▸` affordance on the REF cell. Case-level fields are therefore edited once, in one place,
with no ambiguity about which sibling row owns them.

This is the one place this design knowingly does *not* match their sheet, which repeats case
fields down every applicant row. The mitigation is that **the collapsed parent must carry
enough per-applicant signal that expanding is rarely needed**:

- an applicant count
- a custody roll-up chip reading e.g. `2 at embassy · 1 with us`, or the single custody value
  when all applicants agree
- an outcome roll-up on the same rule

Both roll-ups are served by the `applicantSummary` on the META item (§2.1); the collapsed row
never reads applicant records.

**Display labels are a single map, defined once** and reviewable by RGS in their own words:
`NOT_HELD` → "Not held", `WITH_RGS` → "With us", `AT_EMBASSY` → "At embassy", `IN_TRANSIT` →
"In transit", `RETURNED` → "Returned". Enum values are never shown raw in the interface, and
the map is the only place a wording change has to be made.

If this proves insufficient in front of RGS, a "flatten" view that repeats case fields down
applicant rows is a **view option, not a rewrite** — the column model already supports it.

### Columns

Case row, left to right. REF is sticky; the header is sticky.

`caseRef` · partner canonical name · `destinationCountry` · `caseType` (with `visaType` when
present) · applicants (count + custody roll-up) · `caseStatus` · `billingStatus` ·
`receivedDate` · `appointmentDate` · `totalInr`.

Applicant sub-row: traveller name · `passportNumber` · `custody` · `outcome` ·
`courierMode` + `trackingNumber`.

### Scale

7,156 cases from the real import. Rows are **virtualized** (TanStack Virtual) over a windowed
range, fed by the projection route in §2.1. The split between server-side and client-side
filtering is fixed there, not left to the implementer.

### Keyboard

Fixed, and never adaptive. Per the AX Handbook's "generative within guardrails": navigation and
the ledger grid are used hundreds of times a month and muscle memory is the point.

| Key | Action |
|---|---|
| `↑` `↓` `←` `→` | Move the focused cell |
| `Enter` | Begin editing the focused cell |
| `Esc` | Cancel the edit, restore the previous value |
| `Cmd/Ctrl+Enter` | Commit and stay |
| `Space` | Toggle row selection |
| `Shift+Click` / `Shift+↑↓` | Extend selection |
| `→` on a collapsed parent | Expand applicants |
| `←` on an expanded parent | Collapse |

### Inline editing

Commit on blur, optimistic update, **undo toast**. The toast is the AX Escape Hatch and is not
optional: a desk agent editing the wrong row of 7,156 must be able to take it back without
knowing what a case id is.

Direct human edits go straight to the REST routes and are **not** staged behind the approval
gate. The gate exists to govern what the *agent* writes; requiring a human to approve their own
click would be ceremony without safety.

### Views

Saved filters render as a Notion-style chip bar above the table. A view is a named set of
column filters plus a sort. Views are per-user.

---

## 5. The Case screen

Group view, reached by clicking a REF. Shared case fields once at the top; applicants below as
a small table carrying the two per-applicant axes; line items with `totalInr`; notes; and the
timeline from `GET .../cases/{caseId}/events`.

The timeline is the audit surface. `PROPOSAL_APPROVED` events carry `meta.autoApplied`, and an
auto-applied change **must render visibly differently from a human-approved one** — the backend
went to some trouble to keep that distinction truthful and the UI must not flatten it.

---

## 6. The agent panel

A persistent right-hand panel on both screens. Resizable, collapsible, **never a modal**. It
inherits the current screen and the current selection.

Four AX patterns are rendered concretely rather than gestured at:

- **Intent Handshake** — before acting, the agent plays back the goal and the gameplan and
  asks. This is the proposal card, and it comes before any write.
- **Confidence Cues** — why it concluded what it did, and which remembered facts it used. Each
  cited memory is clickable and deletable in place (Memory in Motion; the Memory screen itself
  is a later slice, but a memory must be killable from where it is cited).
- **Escape Hatch** — Discard on every proposal; undo on every applied change.
- **Generative Momentum** — the agent takes the first stab and the human shapes it. Proposal
  cards are editable before approval; the backend already supports `editedInput`, and an edited
  approval rebuilds its own audit summary from the edit.

The panel also shows the **trust level** and states plainly that auto-apply is off. Per the
parent spec the ladder is never climbed silently; the backend has no production writer for
`setUserPrefs` today, which means this indicator reads "level 0, auto-apply off" and is honest.

### Selection-aware bulk action, and its real shape

"Mark these 12 as issued" operates on the current selection. **The backend has no bulk write
tool** — there are five write tools (`create_case`, `update_case`, `add_line_item`,
`set_custody`, `set_billing`), none takes a list, and approval is one `POST` per `proposalId`.

A bulk tool is deliberately **not** being added. The agent makes N proposals in one turn (the
loop caps iterations, not calls per iteration), and the panel groups them into **one card over
N proposals**, approving them with N calls. Two reasons: no backend change, and each case keeps
its own `PROPOSAL_APPROVED` event, which is a better audit trail for a business billing real
clients than one record covering twelve.

**Partial failure is therefore a real state and must be reported per item** — "9 applied, 3
failed, here they are" — never summarized as success. This is the same observe-don't-infer rule
the backend follows.

---

## 7. Import review, surfaced in the Ledger

The import produced **3,958 review items and 1,480 merge proposals** from the real workbook, and
has no interface at all. Until it does, RGS cannot clean their own data through the product.

This slice does **not** add a sixth screen for it. Instead:

- a case that arrived with unresolved review items carries a marker on its row
- the marker opens the items inline, each resolvable in place via
  `POST .../review/{reviewItemId}/resolve`
- a case with a merge candidate is marked distinctly from one with a field-level problem

Rationale: the data is already in the Ledger, so cleaning it becomes ordinary daily work rather
than a separate chore nobody schedules. Bulk merge resolution, if it turns out to be needed, is
a later decision.

---

## 8. Data flow

TanStack Query throughout. Inline edits are optimistic with rollback on failure.

### The transcript contract

`POST .../agent/turn` replays prior `conversation`, and the route validates pairing strictly:

- an assistant turn that made calls **must** carry them in `toolCalls`
- a `tool_result` **must** name a `toolCallId` that the immediately preceding assistant message
  carries
- ids are capped at 256 characters and count toward the conversation cost bound
- an assistant message must carry text, tool calls, or both

**The panel must keep its transcript in exactly this shape.** A client that drops the assistant
turn reproduces the exact defect (C1) that made the agent unusable against both real providers
before it was found at branch review. The plan must include a test that drives the panel's own
transcript state through the route and asserts the pairing holds — not a test that asserts the
panel renders.

---

## 9. Error handling

- Every write: optimistic, rollback on failure, visible undo.
- `409` conflict (the row changed underneath) shows **both values and asks**. It never picks.
- Partial bulk failure is reported per item.
- A failed agent turn shows what the agent was attempting when it failed, not a bare error.

---

## 10. Testing

Vitest + Testing Library, in the house style already established across four plans:

**A test that cannot tell is a defect.** Two traps specific to this slice, to be written into
the plan as named requirements:

1. **Virtualization makes vacuous assertions easy.** A query for a row that was never rendered
   passes trivially. Any assertion about row content must be made against a row the virtualizer
   actually mounted, and the plan must say how that is guaranteed.
2. **Two-part claims need both halves.** "The edit is refused and nothing is written" requires
   the second half asserted separately against the request log, not inferred from the first.

Every fix to a finding must be demonstrated by a test that goes red without it.

No Playwright. There is no end-to-end infrastructure in this repo and adding it is its own
decision, not a side effect of this slice.

---

## 11. Deferred, with reasons

| Deferred | Why |
|---|---|
| Today screen | Needs the watchdog detection engine, which does not exist. The schema does (`WATCHDOG_RULE_IDS`, per-case `watchdogOverrides`, `mutedRules`), so the engine is a well-specified backend task for its own plan. |
| Partners screen | 257 agencies, alias management, volume and revenue. Real work, no adoption risk if it lands second. |
| Memory screen | Memories are citable and deletable from the agent panel in this slice, which covers the AX requirement; the dedicated browsing screen can follow. |
| Mobile | The desk is a desktop. |
| Bulk merge resolution | Depends on what §7's inline resolution reveals about how RGS actually works through the queue. |

---

## 12. Open questions for RGS, carried forward

The 7 questions in `docs/migration-questions-for-rgs.md` remain unanswered and block a clean
import, not this build. Separately, the provider eval
(`pnpm --filter @rgs/api exec tsx eval/runIntakeEval.ts --provider …`) has never been run
against a live model, so which provider RGS pays for is still undecided. Neither blocks this
slice.
