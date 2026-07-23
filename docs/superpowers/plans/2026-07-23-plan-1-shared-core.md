# RGS Platform — Plan 1: Monorepo Scaffold + Shared Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the pnpm monorepo and the `@rgs/shared` package containing entity schemas, the application status machine, and the 8-country product catalog that every other subsystem (API, portals, marketing) consumes.

**Architecture:** pnpm workspace monorepo. `packages/shared` is a pure-TypeScript package (no AWS deps) holding Zod schemas, status/payment/event constants, a validated status-transition machine, and a static country-product catalog with accessor functions. Everything unit-tested with Vitest.

**Tech Stack:** TypeScript (strict), pnpm 10 workspaces, Node ≥ 22, Zod 3, Vitest 2.

**Plan series context:** This is Plan 1 of 7. Later plans: 2) DynamoDB data layer + Lambda API, 3) CDK infra + staging deploy (AWS profile `hireloop`), 4) user portal SPA, 5) admin portal SPA, 6) marketing site, 7) prod rollout/DNS. Spec: `docs/superpowers/specs/2026-07-23-rgs-visa-platform-design.md`.

## Global Constraints

- TypeScript `strict: true` everywhere; no `any`.
- Descriptive variable names (owner's standing rule — no abbreviations like `cfg`, `res`, `idx` in new code; write `countryProduct`, `reviewStatus`, `travellerIndex`).
- Application status values, verbatim from spec: `DRAFT`, `SUBMITTED`, `DOCS_VERIFIED`, `SENT_TO_IMMIGRATION`, `APPROVED`, `REJECTED`, `DELIVERED`.
- Payment status values, verbatim from spec: `UNPAID`, `REQUESTED`, `PAID_OFFLINE`.
- v1 countries, verbatim from spec: AE, AU, CA, NZ, TZ, UG, NG, ZM.
- Currency for v1 pricing: INR (origin market India).
- `packages/shared` must have zero AWS/runtime-infra dependencies — Zod only.
- Commit after every task (green tests required first).

---

### Task 1: pnpm monorepo scaffold with Vitest wiring

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/test/sanity.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: workspace layout `packages/*`, `services/*`, `apps/*`, `infra`; package name `@rgs/shared` importable by later tasks; command `pnpm --filter @rgs/shared test` runs Vitest.

- [ ] **Step 1: Write workspace + package files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "services/*"
  - "apps/*"
  - "infra"
```

`package.json` (root):
```json
{
  "name": "rgs-platform",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "packageManager": "pnpm@10.33.0"
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.env
.env.*
cdk.out/
coverage/
.DS_Store
```

`packages/shared/package.json`:
```json
{
  "name": "@rgs/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/shared/src/index.ts`:
```ts
export const SHARED_PACKAGE_NAME = "@rgs/shared";
```

- [ ] **Step 2: Write the sanity test**

`packages/shared/test/sanity.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_NAME } from "../src/index.js";

describe("workspace sanity", () => {
  it("resolves the shared package entry point", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@rgs/shared");
  });
});
```

- [ ] **Step 3: Install and run test to verify it passes**

Run: `pnpm install && pnpm --filter @rgs/shared test`
Expected: 1 test file, 1 passed.

Run: `pnpm --filter @rgs/shared typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with @rgs/shared package"
```

---

### Task 2: Entity constants and Zod schemas

**Files:**
- Create: `packages/shared/src/statuses.ts`
- Create: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces (later plans import all of these from `@rgs/shared`):
  - `APPLICATION_STATUSES: readonly ApplicationStatus[]`, `type ApplicationStatus`
  - `PAYMENT_STATUSES`, `type PaymentStatus`
  - `WIZARD_STEPS`, `type WizardStep` (`"travellers" | "docs" | "essentials" | "review"`)
  - `ACTIVITY_EVENT_TYPES`, `type ActivityEventType`
  - `DOC_TYPES`, `type DocType`
  - Zod schemas + inferred types: `UserSchema`/`User`, `TravellerSchema`/`Traveller`, `ApplicationSchema`/`Application`, `ApplicationDocumentSchema`/`ApplicationDocument`, `ActivityEventSchema`/`ActivityEvent`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/schemas.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  ApplicationSchema,
  ApplicationDocumentSchema,
  ActivityEventSchema,
  TravellerSchema,
  UserSchema,
} from "../src/schemas.js";

const validTraveller = {
  fullName: "Asha Verma",
  dateOfBirth: "1992-04-18",
  nationality: "IN",
  passportNumber: "N1234567",
  passportIssueDate: "2020-01-10",
  passportExpiryDate: "2030-01-09",
};

const validApplication = {
  applicationId: "app_01J3ZTEST0000000000000000",
  userId: "user_01J3ZTEST000000000000000",
  countryCode: "AE",
  productCode: "AE_TOURIST_30D_SINGLE",
  travellers: [validTraveller],
  status: "DRAFT",
  stepReached: "travellers",
  amounts: { governmentFeeInr: 6500, serviceFeeInr: 1500, currency: "INR" },
  paymentStatus: "UNPAID",
  createdAt: "2026-07-23T10:00:00.000Z",
  updatedAt: "2026-07-23T10:00:00.000Z",
};

describe("UserSchema", () => {
  it("accepts a valid user", () => {
    const parsed = UserSchema.parse({
      userId: "user_01J3ZTEST000000000000000",
      email: "asha@example.com",
      fullName: "Asha Verma",
      phone: "+919810000000",
      createdAt: "2026-07-23T10:00:00.000Z",
    });
    expect(parsed.email).toBe("asha@example.com");
  });

  it("rejects an invalid email", () => {
    const result = UserSchema.safeParse({
      userId: "user_1",
      email: "not-an-email",
      fullName: "X",
      phone: "+919810000000",
      createdAt: "2026-07-23T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("TravellerSchema", () => {
  it("accepts a valid traveller", () => {
    expect(TravellerSchema.parse(validTraveller).nationality).toBe("IN");
  });

  it("rejects a lowercase or long nationality code", () => {
    expect(TravellerSchema.safeParse({ ...validTraveller, nationality: "ind" }).success).toBe(false);
  });

  it("rejects a non-ISO date of birth", () => {
    expect(TravellerSchema.safeParse({ ...validTraveller, dateOfBirth: "18/04/1992" }).success).toBe(false);
  });
});

describe("ApplicationSchema", () => {
  it("accepts a valid draft application", () => {
    expect(ApplicationSchema.parse(validApplication).status).toBe("DRAFT");
  });

  it("rejects an unknown status", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, status: "PENDING" }).success).toBe(false);
  });

  it("rejects an empty travellers list", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, travellers: [] }).success).toBe(false);
  });

  it("rejects an unknown payment status", () => {
    expect(ApplicationSchema.safeParse({ ...validApplication, paymentStatus: "PAID_ONLINE" }).success).toBe(false);
  });
});

