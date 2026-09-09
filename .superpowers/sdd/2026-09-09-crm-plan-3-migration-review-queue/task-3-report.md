# Task 3 report — review-queue domain module

**Status:** complete. All gates green.

## Files

- Created `services/api/src/domain/crm/reviewQueue.ts`
- Created `services/api/test/crm/reviewQueue.test.ts` (18 tests)

## Corrections applied over the brief

1. **`REVIEW_ITEM_SORT_KEY`, not `CASE_META_SORT_KEY`.** The module imports
   `REVIEW_ITEM_SORT_KEY`, `reviewItemPartitionKey` and `reviewQueueGsi1Pk` from
   `./keys` and writes no key literal of its own — the guard in `keys.test.ts`
   ("is the only CRM domain file that writes a key literal") covers this file
   and still passes.
2. **`listReviewItems` returns `{ reviewItems, unreadableReviewItemIds }`.** It
   mirrors `listPartners` / `loadCasesFromMetaItems` exactly: `parseStoredReviewItem`
   converts a `ZodError` into a `CorruptRecordError` (409, `CORRUPT_RECORD`), the
   loop catches only that, pushes `error.recordId`, `console.warn`s with the id,
   the tenant and the failing field, and carries on. Every other error still
   propagates. No third pattern was invented.
3. **Every rejection is a typed `ApiError`.** `notFound` on a miss (also for a
   miss under another tenant, since the partition key is tenant-scoped),
   `conflict` on resolving an item that is not `OPEN`, `corruptRecord` on a
   stored row that will not parse. No bare `Error` and no raw `ZodError` escapes.

## Other decisions

- One private `writeReviewItem` is the only path to storage, so `GSI1PK` is
  derived from the item's own `reviewStatus` on **every** write. That is what
  moves a resolved item out of the `OPEN` partition. `GSI1SK` stays `createdAt`
  (not `resolvedAt`) so a resolved item keeps its import-order position.
- Times come from `context.now()`; ids from `newId("rev", context.now().getTime())`.
  No `new Date()` / `Date.now()`.
- Optional fields are conditionally spread, never assigned `undefined` —
  DynamoDB rejects an undefined attribute value, and a key that merely exists
  renders as an empty suggestion on the review screen. There is a test for it.
- `ReviewItemResolution` was extracted as a named exported interface rather than
  left inline, so Task 4's route handler can name the shape it parses into.

## Proof the tests can fail

Each mutation was applied to the source, the suite run, and the source restored:

| Mutation | Result |
|---|---|
| Removed the per-item `try/catch` in `listReviewItems` | **3 red** — "still lists the healthy items…", "warns with the id…", "keeps listing when every row… is corrupt" |
| Removed the `conflict` guard on a non-`OPEN` item | **1 red** — "refuses to resolve the same item twice with a 409" |
| Froze `GSI1PK` at `OPEN` instead of following the status | **2 red** — "lists only the requested status", "moves an item out of the OPEN partition when it is resolved" |
| Removed `throw notFound("Review item")` | **3 red** — both 404 tests and "does not read another tenant's item by id" |

Every rejection test asserts `statusCode` (and `code`) via `rejects.toMatchObject`,
not a bare `rejects.toThrow()`.

## Gates

- `pnpm --filter @rgs/api test` — 225 passed (baseline 207 + 18 new)
- `pnpm --filter @rgs/shared test` — 189 passed (unchanged)
- `pnpm -r typecheck` — clean across all 7 projects

## Out of scope, as instructed

No HTTP routes were added — that is Task 4. `listReviewItems`' new return shape
means the Task 4 handler must read `.reviewItems` and should surface
`unreadableReviewItemIds` to the screen rather than drop it.
