# RGS Platform — Plan 4: User Portal (apply.raysglobalservices.com)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The traveller-facing SPA: Cognito email/password auth, Atlys-style full-screen application wizard (Travellers → Docs → Essentials → Review), dashboard with resume cards and status timeline, visa download.

**Architecture:** Vite + React 19 + TypeScript SPA in `apps/portal`, same design tokens as marketing (RGS red, Bricolage/Figtree/Spline Mono, Tailwind 4). Auth via `amazon-cognito-identity-js` (SRP) storing tokens in memory + localStorage refresh. A typed `apiClient` wraps the staging HTTP API. State: React Query for server state, wizard step state in URL (`/apply/{applicationId}/{step}`). Hosted on S3+CloudFront (added to CDK stack as `PortalHosting`).

**Tech Stack:** Vite 6, React 19, Tailwind 4, @tanstack/react-query, amazon-cognito-identity-js, react-router 7, @rgs/shared (types + catalog fallback).

## Tasks

1. **Scaffold + tokens + auth screens** — Vite app, Tailwind theme reuse, sign up / verify email / sign in / forgot password flows against `rgs-users-staging` pool; auth context with JWT for API calls.
2. **API client + config hook** — typed fetch wrapper (base URL from env), `useCountryConfig()` reading public `/config/countries`, React Query setup.
3. **Dashboard** — Ongoing/Completed tabs, resume cards (country photo, status chip, progress), "Start new application" country picker, status timeline component mirroring the 6-state machine, visa download button when DELIVERED.
4. **Wizard shell** — full-screen layout, left step rail (Travellers/Docs/Essentials/Review), progress %, autosave PATCH on every step change, resume at `stepReached`.
5. **Travellers step** — add/edit/remove traveller forms (name, DOB, nationality, passport numbers/dates) with Zod validation from shared schemas.
6. **Docs step** — per traveller × per checklist doc type: presign → PUT to S3 → record; camera-friendly file input, upload states, rejected-doc re-upload flow.
7. **Essentials + Review steps** — travel date/purpose/contact/address form; review screen with fee breakdown (govt + service), submit → confirmation screen ("no payment now — team contacts you").
8. **Portal hosting in CDK** — `rgs-portal-{stage}` bucket + CloudFront + deployment, env wiring (API URL, pool ids) via `.env.production` generated from stack outputs.

Each task ends with typecheck green + manual browser verification against staging; commits per task.