describe("ApplicationDocumentSchema", () => {
  it("accepts a pending passport document", () => {
    const parsed = ApplicationDocumentSchema.parse({
      applicationId: validApplication.applicationId,
      docType: "PASSPORT_BIO",
      travellerIndex: 0,
      s3Key: "applications/app_1/traveller-0/PASSPORT_BIO.jpg",
      reviewStatus: "PENDING",
      uploadedAt: "2026-07-23T10:05:00.000Z",
    });
    expect(parsed.reviewStatus).toBe("PENDING");
  });

  it("requires rejectReason when reviewStatus is REJECTED", () => {
    const result = ApplicationDocumentSchema.safeParse({
      applicationId: validApplication.applicationId,
      docType: "PHOTO",
      travellerIndex: 0,
      s3Key: "applications/app_1/traveller-0/PHOTO.jpg",
      reviewStatus: "REJECTED",
      uploadedAt: "2026-07-23T10:05:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("ActivityEventSchema", () => {
  it("accepts a signup event without an application id", () => {
    const parsed = ActivityEventSchema.parse({
      eventId: "evt_01J3ZTEST0000000000000000",
      eventType: "SIGNED_UP",
      userId: "user_01J3ZTEST000000000000000",
      createdAt: "2026-07-23T10:00:00.000Z",
      meta: {},
    });
    expect(parsed.eventType).toBe("SIGNED_UP");
  });

  it("rejects an unknown event type", () => {
    const result = ActivityEventSchema.safeParse({
      eventId: "evt_1",
      eventType: "LOGGED_OUT",
      userId: "user_1",
      createdAt: "2026-07-23T10:00:00.000Z",
      meta: {},
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test`
Expected: FAIL — cannot resolve `../src/schemas.js`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/statuses.ts`:
```ts
export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "DOCS_VERIFIED",
  "SENT_TO_IMMIGRATION",
  "APPROVED",
  "REJECTED",
  "DELIVERED",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const PAYMENT_STATUSES = ["UNPAID", "REQUESTED", "PAID_OFFLINE"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const WIZARD_STEPS = ["travellers", "docs", "essentials", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const DOC_TYPES = [
  "PASSPORT_BIO",
  "PHOTO",
  "BANK_STATEMENT",
  "FLIGHT_ITINERARY",
  "HOTEL_BOOKING",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type DocReviewStatus = (typeof DOC_REVIEW_STATUSES)[number];

export const ACTIVITY_EVENT_TYPES = [
  "SIGNED_UP",
  "APPLICATION_STARTED",
  "STEP_COMPLETED",
  "DOC_UPLOADED",
  "DOC_REVIEWED",
  "SUBMITTED",
  "STATUS_CHANGED",
  "PAYMENT_REQUESTED",
  "PAYMENT_MARKED_PAID",
  "LEAD_CREATED",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
```

`packages/shared/src/schemas.ts`:
```ts
import { z } from "zod";
import {
  ACTIVITY_EVENT_TYPES,
  APPLICATION_STATUSES,
  DOC_REVIEW_STATUSES,
  DOC_TYPES,
  PAYMENT_STATUSES,
  WIZARD_STEPS,
} from "./statuses.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoDateTime = z.string().datetime();
const iso2CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2");

export const UserSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().min(8),
  createdAt: isoDateTime,
});
export type User = z.infer<typeof UserSchema>;

export const TravellerSchema = z.object({
  fullName: z.string().min(1),
  dateOfBirth: isoDate,
  nationality: iso2CountryCode,
  passportNumber: z.string().min(5),
  passportIssueDate: isoDate,
  passportExpiryDate: isoDate,
  photoKey: z.string().optional(),
  passportKey: z.string().optional(),
});
export type Traveller = z.infer<typeof TravellerSchema>;

export const ApplicationAmountsSchema = z.object({
  governmentFeeInr: z.number().int().nonnegative(),
  serviceFeeInr: z.number().int().nonnegative(),
  currency: z.literal("INR"),
});

export const ApplicationEssentialsSchema = z.object({
  intendedTravelDate: isoDate,
  purposeOfTravel: z.string().min(1),
  contactPhone: z.string().min(8),
  residentialAddress: z.string().min(1),
});
export type ApplicationEssentials = z.infer<typeof ApplicationEssentialsSchema>;

export const ApplicationSchema = z.object({
  applicationId: z.string().min(1),
  userId: z.string().min(1),
  countryCode: iso2CountryCode,
  productCode: z.string().min(1),
  travellers: z.array(TravellerSchema).min(1),
  status: z.enum(APPLICATION_STATUSES),
  stepReached: z.enum(WIZARD_STEPS),
  essentials: ApplicationEssentialsSchema.optional(),
  amounts: ApplicationAmountsSchema,
  paymentStatus: z.enum(PAYMENT_STATUSES),
  internalNotes: z.array(z.string()).default([]),
  visaResultKey: z.string().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Application = z.infer<typeof ApplicationSchema>;

export const ApplicationDocumentSchema = z
  .object({
    applicationId: z.string().min(1),
    docType: z.enum(DOC_TYPES),
    travellerIndex: z.number().int().nonnegative(),
    s3Key: z.string().min(1),
    reviewStatus: z.enum(DOC_REVIEW_STATUSES),
    rejectReason: z.string().min(1).optional(),
    uploadedAt: isoDateTime,
  })
  .refine(
    (document) => document.reviewStatus !== "REJECTED" || document.rejectReason !== undefined,
    { message: "rejectReason is required when reviewStatus is REJECTED" },
  );
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;

export const ActivityEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(ACTIVITY_EVENT_TYPES),
  userId: z.string().min(1),
  applicationId: z.string().optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  createdAt: isoDateTime,
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
```

Replace `packages/shared/src/index.ts` with:
```ts
export const SHARED_PACKAGE_NAME = "@rgs/shared";
export * from "./statuses.js";
export * from "./schemas.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test && pnpm --filter @rgs/shared typecheck`
Expected: all tests pass (sanity + schemas), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add entity constants and zod schemas"
```

---

### Task 3: Application status machine

**Files:**
- Create: `packages/shared/src/statusMachine.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/statusMachine.test.ts`

**Interfaces:**
- Consumes: `ApplicationStatus` from Task 2.
- Produces:
  - `LEGAL_STATUS_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]>`
  - `canTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): boolean`
  - `assertTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): void` — throws `IllegalStatusTransitionError`
  - `class IllegalStatusTransitionError extends Error` with fields `fromStatus`, `toStatus`
  - Plan 2's `transitionApplication(...)` data-layer function calls `assertTransition` before writing.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/statusMachine.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { APPLICATION_STATUSES, type ApplicationStatus } from "../src/statuses.js";
import {
  IllegalStatusTransitionError,
  LEGAL_STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
} from "../src/statusMachine.js";

const legalPairs: Array<[ApplicationStatus, ApplicationStatus]> = [
  ["DRAFT", "SUBMITTED"],
  ["SUBMITTED", "DOCS_VERIFIED"],
  ["DOCS_VERIFIED", "SENT_TO_IMMIGRATION"],
  ["SENT_TO_IMMIGRATION", "APPROVED"],
  ["SENT_TO_IMMIGRATION", "REJECTED"],
  ["APPROVED", "DELIVERED"],
];

describe("status machine", () => {
  it.each(legalPairs)("allows %s -> %s", (fromStatus, toStatus) => {
    expect(canTransition(fromStatus, toStatus)).toBe(true);
    expect(() => assertTransition(fromStatus, toStatus)).not.toThrow();
  });

  it("covers every status in the transition map", () => {
    expect(Object.keys(LEGAL_STATUS_TRANSITIONS).sort()).toEqual([...APPLICATION_STATUSES].sort());
  });

  it("rejects every pair that is not explicitly legal", () => {
    const legalKey = new Set(legalPairs.map(([fromStatus, toStatus]) => `${fromStatus}->${toStatus}`));
    for (const fromStatus of APPLICATION_STATUSES) {
      for (const toStatus of APPLICATION_STATUSES) {
        if (legalKey.has(`${fromStatus}->${toStatus}`)) continue;
        expect(canTransition(fromStatus, toStatus), `${fromStatus}->${toStatus}`).toBe(false);
      }
    }
  });

  it("terminal statuses REJECTED and DELIVERED allow nothing", () => {
    expect(LEGAL_STATUS_TRANSITIONS.REJECTED).toEqual([]);
    expect(LEGAL_STATUS_TRANSITIONS.DELIVERED).toEqual([]);
  });

  it("assertTransition throws a typed error with details", () => {
    try {
      assertTransition("DRAFT", "DELIVERED");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalStatusTransitionError);
      const transitionError = error as IllegalStatusTransitionError;
      expect(transitionError.fromStatus).toBe("DRAFT");
      expect(transitionError.toStatus).toBe("DELIVERED");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test`
Expected: FAIL — cannot resolve `../src/statusMachine.js`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/statusMachine.ts`:
```ts
import type { ApplicationStatus } from "./statuses.js";

export const LEGAL_STATUS_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["DOCS_VERIFIED"],
  DOCS_VERIFIED: ["SENT_TO_IMMIGRATION"],
  SENT_TO_IMMIGRATION: ["APPROVED", "REJECTED"],
  APPROVED: ["DELIVERED"],
  REJECTED: [],
  DELIVERED: [],
};

export class IllegalStatusTransitionError extends Error {
  constructor(
    public readonly fromStatus: ApplicationStatus,
    public readonly toStatus: ApplicationStatus,
  ) {
    super(`Illegal application status transition: ${fromStatus} -> ${toStatus}`);
    this.name = "IllegalStatusTransitionError";
  }
}

export function canTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): boolean {
  return LEGAL_STATUS_TRANSITIONS[fromStatus].includes(toStatus);
}

export function assertTransition(fromStatus: ApplicationStatus, toStatus: ApplicationStatus): void {
  if (!canTransition(fromStatus, toStatus)) {
    throw new IllegalStatusTransitionError(fromStatus, toStatus);
  }
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./statusMachine.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test && pnpm --filter @rgs/shared typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add application status machine with legal transitions"
```

---

### Task 4: Country product catalog (8 v1 countries)

**Files:**
- Create: `packages/shared/src/countryProducts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/countryProducts.test.ts`

**Interfaces:**
- Consumes: `DocType` from Task 2.
- Produces:
  - `interface CountryProduct { countryCode; productCode; countryName; visaType: "E_VISA" | "ASSISTED"; validityDays; stayDays; entry: "SINGLE" | "MULTIPLE"; governmentFeeInr; serviceFeeInr; processingDays; docsRequired: readonly DocType[]; active: boolean }`
  - `COUNTRY_PRODUCTS: readonly CountryProduct[]` (seed of 8)
  - `listActiveProducts(): CountryProduct[]`
  - `getCountryProduct(countryCode: string, productCode?: string): CountryProduct` — throws `UnknownCountryProductError` when absent
  - `getDocsChecklist(countryCode: string): readonly DocType[]`
  - Marketing (Plan 6) renders cards from `listActiveProducts()`; wizard Docs step (Plan 4) renders `getDocsChecklist(countryCode)`; API (Plan 2) prices applications from `getCountryProduct(...)` fees. Fee/processing numbers are launch seeds — owner-editable in code, moved to DB config later.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/countryProducts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  COUNTRY_PRODUCTS,
  UnknownCountryProductError,
  getCountryProduct,
  getDocsChecklist,
  listActiveProducts,
} from "../src/countryProducts.js";

const V1_COUNTRY_CODES = ["AE", "AU", "CA", "NZ", "TZ", "UG", "NG", "ZM"] as const;

describe("country product catalog", () => {
  it("contains exactly the 8 v1 countries, all active", () => {
    const countryCodes = COUNTRY_PRODUCTS.map((countryProduct) => countryProduct.countryCode).sort();
    expect(countryCodes).toEqual([...V1_COUNTRY_CODES].sort());
    expect(listActiveProducts()).toHaveLength(8);
  });

  it("every product carries positive fees, processing days, and a docs checklist", () => {
    for (const countryProduct of COUNTRY_PRODUCTS) {
      expect(countryProduct.governmentFeeInr, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.serviceFeeInr, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.processingDays, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.docsRequired.length, countryProduct.countryCode).toBeGreaterThan(0);
      expect(countryProduct.docsRequired, countryProduct.countryCode).toContain("PASSPORT_BIO");
    }
  });

  it("UAE is an e-visa product; Australia, Canada, New Zealand are assisted", () => {
    expect(getCountryProduct("AE").visaType).toBe("E_VISA");
    for (const assistedCountryCode of ["AU", "CA", "NZ"]) {
      expect(getCountryProduct(assistedCountryCode).visaType).toBe("ASSISTED");
    }
  });

  it("getCountryProduct resolves by country alone and by explicit product code", () => {
    const uaeProduct = getCountryProduct("AE");
    expect(uaeProduct.productCode).toBe("AE_TOURIST_30D_SINGLE");
    expect(getCountryProduct("AE", "AE_TOURIST_30D_SINGLE")).toEqual(uaeProduct);
  });

  it("throws a typed error for unknown lookups", () => {
    expect(() => getCountryProduct("FR")).toThrow(UnknownCountryProductError);
    expect(() => getCountryProduct("AE", "AE_WORK_VISA")).toThrow(UnknownCountryProductError);
    expect(() => getDocsChecklist("FR")).toThrow(UnknownCountryProductError);
  });

  it("docs checklist matches the country product", () => {
    expect(getDocsChecklist("AE")).toEqual(["PASSPORT_BIO", "PHOTO"]);
    expect(getDocsChecklist("AU")).toContain("BANK_STATEMENT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test`
Expected: FAIL — cannot resolve `../src/countryProducts.js`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/countryProducts.ts`:
```ts
import type { DocType } from "./statuses.js";

export interface CountryProduct {
  countryCode: string;
  productCode: string;
  countryName: string;
  visaType: "E_VISA" | "ASSISTED";
  validityDays: number;
  stayDays: number;
  entry: "SINGLE" | "MULTIPLE";
  governmentFeeInr: number;
  serviceFeeInr: number;
  processingDays: number;
  docsRequired: readonly DocType[];
  active: boolean;
}

// Launch seed values (fees in INR, processing in working days). Owner-editable;
// moves to admin-managed DB config post-v1.
export const COUNTRY_PRODUCTS: readonly CountryProduct[] = [
  {
    countryCode: "AE",
    productCode: "AE_TOURIST_30D_SINGLE",
    countryName: "United Arab Emirates",
    visaType: "E_VISA",
    validityDays: 60,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 6500,
    serviceFeeInr: 1500,
    processingDays: 4,
    docsRequired: ["PASSPORT_BIO", "PHOTO"],
    active: true,
  },
  {
    countryCode: "AU",
    productCode: "AU_VISITOR_600",
    countryName: "Australia",
    visaType: "ASSISTED",
    validityDays: 365,
    stayDays: 90,
    entry: "MULTIPLE",
    governmentFeeInr: 10800,
    serviceFeeInr: 3500,
    processingDays: 30,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "FLIGHT_ITINERARY"],
    active: true,
  },
  {
    countryCode: "CA",
    productCode: "CA_VISITOR_TRV",
    countryName: "Canada",
    visaType: "ASSISTED",
    validityDays: 3650,
    stayDays: 180,
    entry: "MULTIPLE",
    governmentFeeInr: 7500,
    serviceFeeInr: 3500,
    processingDays: 45,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "FLIGHT_ITINERARY"],
    active: true,
  },
  {
    countryCode: "NZ",
    productCode: "NZ_VISITOR",
    countryName: "New Zealand",
    visaType: "ASSISTED",
    validityDays: 270,
    stayDays: 90,
    entry: "MULTIPLE",
    governmentFeeInr: 17500,
    serviceFeeInr: 3500,
    processingDays: 30,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT"],
    active: true,
  },
  {
    countryCode: "TZ",
    productCode: "TZ_TOURIST_EVISA",
    countryName: "Tanzania",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 90,
    entry: "SINGLE",
    governmentFeeInr: 4300,
    serviceFeeInr: 1500,
    processingDays: 7,
    docsRequired: ["PASSPORT_BIO", "PHOTO"],
    active: true,
  },
  {
    countryCode: "UG",
    productCode: "UG_TOURIST_EVISA",
    countryName: "Uganda",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 45,
    entry: "SINGLE",
    governmentFeeInr: 4300,
    serviceFeeInr: 1500,
    processingDays: 5,
    docsRequired: ["PASSPORT_BIO", "PHOTO"],
    active: true,
  },
  {
    countryCode: "NG",
    productCode: "NG_TOURIST_EVISA",
    countryName: "Nigeria",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 8500,
    serviceFeeInr: 2500,
    processingDays: 10,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING"],
    active: true,
  },
  {
    countryCode: "ZM",
    productCode: "ZM_TOURIST_EVISA",
    countryName: "Zambia",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 2200,
    serviceFeeInr: 1500,
    processingDays: 5,
    docsRequired: ["PASSPORT_BIO", "PHOTO"],
    active: true,
  },
];

export class UnknownCountryProductError extends Error {
  constructor(
    public readonly countryCode: string,
    public readonly productCode?: string,
  ) {
    super(
      productCode === undefined
        ? `No visa product configured for country ${countryCode}`
        : `No visa product ${productCode} configured for country ${countryCode}`,
    );
    this.name = "UnknownCountryProductError";
  }
}

export function listActiveProducts(): CountryProduct[] {
  return COUNTRY_PRODUCTS.filter((countryProduct) => countryProduct.active);
}

export function getCountryProduct(countryCode: string, productCode?: string): CountryProduct {
  const countryProduct = COUNTRY_PRODUCTS.find(
    (candidate) =>
      candidate.countryCode === countryCode &&
      (productCode === undefined || candidate.productCode === productCode),
  );
  if (countryProduct === undefined) {
    throw new UnknownCountryProductError(countryCode, productCode);
  }
  return countryProduct;
}

export function getDocsChecklist(countryCode: string): readonly DocType[] {
  return getCountryProduct(countryCode).docsRequired;
}
```

Append to `packages/shared/src/index.ts`:
```ts
export * from "./countryProducts.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test && pnpm --filter @rgs/shared typecheck`
Expected: 4 test files, all passing; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add v1 country product catalog with accessors"
```
