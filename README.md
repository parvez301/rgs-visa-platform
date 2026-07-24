# RGS Visa Platform

Self-serve visa application platform for **Rays Global Services** (Delhi) — an
Atlys-style experience for India-origin travellers. It has three user-facing
surfaces plus a serverless backend:

| Surface | What it is | Stack |
|---|---|---|
| **Marketing** (`apps/marketing`) | Public site: destinations, fees, notice board, lead capture | Next.js 15 (static export) |
| **Portal** (`apps/portal`) | Traveller app: sign-up, application wizard, document upload, tracking | Vite + React SPA |
| **Admin** (`apps/admin`) | Ops console: application queue, activity, notices, country config, leads | Vite + React SPA |
| **API** (`services/api`) | All business logic and persistence | AWS Lambda (TypeScript), API Gateway |

Backend data lives in a single **DynamoDB** table; auth is **Cognito** (separate
user and admin pools); files are in **S3**; everything is fronted by
**CloudFront** and provisioned with **AWS CDK**. Payments are handled offline in
v1 — the status machine is API-ready for automation later.

---

## Repository layout

```
rgs/
├── apps/
│   ├── marketing/      # Next.js static site (public)
│   ├── portal/         # Traveller SPA
│   └── admin/          # Admin/ops SPA
├── services/
│   └── api/            # Lambda handlers, domain logic (ports-and-adapters)
├── packages/
│   └── shared/         # @rgs/shared — Zod schemas, status machine, country catalog seed
├── infra/              # AWS CDK app (single stack per environment)
├── docs/               # Specs, plans, environment details, handoff notes
└── scripts/            # Operational runbooks (e.g. e2e checklist)
```

This is a **pnpm workspace**. Package names are `@rgs/marketing`, `@rgs/portal`,
`@rgs/admin`, `@rgs/api`, `@rgs/shared`, `@rgs/infra`.

**`@rgs/shared` is the source of truth** for domain types: application statuses
(`DRAFT → SUBMITTED → DOCS_VERIFIED → SENT_TO_IMMIGRATION → APPROVED/REJECTED →
DELIVERED`), payment statuses, document types, activity event types, and the
seed country catalog. Change contracts here first; everything else consumes it.

---

## Prerequisites

