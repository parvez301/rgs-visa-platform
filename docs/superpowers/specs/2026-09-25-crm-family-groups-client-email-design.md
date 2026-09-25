# CRM: family groups, client email, vendor email automation

Date: 2026-09-25
Status: approved design, not yet implemented
Origin: owner feedback doc "SUGGESTIONS FOR CRM (2)" (2026-09-24), items 1 and 3, plus
the owner's clarification of 2026-09-25: "group name will be same, but need separate
reference numbers, separate approve/reject per person; 'Vendor' refers to B2B entity;
need email automation; email address we will manually fill up on system."

## 1. Problem

The owner's example: a family of four applies together. Staff create one group
"Sharma Family", every person keeps their own REF NO and their own approve/reject,
staff change status once for the whole family, and one email goes to the client
listing all four names and the appointment date, one email goes to the vendor.

Today's CRM (see `2026-09-09-rgs-crm-design.md`) already has one case with 1..n
applicants, each applicant with its own `outcome` (PENDING / APPROVED / REJECTED /
SENT_BACK) and `custody`. So "separate approve/reject per person" exists. What does
not exist:

- a group name on the case;
- a REF NO per person (applicants carry only the internal key `A1`, `A2`, or `1`);
- a client email address anywhere (traveller has phone only);
- a client send on status change (only the partner is emailed);
- a way to edit a partner's email after the partner is created;
- names on the case page and ledger sub-rows (the app has no route to read a
  traveller by id, ruling R45).

## 2. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | A family group **is** today's multi-applicant case. No new Group entity. | Chosen by the developer on 2026-09-25 over a Group-over-cases model. Reuses ledger, case page, state machines, status email. Cost: one `caseStatus`, one billing, one appointment date for the family. A person who drops out is marked by `outcome`, not by their own case status. |
| D2 | "Vendor" is the existing partner (`PartnerSchema`, types AGENCY / CORPORATE). No new entity. | Owner: "Vendor refers to B2B entity". The partner already carries `contactEmail` and already receives status mail. |
| D3 | Client email lives on the case as `clientEmail`, typed manually. | Owner: "email address we will manually fill up on system". One family, one client address. Traveller-level email would force a choice of which traveller for a family and re-typing per case anyway. |
| D4 | Per-person REF NO is a new optional applicant field `refNo`. `applicantRef` stays the internal key. | `applicantRef` is in URLs and the storage sort key (`APPLICANT#nn`); overloading it would touch every mutation route. Single-applicant cases leave `refNo` blank and display `caseRef`. |
| D5 | `refNo` has no uniqueness constraint, the same as `caseRef` today. | `caseRef` uniqueness is best-effort and import-only (`caseRefIndex.ts`). Fixing that is a separate piece of work. |
| D6 | Client and vendor get the same subject and body. | Owner asked for one email to each; nothing in the ask distinguishes their content. Two templates is YAGNI. |
| D7 | `GET /cases/{caseId}` returns resolved traveller names. | Names are essential on a family page. This lifts R45 on evidence (a real route) rather than inventing names client-side. |

## 3. Data model (`packages/shared/src/crm/schemas.ts`)

### 3.1 Case

Add to `CrmCaseSchema`:

```ts
groupName: z.string().trim().min(1).max(120).optional(),
clientEmail: z.string().trim().email().optional(),
```

Add `groupName` to `LedgerRowSchema` (optional). `searchText` (computed in
`caseStore.ts` `writeCase`) includes `groupName` when present so ledger search
finds "Sharma".

### 3.2 Applicant

Add to `CaseApplicantSchema`:

```ts
refNo: z.string().trim().min(1).max(40).optional(),
```

Display rule everywhere (ledger sub-rows, case page, email body): show `refNo` when
set, else `caseRef` when the case has exactly one applicant, else `applicantRef`.

### 3.3 Events

`services/api/src/domain/crm/crmEvents.ts` event type union gains `"CLIENT_NOTIFIED"`.
Payload is identical to `PARTNER_NOTIFIED`: `{channel: "email", toAddress, fromStatus, toStatus}`.

### 3.4 Migration

None. All three fields are optional. The 7,156 imported cases carry none of them and
render exactly as today.

## 4. API (`services/api/src/http/crmApi.ts` and domain)

### 4.1 Create case

`POST /api/v1/admin/crm/cases` body accepts `groupName`, `clientEmail`, and
`applicants[].refNo`. `createCase` (`domain/crm/cases.ts`) passes them through the
schema; no other validation.

### 4.2 Update case details

`UpdateCaseDetailsBody` and `updateCaseDetails` gain `groupName` and `clientEmail`.
Both are clearable: the body accepts `null` for either, and the domain deletes the
attribute. This keeps the existing rule that the body lists fields by name and never
passes through.

### 4.3 Partner contact

New route `PUT /api/v1/admin/crm/partners/{partnerId}/contact`, body:

```ts
{ contactEmail?: string | null, contactPhone?: string | null, contactWhatsapp?: string | null }
```

Domain function `updatePartnerContact(context, tenantId, partnerId, patch)` in
`domain/crm/partners.ts`: 404 when the partner does not exist, writes only the three
contact fields, returns the partner. Requires write access via the existing
`requireWrite` guard on the CRM screen.

### 4.4 Read case with names

`GET /api/v1/admin/crm/cases/{caseId}` response becomes:

```ts
{ ...crmCase, travellers: Record<travellerId, { fullName: string; passportNumber?: string }> }
```

