# RGS Visa Platform — Design Spec

**Date:** 2026-07-23
**Status:** Approved by owner (design review in session)
**Goal:** Rebuild Rays Global Services (raysglobalservices.com) as an Atlys-style self-service visa platform: revamped marketing site, user application portal, and admin back-office. Launch with 8 countries. Deploy serverless on AWS under the `hireloop` CLI profile.

---

## 1. Background & research findings

### Atlys patterns to replicate (observed 2026-07-23, marketing site + logged-in portal)

- **Marketing**: country-card grid ("visa store") with visa type / validity / fees / docs per card; search + filters; locale-aware URLs.
- **Country landing page** (conversion machine): hero with processing-time guarantee and concrete "get visa by <date>" promise; price card separating government fee vs processing fee; "2 steps only" pitch (passport + photo upload); Trustpilot reviews; approval-chances quiz; rejection reasons; FAQ groups; official government sources cited; existing-application detection with "Resume Application" banner.
- **Application wizard**: full-screen, one question per screen, left step rail **Travelers → Docs → Essentials → Checkout**, progress %, drafts resumable, guest mode with login at checkout.
- **User account** (`/user/me`): email + phone; tabs **Purchased** vs **Ongoing** applications; ongoing shown as resume cards; post-purchase status timeline ("sent to immigration supervisor — ON TIME").

### Current raysglobalservices.com

Template brochure site (Delhi agency, 15+ years: visa assistance, study abroad, passport, attestation, insurance, ticketing, tours, FRRO). Lead form + phone only. No prices, no login, no self-service. Brand red (crimson family) in logo and CTAs.

---

## 2. Decisions (locked with owner)

| Decision | Choice |
|---|---|
| Payments v1 | **Offline / pay-later.** User submits application; admin requests payment (UPI/bank transfer) and marks it paid. No gateway. |
| Fulfillment | **Manual by admin** via existing channel partners / government portals. Status model designed so a partner/GDRFA API can drive the same transitions later. |
| Scope v1 | All three surfaces together: marketing + user portal + admin portal. |
| Countries v1 | **UAE, Australia, Canada, New Zealand, Tanzania, Uganda, Nigeria, Zambia.** |
| Stack | **Cheapest, Lambda-only, pay-per-use AWS** under `hireloop` profile. No always-on compute or RDS. |
| Origin market | India (applicants applying from India, INR pricing). |

---

## 3. Architecture

```
raysglobalservices.com        S3 + CloudFront — static Next.js export (marketing)
apply.raysglobalservices.com  S3 + CloudFront — React SPA (user portal)
admin.raysglobalservices.com  S3 + CloudFront — React SPA (admin portal)
api.raysglobalservices.com    API Gateway HTTP API + Lambda handlers
Database                      DynamoDB, on-demand, single-table
Documents                     Private S3 bucket; presigned PUT/GET, keys scoped per application
Auth                          Cognito: `rgs-users` pool (applicants), `rgs-admins` pool (staff)
Email                         SES: signup confirm, submission receipt, status changes, payment request
IaC                           Single CDK app, stages `staging` and `prod`, deployed with AWS profile `hireloop`
```

Cost profile: everything pay-per-request; expected idle cost ≈ $0, low-volume cost < $5/month.

### Units & boundaries

- `infra/` — CDK stacks (frontend hosting, api, data, auth, email).
- `services/api/` — Lambda source. Modules: `auth`, `applications`, `documents`, `admin`, `activity`, `config`. Each module = routes + handlers + data access; no cross-module imports except shared `lib/` (db client, auth middleware, event logger).
- `apps/marketing/` — Next.js static export.
- `apps/portal/` — user portal SPA.
- `apps/admin/` — admin SPA.
- `packages/shared/` — TypeScript types for entities, statuses, country config (single source of truth for both SPAs and API).

---

## 4. Data model (DynamoDB single table `rgs-platform`)

Key scheme: `PK` / `SK` with GSIs `GSI1` (status queues), `GSI2` (activity feed by time).

| Entity | Keys | Fields |
|---|---|---|
| User | `USER#<id>` / `PROFILE` | email, name, phone, created_at |
| Application | `USER#<id>` / `APP#<id>` (GSI1: `STATUS#<status>` / `<updated_at>`) | country, product_code, travellers[], status, step_reached, amounts {govt_fee, service_fee, currency}, payment_status, timestamps, internal_notes[] |
| Traveller | embedded in Application | name, dob, nationality, passport {number, expiry, issue}, photo_key, passport_key |
| Document | `APP#<id>` / `DOC#<type>#<traveller_idx>` | s3_key, review_status PENDING/APPROVED/REJECTED, reject_reason, uploaded_at |
| ActivityEvent | `EVENT#<yyyy-mm-dd>` / `<ts>#<ulid>` (GSI2 by user) | type, user_id, app_id, meta |
| CountryProduct | `CONFIG#COUNTRY` / `<iso2>#<product_code>` | name, visa_type, validity, stay, entry, govt_fee, service_fee, processing_days, docs_required[], faq[], active |

### Country products (seed data, v1)

| Country | Product | Type | Fulfillment note |
|---|---|---|---|
| AE UAE | 30-day single-entry e-visa | e-visa | partner submission |
| AU Australia | Visitor (subclass 600) | assisted | admin lodges on ImmiAccount |
| CA Canada | Visitor visa (TRV) | assisted | admin lodges on IRCC |
| NZ New Zealand | Visitor visa / NZeTA | assisted | admin lodges on INZ |
| TZ Tanzania | e-visa | e-visa | admin lodges on gov portal |
| UG Uganda | e-visa | e-visa | admin lodges on gov portal |
| NG Nigeria | e-visa/visa on arrival approval | e-visa | admin lodges on gov portal |
| ZM Zambia | e-visa | e-visa | admin lodges on gov portal |