- **Node.js ≥ 22**
- **pnpm 10** (`corepack enable` then `corepack use pnpm@10`)
- **AWS CLI v2** with a configured profile that can deploy (see [Deploying](#deploying))
- AWS CDK is included as a dev dependency — no global install needed.

## Getting started (local development)

```bash
pnpm install
```

Each front-end reads its config from a **local, git-ignored `.env.local`** file.
These are **not** committed. Create them from the values for the target
environment — the environment details (API URL, pool IDs, etc.) are **provided
by the project owner out-of-band** (they are intentionally not stored in this
repository):

```bash
# apps/marketing/.env.local   (build/dev time)
NEXT_PUBLIC_API_URL=https://<api-id>.execute-api.ap-south-1.amazonaws.com
# NEXT_PUBLIC_APPLY_URL=<portal url>   # optional; defaults to staging portal

# apps/portal/.env.local
VITE_API_URL=https://<api-id>.execute-api.ap-south-1.amazonaws.com
VITE_USERS_POOL_ID=<cognito users pool id>
VITE_USERS_CLIENT_ID=<cognito users app client id>

# apps/admin/.env.local
VITE_API_URL=https://<api-id>.execute-api.ap-south-1.amazonaws.com
VITE_ADMINS_POOL_ID=<cognito admins pool id>
VITE_ADMINS_CLIENT_ID=<cognito admins app client id>
```

> Cognito **pool IDs and app client IDs are public** (they ship in the SPA
> bundles) — they are configuration, not secrets. No secret values are required
> to run the front-ends against a deployed backend.

Run each app:

```bash
pnpm --filter @rgs/marketing dev     # http://localhost:3100
pnpm --filter @rgs/portal dev        # http://localhost:3200
pnpm --filter @rgs/admin dev         # http://localhost:3300
```

The SPAs talk to the **deployed** API (per `.env.local`). The API itself runs as
a Lambda; there is no separate local API server — exercise it with the test
suite or against a deployed environment.

## Quality gates

Run before every commit; CI/reviewers expect all green:

```bash
pnpm -r typecheck
pnpm --filter @rgs/shared test        # Vitest
pnpm --filter @rgs/api test           # Vitest
pnpm --filter @rgs/marketing build    # verifies the static export
pnpm --filter @rgs/admin build
pnpm --filter @rgs/portal build
```

---

## Deploying

Infrastructure is a single CDK stack per environment: `RgsPlatform-<stage>`
(`staging` or `prod`), in **ap-south-1**. **CDK uploads pre-built static output**
(`apps/*/out` and `apps/*/dist`), so you must build the front-ends first; the
Lambda bundle is built by CDK automatically.

Two important gotchas:

1. **Marketing needs `NEXT_PUBLIC_API_URL` at build time.** There is no committed
   `.env`, and some client hooks default it to empty — build without it and the
   notice board / live catalog silently won't load. Pass it inline.
2. **Run CDK from `infra/`.** `infra/cdk.json` holds the app entry point and
   `requireApproval: never`. The stage is selected via the `RGS_STAGE` env var.

Full deploy to staging:

```bash
# 1. Build the three static apps with the target env
NEXT_PUBLIC_API_URL=https://<staging-api> pnpm --filter @rgs/marketing build
pnpm --filter @rgs/admin build            # uses apps/admin/.env.local
pnpm --filter @rgs/portal build           # uses apps/portal/.env.local

# 2. Deploy (Lambda + static sites + infra). Review first with `cdk diff`.
export AWS_PROFILE=<your-deploy-profile>
export RGS_STAGE=staging
pnpm --filter @rgs/infra exec cdk diff   RgsPlatform-staging
pnpm --filter @rgs/infra exec cdk deploy RgsPlatform-staging
```

For production, set `RGS_STAGE=prod` and build the front-ends with the **prod**
API URL / pool IDs. **Never seed test data into production.**

The stack outputs the CloudFront URLs, API endpoint, table name, and pool IDs on
every deploy. Current environment details (URLs, pool IDs, first-admin setup,
production cutover runbook) are kept out of the repo and **provided by the
project owner** to maintainers.

### Runtime configuration (set by CDK, not by you)

The Lambda receives `TABLE_NAME`, `DOCUMENTS_BUCKET`, `EMAIL_SENDER`, and
`ADMIN_NOTIFICATION_EMAIL` from the stack. There are **no secrets in the repo** —
all credentials come from the deployer's AWS profile and from Cognito/SES, which
CDK wires up.

---

## Key conventions (read before contributing)

- **Descriptive names.** No `res`/`idx`/`cfg` — write `reviewStatus`,
  `travellerIndex`, `countryProduct`, `activityEvent`.
- **Statuses come from `@rgs/shared`, verbatim.** Never invent states or
  transitions; the API enforces the machine, the UI renders it.
- **Country data is admin-managed**, stored in DynamoDB (`CONFIG#COUNTRY` rows).
  The catalog in `@rgs/shared` is a seed/fallback only — the UI must read live
  config (`GET /api/v1/config/countries`), never hardcode fees or timelines.
- **No red focus ring on form inputs** (owner preference) — fields signal focus
  via their border; only links/buttons keep the red `:focus-visible` ring.
- **Design tokens**: reuse the Tailwind theme vars (`rgs-red`, `ink`, `ink-soft`,
  `paper`, `mist`, `line`) and the display/mono fonts already configured.
- **Tenant of truth for docs**: `docs/superpowers/specs/…-design.md` (the spec)
  and the `docs/CURSOR-HANDOFF-*.md` files describe how each feature was built.

## Where to read more

| Topic | File |
|---|---|
| Product/technical design spec | `docs/superpowers/specs/2026-07-23-rgs-visa-platform-design.md` |
| Environments, pool IDs, prod cutover runbook | provided by the owner (not in repo) |
| Feature implementation notes | `docs/CURSOR-HANDOFF-*.md` + `docs/CURSOR-STATUS-*.md` |
| Country document research | `docs/research/` |
| Manual E2E checklist | `scripts/e2e-staging.md` |

## License / ownership

Private project owned by Rays Global Services. Not for public distribution.
