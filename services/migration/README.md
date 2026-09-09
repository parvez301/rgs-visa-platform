# @rgs/migration

A one-off importer that reads the legacy "CRM - RAYS GLOBAL SERVICES.xlsx"
workbook (the "Mini CRM" and "2025 YEAR" sheets) and writes the CRM domain
records — cases, partners, travellers, and a human review queue for anything
that couldn't be mapped deterministically — into the same DynamoDB table the
deployed API uses.

It is **not part of the deployed stack**. It is run by hand, once (and then
again, harmlessly, whenever the live sheet changes before cutover — see
"Idempotency" below).

## Why this is a separate package

`services/api` is bundled into a Lambda. This package depends on `exceljs`
(a large library for reading `.xlsx` files) purely to parse the workbook —
that dependency must never end up in the Lambda bundle. Keeping the importer
in its own workspace package, rather than adding it to `services/api`, is
what guarantees that: `services/api` takes no new runtime dependency for
this, and nothing here is ever `import`ed by Lambda code.

## Pipeline

```
readWorkbook  → mapRow (per row) → joinPhones + proposeGroups → residueResolver → runImport
```

- `readWorkbook` parses both sheets into raw, positionally-read rows.
- `mapRow` turns each "Mini CRM" row into a `MappedCaseDraft` plus any
  pass-1 review items (a value was present but couldn't be understood).
- `joinPhones` recovers phone/tracking-number data from "2025 YEAR" by REF
  NO join.
- `proposeGroups` finds adjacent REF NOs that share partner/country/received
  date and proposes them as one case, for a human to confirm — never
  auto-merged.
- `residueResolver` is the pass-2 seam. This plan ships only
  `passthroughResidueResolver` (always defers to review); Plan 4 supplies the
  real LLM-backed resolver behind the same interface.
- `runImport` (`src/importRun.ts`) does the actual writing: resolves/creates
  partners and travellers, writes cases straight through `caseStore` (never
  through the derived-status transition functions — a migrated case must not
  be dragged by rules meant for cases created through the app), and records
  every review item.

## The dry-run default

**The CLI defaults to a dry run.** `--commit` is required to write anything.
This points at a real DynamoDB table — the same one the deployed API reads
and writes — and a mistyped invocation (wrong `--tenant`, wrong `--workbook`)
must print what it *would* do, never actually do it.

A dry run still exercises every read path (it needs to know what already
exists, to report accurate reuse/skip counts), so it still requires the same
environment the production Lambda does — see below.

## Running it

The CLI reuses the exact same `AppContext` construction the Lambda handler
uses (`buildProductionContext` in `services/api/src/http/handler.ts`), so it
needs the same four environment variables:

```bash
export TABLE_NAME=...
export DOCUMENTS_BUCKET=...
export EMAIL_SENDER=...
export ADMIN_NOTIFICATION_EMAIL=...
```

Rehearse (dry run — nothing is written):

```bash
pnpm --filter @rgs/migration run import --workbook "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx"
```

Commit for real:

```bash
pnpm --filter @rgs/migration run import --workbook "/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx" --commit
```

`--tenant` defaults to `rgs`; `--actor` defaults to `migration@rgs.local` and
is recorded as `createdByEmail` on every case. Pass either to override.

**Say `run` explicitly.** `pnpm --filter @rgs/migration import` (without
`run`) is *not* a shorthand for this script — `import` is one of pnpm's own
built-in commands (for importing another lockfile), so pnpm intercepts it
before it ever reaches `package.json` and fails with an unrelated "Unknown
option: 'recursive'" error. Measured directly against this pnpm version;
`run import` is the form that actually works.

## Idempotency

The sheet is **live** — re-running the same command is the expected case,
not the exception, right up until cutover. `runImport` is idempotent:
already-imported cases are skipped by `caseRef` (sweeping every case status,
since `caseRef` carries no index yet), partners and travellers are
found-or-created rather than duplicated, and a `PROPOSED_GROUP` review item
is only (re-)recorded when it has actually changed. A second run against an
unchanged sheet creates nothing. This is asserted directly, at full scale,
by `test/fullWorkbook.test.ts`.

## The full-workbook rehearsal test

`test/fullWorkbook.test.ts` runs the real 7,156-row workbook through the
whole pipeline (not a fixture) and asserts the review-queue rate lands in
the expected band, the known-bad rows (month dividers, blank cells) are
handled correctly, and a second run is fully idempotent. The workbook lives
outside the repo at `/Users/parvez/Downloads/CRM - RAYS GLOBAL SERVICES.xlsx`
— CI has no copy, so this suite **skips** (loudly, naming the expected path)
rather than fails when the file is absent. Run it locally with the file in
place to actually exercise it:

```bash
pnpm --filter @rgs/migration test
```

## The Excel epoch

`src/excelSerial.ts` hardcodes the 1900 date system's epoch
(`1899-12-30`) as `EXCEL_EPOCH_UTC`. This was **determined empirically**, by
finding one REF NO recorded on both sheets and converting a serial date on
one against the equivalent text date on the other. Do not change this value
without re-running that cross-sheet check — the 1904 system produces a date
five years off with no crash to warn you.