resolved by one `get` per distinct `travellerId` (the same helper `resolveLedgerSearchText`
already uses at write time). A traveller that fails to resolve is simply absent from
the map; the UI falls back to the display rule in 3.2.

## 5. Email (`services/api/src/domain/crm/partnerStatusNotify.ts`)

Rename the module to `statusNotify.ts` and the entry point to
`notifyOnCaseStatusChange`. Call sites: `changeCaseStatus` and
`applyDerivedCaseStatusIfLegal` in `cases.ts`. Trigger is unchanged: a case-level status
change, including derived DECIDED and CLOSED. An applicant outcome change alone sends
nothing unless it flips the case status.

### 5.1 Recipients

| Recipient | Address | Skip when | Event |
|-----------|---------|-----------|-------|
| Vendor | `partner.contactEmail` | missing or blank | `PARTNER_NOTIFIED` (existing) |
| Client | `crmCase.clientEmail` | missing or blank | `CLIENT_NOTIFIED` (new) |

Each send is independent: a missing client address must not stop the vendor send and
vice versa. Each event is recorded after its own send returns, exactly as today.

### 5.2 Subject

Unchanged format `REF – STATUS – NAME – COUNTRY`. NAME is `groupName` when set,
otherwise the existing first-applicant-plus-N rule.

### 5.3 Body

Plain text, in this order:

```
Hello,

Case {caseRef} (destination {countryName}) is now {toLabel} (was {fromLabel}).

Applicants:
  {refNo or fallback} – {fullName} – {outcome label}
  ...

Appointment date: {appointmentDate as DD MMM YYYY}

— Rays Global Services
```

The "Applicants:" block appears only when the case has a group name or more than one
applicant. The appointment line appears only when `appointmentDate` is set. Names come
from the same traveller resolution as 4.4; an unresolved traveller shows
"Unnamed applicant". Outcome labels: Pending / Approved / Rejected / Sent back.

Appointment reminders (`appointmentReminders.ts`) stay vendor-only.

## 6. Admin UI (`apps/admin/src/crm`)

### 6.1 New Case form (`newCase/NewCaseDrawer.tsx`)

- "Group name" text input (optional) above the applicants list.
- "Client email" input (optional, `type="email"`) in the same section.
- Each applicant row gains an optional "REF NO" input beside full name and passport.
- Submit sends the three new fields. Case-level REF remains required as the primary
  reference.

### 6.2 Case page (`case/CasePage.tsx`)

- `CaseHeader` shows `groupName` beside the REF chip when set.
- Client email: click-to-edit inline control in the header, saving through the case
  details PUT; "Add client email" when empty.
- Partner block: `contactEmail` becomes click-to-edit inline, saving through
  `PUT /partners/{partnerId}/contact`; "Add vendor email" when empty.
- `ApplicantsTable` gains REF NO and Name columns, using the `travellers` map from
  4.4 and the display rule in 3.2. The R45 comment is replaced with a pointer to this
  spec.

### 6.3 Ledger (`ledger/`)

- REF cell renders `groupName` as a second, muted line when set.
- `ApplicantSubRows` shows `refNo` (or fallback) in place of `applicantRef`.

### 6.4 Timeline (`case/eventCopy.ts`)

`CLIENT_NOTIFIED` copy: "Client emailed at {toAddress}: {fromStatus} → {toStatus}",
mirroring the partner line. The table comment at the top of the file gains a row.

## 7. Out of scope, deliberately

- Adding or removing applicants on an existing case.
- Editing `refNo` after creation (create-only this round).
- Uniqueness of `refNo` or `caseRef`.
- Importer: `PROPOSED_GROUP` stays dismiss-only; no case merge.
- HTML or templated email; the vendor and client emails differ in nothing.
- Recording send success versus failure (tracked separately in
  memory `rgs-crm-feedback-round-1`, item 1).
- Client login or a client-facing portal.

## 8. Tests

| Package | File | Cases |
|---------|------|-------|
| shared | `test/crm/schemas.test.ts` | round-trip `groupName`, `clientEmail`, `refNo`; email format rejected; max lengths |
| shared | `test/crm/ledger.test.ts` | ledger row accepts `groupName` |
| api | `test/crm/statusNotify.test.ts` (renamed) | both sends with both events; client blank skips client only; partner blank skips partner only; subject uses group name; body lists applicants with refNo fallback and outcome; appointment line present/absent; single applicant, no group: no applicants block |
| api | `test/crm/partners.test.ts` | `updatePartnerContact` writes only contact fields, 404 unknown |
| api | `test/crm/cases.test.ts` | create stores new fields; details update sets and clears them |
| api | `test/crm/crmApi.test.ts` | new contact route wired and write-guarded; `GET /cases/{id}` returns `travellers` map |
| api | `test/crm/caseStore.test.ts` | `searchText` includes group name (note: the existing "round-trips" test counts fields and must be updated) |
| admin | `test/crm/NewCaseDrawer.test.tsx` | submits group name, client email, per-applicant refNo |
| admin | `test/crm/CasePage.test.tsx` | renders names and REF NOs; inline client and vendor email edits call the right endpoints |
| admin | `test/crm/ApplicantSubRows.test.tsx` | refNo display rule |
| admin | `test/crm/Timeline.test.tsx` or `eventCopy` tests | `CLIENT_NOTIFIED` copy |

Existing known-failing tests on main (LedgerTable column count, caseStore field count)
are pre-existing and are fixed only where this work touches the same assertion.