Fees/docs per country are config rows — admin-editable later, seeded from research at build time. Docs checklist drives the wizard's Docs step per country.

### Status machine (applications)

```
DRAFT → SUBMITTED → DOCS_VERIFIED → SENT_TO_IMMIGRATION → APPROVED | REJECTED → DELIVERED
```

- Transitions are admin actions in v1; each writes an ActivityEvent and (except internal notes) an SES email to the user.
- The transition interface is a single `transitionApplication(appId, toStatus, actor, meta)` function so a future partner API/webhook can drive identical transitions.
- `payment_status`: `UNPAID → REQUESTED → PAID_OFFLINE` — independent of visa status; admin-set.
- Abandoned = DRAFT with no activity for 24h (computed in admin queries, not a stored status).

---

## 5. User portal (`apply.`)

- Cognito email/password signup, login, verify email, forgot password.
- **Wizard** (Atlys shape, no payment step): `Travellers → Docs → Essentials → Review & Submit`.
  - One question per screen, progress %, left step rail, autosave every step (PATCH draft).
  - Travellers: add 1..n travellers (name, DOB, nationality, passport fields).
  - Docs: per traveller, upload items from the country's docs checklist (passport bio page, photo, plus country-specific extras). Presigned S3 PUT; mobile-camera friendly; client-side size/type validation.
  - Essentials: travel dates, purpose, contact phone, address.
  - Review & Submit: fee breakdown (govt + service fee), "Submit — our team will contact you for payment", then confirmation screen + email.
- **Dashboard**: Ongoing / Completed tabs; ongoing = resume cards into the wizard at `step_reached`; each application shows Atlys-style status timeline; visa PDF download when `DELIVERED` (admin-uploaded file via presigned GET).

## 6. Admin portal (`admin.`)

- Separate Cognito pool; no self-signup (admin users created via CLI/console).
- **Queue**: applications table, filter by status/country/date, badge counts per status.
- **Application detail**: traveller data, document viewer with per-doc APPROVE / REJECT + reason (reject notifies user and reopens that doc slot), status transition buttons (validated against the machine), payment controls (`Request payment`, `Mark paid`), internal notes, uploaded visa result file.
- **Activity feed**: reverse-chron events — signups, application started, step completed, doc uploaded, submitted, stuck/abandoned drafts — the "see what users are doing" requirement.
- **Metrics tiles**: signups this week, applications by status, abandoned drafts count.
- **Country config manager** (owner requirement, promoted into v1 2026-07-23): edit per-country docs checklist, government/service fees, processing days, validity/stay/entry, active flag. Runtime source of truth = `CONFIG#COUNTRY` rows in DynamoDB; the code catalog in `@rgs/shared` is seed/fallback only. Every edit is validated (Zod), logged as `CONFIG_CHANGED`, and immediately drives portal pricing, wizard checklists, and API submit guards. Public `GET /api/v1/config/countries` serves the live catalog to marketing + portal.

## 7. Marketing site

- Next.js static export; pages: home, 8 country landing pages, services, about, contact, blog stub.
- Country landing page blocks (per Atlys): hero + processing-time promise; fee card (₹ govt fee + ₹ service fee, total); "2 steps" pitch; documents required; how-it-works steps; testimonials (reuse real ones from current site); rejection reasons; FAQ; footer with office address and 15-years trust markers. CTA → `apply.` with country preselected.
- Home: country-card grid (8 live cards with type/validity/fees/docs), other countries render as "Enquire" cards feeding a lead form (lead stored as ActivityEvent + SES notification to info@).
- **Theme**: primary red from RGS logo (crimson `#E23744` family), near-black ink, warm off-white background; red reserved for CTAs and accents; generous whitespace; system of shared design tokens in `packages/shared`.

## 8. Error handling & security

- API: Zod-validated request bodies; central error → JSON problem shape; 401/403 via Cognito JWT authorizer (separate authorizers per pool); users can only touch `USER#<own id>` rows; presigned URLs scoped to the caller's application prefix and content-type, 15-min expiry.
- Uploads capped (10 MB, jpeg/png/pdf). Passport data at rest in DynamoDB + S3 (SSE-S3 encryption), never in logs.
- No PII in ActivityEvent meta beyond ids.
- SES sender: `no-reply@raysglobalservices.com` (requires DNS verification during deployment phase).

## 9. Testing

- Unit: status machine transitions (all legal/illegal paths), auth guards, presigned-URL scoping, country-config-driven docs checklist, Zod schemas.
- Integration: API handlers against DynamoDB Local.
- E2E happy path (staging): signup → complete UAE wizard → submit → admin verifies docs → transitions to DELIVERED → user sees timeline + download.

## 10. Rollout

1. Deploy `staging` stage (CloudFront default domains) — full E2E pass.
2. Deploy `prod`; verify SES domain + DKIM.
3. DNS cutover for apex + `apply.` + `admin.` + `api.` only on owner's go signal; current site stays live until then. (Registrar/DNS host for raysglobalservices.com to be confirmed at deployment time.)

## 11. Explicitly out of scope (v1)

Online payment gateway (Razorpay later), passport OCR auto-fill, WhatsApp notifications, approval-chances quiz, guest checkout, mobile app, multi-language, blog CMS. (Admin-editable country config was promoted INTO v1 on 2026-07-23. Marketing site shows build-time catalog values and will hydrate live values from the public config endpoint once the API is deployed.)
