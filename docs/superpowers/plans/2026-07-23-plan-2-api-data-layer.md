# RGS Platform — Plan 2: DynamoDB Data Layer + Lambda API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `services/api` — the Lambda-hosted HTTP API both portals consume: applications CRUD + wizard autosave, document presign/review, status machine transitions, admin queue, activity feed, and leads.

**Architecture:** Ports-and-adapters. Domain modules are pure functions over three injected ports — `TableClient` (DynamoDB single-table), `DocumentStore` (S3 presign), `EmailSender` (SES). Unit tests run against in-memory implementations; real adapters are thin AWS SDK wrappers exercised in staging E2E (Plan 3). One Lambda handler per audience (`userApiHandler`, `adminApiHandler`) sharing a tiny router.

**Tech Stack:** TypeScript strict, Zod, Vitest, `@aws-sdk/client-dynamodb` + `lib-dynamodb`, `client-s3` + `s3-request-presigner`, `client-ses`, `@types/aws-lambda`.

## Global Constraints

- Same as Plan 1 (strict TS, descriptive names, status/payment enums verbatim from spec).
- Domain modules never import AWS SDK — only ports.
- Every state change writes an ActivityEvent; no PII in event meta (ids only).
- Users can only read/write `USER#<own id>` rows; admin routes live in a separate handler wired to the admin Cognito pool authorizer (Plan 3).
- Presigned URLs: 15-minute expiry, content-type constrained, keys scoped `applications/<appId>/traveller-<idx>/<docType>`.

## Key scheme (table `rgs-platform`)

| Item | PK | SK | GSI1 (status queue) | GSI2 (user activity) | GSI3 (app lookup) |
|---|---|---|---|---|---|
| User | `USER#<id>` | `PROFILE` | — | — | — |
| Application | `USER#<id>` | `APP#<id>` | `STATUS#<status>` / `<updatedAt>` | — | `APP#<id>` / `A` |
| Document | `APP#<id>` | `DOC#<type>#<idx>` | — | — | — |
| ActivityEvent | `EVENT#<yyyy-mm-dd>` | `<ts>#<id>` | — | `USER#<id>` / `<ts>` | — |
| Lead | `LEAD#<id>` | `PROFILE` | `STATUS#LEAD_NEW` / `<createdAt>` | — | — |

## Tasks

1. **Scaffold + ports + in-memory adapters** — `lib/db.ts` (`TableClient`: get/put/query/queryGsi/delete), `lib/documentStore.ts`, `lib/email.ts`, `lib/ids.ts` (time-sortable ids), `lib/errors.ts` (`ApiError(status, code, message)`).
2. **Applications domain** — `createDraft(userId, countryCode)` (prices from catalog), `patchDraft` (travellers/essentials/stepReached, DRAFT-only), `getApplication` (owner check), `listMyApplications`, `submitApplication` (essentials + per-traveller required docs present → transition DRAFT→SUBMITTED, event, email).
3. **Documents domain** — `presignUpload` (type-checked against country checklist, owner check), `recordUpload` (PENDING), `presignDownload`, `reviewDocument` (admin approve / reject+reason, event, email on reject).
4. **Transitions + admin domain** — `transitionApplication(appId, toStatus, actor, meta)` guarded by shared `assertTransition` + all-docs-approved guard for `SUBMITTED→DOCS_VERIFIED`; `setPaymentStatus` (UNPAID→REQUESTED→PAID_OFFLINE); `listApplicationsByStatus`, `getApplicationDetailForAdmin`, `addInternalNote`, `uploadVisaResult`; activity feed `listRecentActivity(date range)`; abandoned-drafts query.
5. **Leads domain** — `createLead` (name/phone/topic/message → Lead item + LEAD_CREATED event + email to info@).
6. **HTTP layer** — router with Zod-validated bodies, error→problem-JSON mapping, `userApiHandler` routes (`POST /applications`, `PATCH /applications/{id}`, `POST /applications/{id}/submit`, `GET /applications`, `GET /applications/{id}`, `POST /applications/{id}/documents/presign`, `POST /applications/{id}/documents`, `GET /documents/download`, `POST /leads`) and `adminApiHandler` routes (`GET /admin/applications?status=`, `GET /admin/applications/{id}`, `POST /admin/applications/{id}/transition`, `POST /admin/applications/{id}/payment`, `POST /admin/documents/review`, `POST /admin/applications/{id}/notes`, `GET /admin/activity`).

Each task: failing Vitest first, implement, green, commit.
