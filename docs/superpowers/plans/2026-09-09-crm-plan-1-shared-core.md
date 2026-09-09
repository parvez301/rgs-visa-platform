# RGS CRM — Plan 1: Shared Core (contracts, state machines, normalizers)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@rgs/shared/crm` — the Zod schemas, the three state machines, and the Excel normalizers that every other CRM subsystem (domain layer, migration, agent tools, UI) consumes.

**Architecture:** Pure TypeScript inside the existing `packages/shared` package. No AWS dependencies, no I/O, no LLM. Every normalizer is a total function from a raw Excel string to a typed result carrying a `needsReview` flag — never a throw, never a silent guess. This is the migration's contract: if a normalizer is wrong, 7,161 rows import wrong, so each one is table-tested against the actual distinct values pulled from the workbook.

**Tech Stack:** TypeScript (strict), Zod 3, Vitest 2, pnpm 10 workspace, Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-09-rgs-crm-design.md`

**Plan series context:** Plan 1 of 5. Later plans: 2) domain layer + admin REST routes, 3) migration importer + review queue, 4) agent layer (provider adapter, loop, approval gate, tools, SSE), 5) watchdog + Today/Memory screens.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- **Descriptive variable names** (owner's standing rule): write `normalizedCountryCode`, `rawStatusValue`, `applicantOutcome` — never `cfg`, `res`, `idx`, `val`.
- `packages/shared` keeps **zero AWS/runtime-infra dependencies** — Zod only. This is an existing, enforced property of the package.
- ESM only (`"type": "module"`); imports of local files use no extension, matching existing files in `packages/shared/src`.
- All new CRM code lives under `packages/shared/src/crm/`; tests under `packages/shared/test/crm/`. Nothing in this plan modifies existing platform files except the barrel export in Task 9.
- **Normalizers never throw and never guess.** Unresolved input returns a result with `needsReview: true` and the original string preserved in `rawValue`. The migration's review queue depends on this.
- Case status values, verbatim from spec: `NEW`, `IN_PROGRESS`, `APPOINTMENT_SET`, `SUBMITTED`, `DECIDED`, `CLOSED`, `NOT_SUBMITTED`, `WITHDRAWN`, `DUPLICATE`.
- Custody values, verbatim from spec: `NOT_HELD`, `WITH_RGS`, `AT_EMBASSY`, `IN_TRANSIT`, `RETURNED`.
- Applicant outcome values, verbatim: `PENDING`, `APPROVED`, `REJECTED`, `SENT_BACK`.
- Billing values, verbatim: `UNBILLED`, `BILL_SENT`, `PAID`, `PART_PAID`, `WRITTEN_OFF`, `UNKNOWN`. `UNKNOWN` is set by the migration only and never by the CRM itself.
- Case type values, verbatim: `VISA`, `ATTESTATION`, `APOSTILLE`, `PASSPORT`, `OTHER`.
- Commit after every task, green tests required first.

---

### Task 1: CRM status constants and the three state machines

**Files:**
- Create: `packages/shared/src/crm/statuses.ts`
- Create: `packages/shared/src/crm/stateMachines.ts`
- Test: `packages/shared/test/crm/stateMachines.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: const arrays `CASE_STATUSES`, `CUSTODY_STATUSES`, `APPLICANT_OUTCOMES`, `BILLING_STATUSES`, `CASE_TYPES`, `VISA_TYPES`, `ENTRY_TYPES`, `PROCESSING_SPEEDS`, `COURIER_MODES`, `PARTNER_TYPES`, `LINE_ITEM_KINDS` and their derived types (`CaseStatus`, `CustodyStatus`, `ApplicantOutcome`, `BillingStatus`, `CaseType`, `VisaType`, `EntryType`, `ProcessingSpeed`, `CourierMode`, `PartnerType`, `LineItemKind`). Functions `canTransitionCaseStatus(from: CaseStatus, to: CaseStatus): boolean`, `canTransitionCustody(from: CustodyStatus, to: CustodyStatus): boolean`, `canTransitionBilling(from: BillingStatus, to: BillingStatus): boolean`, `deriveCaseStatusFromApplicants(currentCaseStatus: CaseStatus, applicantOutcomes: ApplicantOutcome[]): CaseStatus`, `isCaseClosable(applicantCustodies: CustodyStatus[], billingStatus: BillingStatus): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/stateMachines.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  canTransitionBilling,
  canTransitionCaseStatus,
  canTransitionCustody,
  deriveCaseStatusFromApplicants,
  isCaseClosable,
} from "../../src/crm/stateMachines";

describe("case status machine", () => {
  it("walks the happy path forward", () => {
    expect(canTransitionCaseStatus("NEW", "IN_PROGRESS")).toBe(true);
    expect(canTransitionCaseStatus("IN_PROGRESS", "APPOINTMENT_SET")).toBe(true);
    expect(canTransitionCaseStatus("APPOINTMENT_SET", "SUBMITTED")).toBe(true);
    expect(canTransitionCaseStatus("SUBMITTED", "DECIDED")).toBe(true);
    expect(canTransitionCaseStatus("DECIDED", "CLOSED")).toBe(true);
  });

  it("allows skipping the appointment step, since e-visas have no appointment", () => {
    expect(canTransitionCaseStatus("IN_PROGRESS", "SUBMITTED")).toBe(true);
  });

  it("refuses to move backwards", () => {
    expect(canTransitionCaseStatus("SUBMITTED", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("DECIDED", "SUBMITTED")).toBe(false);
  });

  it("refuses to leave a terminal status", () => {
    expect(canTransitionCaseStatus("CLOSED", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("WITHDRAWN", "IN_PROGRESS")).toBe(false);
    expect(canTransitionCaseStatus("DUPLICATE", "NEW")).toBe(false);
  });

  it("allows the off-ramps from any live status", () => {
    for (const liveStatus of ["NEW", "IN_PROGRESS", "APPOINTMENT_SET", "SUBMITTED"] as const) {
      expect(canTransitionCaseStatus(liveStatus, "WITHDRAWN")).toBe(true);
      expect(canTransitionCaseStatus(liveStatus, "DUPLICATE")).toBe(true);
      expect(canTransitionCaseStatus(liveStatus, "NOT_SUBMITTED")).toBe(true);
    }
  });
});

describe("custody machine", () => {
  it("walks a passport through the desk and back", () => {
    expect(canTransitionCustody("NOT_HELD", "WITH_RGS")).toBe(true);
    expect(canTransitionCustody("WITH_RGS", "AT_EMBASSY")).toBe(true);
    expect(canTransitionCustody("AT_EMBASSY", "WITH_RGS")).toBe(true);
    expect(canTransitionCustody("WITH_RGS", "IN_TRANSIT")).toBe(true);
    expect(canTransitionCustody("IN_TRANSIT", "RETURNED")).toBe(true);
  });

  it("allows handing a passport straight back without couriering it", () => {
    expect(canTransitionCustody("WITH_RGS", "RETURNED")).toBe(true);
  });

  it("refuses to send a passport we do not hold to an embassy", () => {
    expect(canTransitionCustody("NOT_HELD", "AT_EMBASSY")).toBe(false);
  });

  it("refuses to reopen a returned passport", () => {
    expect(canTransitionCustody("RETURNED", "WITH_RGS")).toBe(false);
  });
});

describe("billing machine", () => {
  it("walks the happy path", () => {
    expect(canTransitionBilling("UNBILLED", "BILL_SENT")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "PAID")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "PART_PAID")).toBe(true);
    expect(canTransitionBilling("PART_PAID", "PAID")).toBe(true);
    expect(canTransitionBilling("BILL_SENT", "WRITTEN_OFF")).toBe(true);
  });

  it("refuses to unpay", () => {
    expect(canTransitionBilling("PAID", "BILL_SENT")).toBe(false);
    expect(canTransitionBilling("WRITTEN_OFF", "BILL_SENT")).toBe(false);
  });

  it("lets a migrated UNKNOWN row be corrected to any real status", () => {
    expect(canTransitionBilling("UNKNOWN", "UNBILLED")).toBe(true);
    expect(canTransitionBilling("UNKNOWN", "PAID")).toBe(true);
  });

  it("never lets the CRM move a case back into UNKNOWN", () => {
    expect(canTransitionBilling("UNBILLED", "UNKNOWN")).toBe(false);
    expect(canTransitionBilling("PAID", "UNKNOWN")).toBe(false);
  });
});

describe("deriveCaseStatusFromApplicants", () => {
  it("becomes DECIDED once every applicant has an outcome", () => {
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "REJECTED"])).toBe("DECIDED");
  });

  it("stays put while any applicant is still pending", () => {
    expect(deriveCaseStatusFromApplicants("SUBMITTED", ["APPROVED", "PENDING"])).toBe("SUBMITTED");
  });

  it("does not drag a terminal case back to DECIDED", () => {
    expect(deriveCaseStatusFromApplicants("WITHDRAWN", ["APPROVED"])).toBe("WITHDRAWN");
    expect(deriveCaseStatusFromApplicants("CLOSED", ["APPROVED"])).toBe("CLOSED");
  });

  it("treats a case with no applicants as unchanged", () => {
    expect(deriveCaseStatusFromApplicants("IN_PROGRESS", [])).toBe("IN_PROGRESS");
  });
});

describe("isCaseClosable", () => {
  it("closes when every passport is back and the bill is settled", () => {
    expect(isCaseClosable(["RETURNED", "RETURNED"], "PAID")).toBe(true);
    expect(isCaseClosable(["RETURNED"], "WRITTEN_OFF")).toBe(true);
  });

  it("stays open while a passport is still out", () => {
    expect(isCaseClosable(["RETURNED", "IN_TRANSIT"], "PAID")).toBe(false);
  });

  it("stays open while the bill is unsettled", () => {
    expect(isCaseClosable(["RETURNED"], "BILL_SENT")).toBe(false);
  });

  it("never auto-closes a migrated case whose billing is UNKNOWN", () => {
    expect(isCaseClosable(["RETURNED"], "UNKNOWN")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/stateMachines`
Expected: FAIL — `Failed to resolve import "../../src/crm/stateMachines"`.

- [ ] **Step 3: Write the constants**

`packages/shared/src/crm/statuses.ts`:
```ts
export const CASE_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "APPOINTMENT_SET",
  "SUBMITTED",
  "DECIDED",
  "CLOSED",
  "NOT_SUBMITTED",
  "WITHDRAWN",
  "DUPLICATE",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses a case can still move out of. */
export const LIVE_CASE_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "APPOINTMENT_SET",
  "SUBMITTED",
] as const;

/** Statuses that end a case. Nothing transitions out of these. */
export const TERMINAL_CASE_STATUSES = [
  "CLOSED",
  "NOT_SUBMITTED",
  "WITHDRAWN",
  "DUPLICATE",
] as const;

export const CUSTODY_STATUSES = [
  "NOT_HELD",
  "WITH_RGS",
  "AT_EMBASSY",
  "IN_TRANSIT",
  "RETURNED",
] as const;
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number];

export const APPLICANT_OUTCOMES = ["PENDING", "APPROVED", "REJECTED", "SENT_BACK"] as const;
export type ApplicantOutcome = (typeof APPLICANT_OUTCOMES)[number];

export const BILLING_STATUSES = [
  "UNBILLED",
  "BILL_SENT",
  "PAID",
  "PART_PAID",
  "WRITTEN_OFF",
  "UNKNOWN",
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const CASE_TYPES = ["VISA", "ATTESTATION", "APOSTILLE", "PASSPORT", "OTHER"] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const VISA_TYPES = [
  "TOURIST",
  "BUSINESS",
  "EVISA_TOURIST",
  "B1_B2",
  "FAMILY_VISIT",
  "DEPENDENT",
  "STUDY",
  "WORK",
  "SEAMAN",
  "RELATIVE",
  "TRADE_FAIR",
  "SPORTS",
  "TRANSIT",
  "MDAC",
  "STP",
  "STR",
  "F_VISA",
  "VEVO",
  "E_VISA",
  "OTHER",
] as const;
export type VisaType = (typeof VISA_TYPES)[number];

export const ENTRY_TYPES = ["SINGLE", "DOUBLE", "MULTIPLE"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const PROCESSING_SPEEDS = ["NORMAL", "EXPRESS", "PREMIUM_LOUNGE"] as const;
export type ProcessingSpeed = (typeof PROCESSING_SPEEDS)[number];

export const COURIER_MODES = [
  "DTDC",
  "SPEEDPOST",
  "BLUEDART",
  "PORTER",
  "HANDOVER",
  "PICKUP",
] as const;
export type CourierMode = (typeof COURIER_MODES)[number];

export const PARTNER_TYPES = ["AGENCY", "CORPORATE", "DIRECT"] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const LINE_ITEM_KINDS = ["SERVICE", "GOVT_FEE", "ADDON"] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];
```

- [ ] **Step 4: Write the state machines**

`packages/shared/src/crm/stateMachines.ts`:
```ts
import {
  LIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  type ApplicantOutcome,
  type BillingStatus,
  type CaseStatus,
  type CustodyStatus,
} from "./statuses";

const CASE_STATUS_FORWARD_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  NEW: ["IN_PROGRESS", "APPOINTMENT_SET", "SUBMITTED"],
  IN_PROGRESS: ["APPOINTMENT_SET", "SUBMITTED"],
  APPOINTMENT_SET: ["SUBMITTED"],
  SUBMITTED: ["DECIDED"],
  DECIDED: ["CLOSED"],
  CLOSED: [],
  NOT_SUBMITTED: [],
  WITHDRAWN: [],
  DUPLICATE: [],
};

/** Off-ramps reachable from any status a case can still move out of. */
const CASE_STATUS_OFF_RAMPS: readonly CaseStatus[] = ["NOT_SUBMITTED", "WITHDRAWN", "DUPLICATE"];

export function canTransitionCaseStatus(
  fromStatus: CaseStatus,
  toStatus: CaseStatus,
): boolean {
  if (TERMINAL_CASE_STATUSES.includes(fromStatus as (typeof TERMINAL_CASE_STATUSES)[number])) {
    return false;
  }
  if (
    CASE_STATUS_OFF_RAMPS.includes(toStatus) &&
    LIVE_CASE_STATUSES.includes(fromStatus as (typeof LIVE_CASE_STATUSES)[number])
  ) {
    return true;
  }
  return CASE_STATUS_FORWARD_TRANSITIONS[fromStatus].includes(toStatus);
}

const CUSTODY_TRANSITIONS: Record<CustodyStatus, readonly CustodyStatus[]> = {
  NOT_HELD: ["WITH_RGS"],
  WITH_RGS: ["AT_EMBASSY", "IN_TRANSIT", "RETURNED"],
  AT_EMBASSY: ["WITH_RGS"],
  IN_TRANSIT: ["RETURNED", "WITH_RGS"],
  RETURNED: [],
};

export function canTransitionCustody(
  fromCustody: CustodyStatus,
  toCustody: CustodyStatus,
): boolean {
  return CUSTODY_TRANSITIONS[fromCustody].includes(toCustody);
}

const BILLING_TRANSITIONS: Record<BillingStatus, readonly BillingStatus[]> = {
  UNKNOWN: ["UNBILLED", "BILL_SENT", "PAID", "PART_PAID", "WRITTEN_OFF"],
  UNBILLED: ["BILL_SENT", "WRITTEN_OFF"],
  BILL_SENT: ["PAID", "PART_PAID", "WRITTEN_OFF"],
  PART_PAID: ["PAID", "WRITTEN_OFF"],
  PAID: [],
  WRITTEN_OFF: [],
};

export function canTransitionBilling(
  fromBilling: BillingStatus,
  toBilling: BillingStatus,
): boolean {
  return BILLING_TRANSITIONS[fromBilling].includes(toBilling);
}

/**
 * A case becomes DECIDED once every applicant has a non-PENDING outcome.
 * Terminal cases are never dragged back — migrated rows keep the status the
 * import assigned them (spec §5).
 */
export function deriveCaseStatusFromApplicants(
  currentCaseStatus: CaseStatus,
  applicantOutcomes: readonly ApplicantOutcome[],
): CaseStatus {
  if (TERMINAL_CASE_STATUSES.includes(currentCaseStatus as (typeof TERMINAL_CASE_STATUSES)[number])) {
    return currentCaseStatus;
  }
  if (currentCaseStatus === "DECIDED" || applicantOutcomes.length === 0) {
    return currentCaseStatus;
  }
  const everyApplicantDecided = applicantOutcomes.every(
    (applicantOutcome) => applicantOutcome !== "PENDING",
  );
  return everyApplicantDecided ? "DECIDED" : currentCaseStatus;
}

/**
 * Closable when every passport is back with its owner and the bill is settled.
 * UNKNOWN billing (migrated rows only) never satisfies this.
 */
export function isCaseClosable(
  applicantCustodies: readonly CustodyStatus[],
  billingStatus: BillingStatus,
): boolean {
  if (applicantCustodies.length === 0) {
    return false;
  }
  const everyPassportReturned = applicantCustodies.every(
    (applicantCustody) => applicantCustody === "RETURNED",
  );
  const billingSettled = billingStatus === "PAID" || billingStatus === "WRITTEN_OFF";
  return everyPassportReturned && billingSettled;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/stateMachines`
Expected: PASS, all suites green.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/crm/statuses.ts packages/shared/src/crm/stateMachines.ts packages/shared/test/crm/stateMachines.test.ts
git commit -m "feat(crm): add CRM status constants and the three state machines"
```

---

### Task 2: Country normalizer (166 spellings → ISO-3166 alpha-2)

**Files:**
- Create: `packages/shared/src/crm/normalize/country.ts`
- Test: `packages/shared/test/crm/normalize/country.test.ts`

**Interfaces:**
- Consumes: `VisaType` from `../statuses` (Task 1).
- Produces: `interface CountryNormalizationResult { countryCode: string | null; visaTypeHint: VisaType | null; needsReview: boolean; rawValue: string }` and `normalizeCountry(rawValue: string): CountryNormalizationResult`.

**Context for the implementer:** the workbook holds 166 distinct country spellings for roughly 90 real countries. Some carry extra meaning beyond the country — `Sri Lanka ETA` names both the country and the product. Matching is case-insensitive and whitespace-trimmed; anything unmatched goes to review rather than being guessed.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/country.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeCountry } from "../../../src/crm/normalize/country";

describe("normalizeCountry", () => {
  it("matches a clean name", () => {
    expect(normalizeCountry("China")).toEqual({
      countryCode: "CN",
      visaTypeHint: null,
      needsReview: false,
      rawValue: "China",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeCountry("  SOUTH AFRICA ").countryCode).toBe("ZA");
    expect(normalizeCountry("japan").countryCode).toBe("JP");
  });

  it("resolves the workbook's misspellings", () => {
    expect(normalizeCountry("SWISS").countryCode).toBe("CH");
    expect(normalizeCountry("SWIZTERLAND").countryCode).toBe("CH");
    expect(normalizeCountry("VEITNAM").countryCode).toBe("VN");
    expect(normalizeCountry("CROTIA").countryCode).toBe("HR");
    expect(normalizeCountry("ETHOPIA").countryCode).toBe("ET");
    expect(normalizeCountry("NETHERLAND").countryCode).toBe("NL");
    expect(normalizeCountry("NETHERLANDS").countryCode).toBe("NL");
    expect(normalizeCountry("SRILANKA").countryCode).toBe("LK");
  });

  it("resolves both Korea spellings to the South", () => {
    expect(normalizeCountry("KOREA").countryCode).toBe("KR");
    expect(normalizeCountry("SOUTH KOREA").countryCode).toBe("KR");
  });

  it("handles the apostrophe in Cote d'Ivoire", () => {
    expect(normalizeCountry("Cote d’Ivoire (Ivory Coast)").countryCode).toBe("CI");
    expect(normalizeCountry("Cote d'Ivoire (Ivory Coast)").countryCode).toBe("CI");
  });

  it("carries the product hint out of 'Sri Lanka ETA'", () => {
    expect(normalizeCountry("Sri Lanka ETA")).toEqual({
      countryCode: "LK",
      visaTypeHint: "E_VISA",
      needsReview: false,
      rawValue: "Sri Lanka ETA",
    });
  });

  it("sends an unknown value to review instead of guessing", () => {
    const result = normalizeCountry("Wakanda");
    expect(result.countryCode).toBeNull();
    expect(result.needsReview).toBe(true);
    expect(result.rawValue).toBe("Wakanda");
  });

  it("sends blank input to review", () => {
    expect(normalizeCountry("").needsReview).toBe(true);
    expect(normalizeCountry("   ").needsReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/country`
Expected: FAIL — cannot resolve `../../../src/crm/normalize/country`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/country.ts`:
```ts
import type { VisaType } from "../statuses";

export interface CountryNormalizationResult {
  countryCode: string | null;
  visaTypeHint: VisaType | null;
  needsReview: boolean;
  rawValue: string;
}

/**
 * Lookup key: uppercased, curly apostrophes folded to straight, runs of
 * whitespace collapsed. Keeps "SRI LANKA ETA" distinct from "SRI LANKA".
 */
function buildLookupKey(rawValue: string): string {
  return rawValue.trim().toUpperCase().replace(/’/g, "'").replace(/\s+/g, " ");
}

/** Country spellings observed in the workbook, mapped to ISO-3166 alpha-2. */
const COUNTRY_CODE_BY_SPELLING: Record<string, string> = {
  ARMENIA: "AM", AUSTRALIA: "AU", AUSTRIA: "AT", AZERBAIJAN: "AZ",
  BAHRAIN: "BH", BANGLADESH: "BD", BELGIUM: "BE", BOLIVIA: "BO",
  BOTSWANA: "BW", BRAZIL: "BR", "BURKINA FASO": "BF", CAMBODIA: "KH",
  CAMEROON: "CM", CANADA: "CA", CHILE: "CL", CHINA: "CN",
  COLOMBIA: "CO", CONGO: "CG", "COTE D'IVOIRE (IVORY COAST)": "CI",
  "IVORY COAST": "CI", CROATIA: "HR", CROTIA: "HR", DENMARK: "DK",
  "DOMINICAN REPUBLIC": "DO", EGYPT: "EG", ESTONIA: "EE",
  ETHIOPIA: "ET", ETHOPIA: "ET", FINLAND: "FI", FRANCE: "FR",
  GEORGIA: "GE", GERMANY: "DE", GHANA: "GH", GREECE: "GR",
  "HONG KONG": "HK", HUNGARY: "HU", ICELAND: "IS", INDONESIA: "ID",
  IRELAND: "IE", ISRAEL: "IL", ITALY: "IT", JAPAN: "JP",
  KENYA: "KE", KOREA: "KR", "SOUTH KOREA": "KR", LATVIA: "LV",
  MALAYSIA: "MY", MALI: "ML", MALTA: "MT", MAURITIUS: "MU",
  MEXICO: "MX", MONGOLIA: "MN", MOROCCO: "MA", NAMIBIA: "NA",
  NEPAL: "NP", NETHERLAND: "NL", NETHERLANDS: "NL",
  "NEW ZEALAND": "NZ", NIGERIA: "NG", NORWAY: "NO", OMAN: "OM",
  PERU: "PE", PHILIPPINES: "PH", POLAND: "PL", PORTUGAL: "PT",
  QATAR: "QA", ROMANIA: "RO", RUSSIA: "RU", "SAUDI ARABIA": "SA",
  SAUDI: "SA", SINGAPORE: "SG", SLOVAKIA: "SK", SLOVENIA: "SI",
  "SOUTH AFRICA": "ZA", SPAIN: "ES", "SRI LANKA": "LK", SRILANKA: "LK",
  SWEDEN: "SE", SWITZERLAND: "CH", SWIZTERLAND: "CH", SWISS: "CH",
  TAIWAN: "TW", TANZANIA: "TZ", THAILAND: "TH", TUNISIA: "TN",
  TURKEY: "TR", UAE: "AE", "UNITED ARAB EMIRATES": "AE",
  UGANDA: "UG", UK: "GB", "UNITED KINGDOM": "GB", URUGUAY: "UY",
  USA: "US", "UNITED STATES": "US", UZBEKISTAN: "UZ",
  VEITNAM: "VN", VIETNAM: "VN", ZAMBIA: "ZM", ZIMBABWE: "ZW",
};

/** Spellings that also name a product, not just a country. */
const VISA_TYPE_HINT_BY_SPELLING: Record<string, { countryCode: string; visaTypeHint: VisaType }> = {
  "SRI LANKA ETA": { countryCode: "LK", visaTypeHint: "E_VISA" },
};

export function normalizeCountry(rawValue: string): CountryNormalizationResult {
  const lookupKey = buildLookupKey(rawValue);
  if (lookupKey.length === 0) {
    return { countryCode: null, visaTypeHint: null, needsReview: true, rawValue };
  }

  const hintedMatch = VISA_TYPE_HINT_BY_SPELLING[lookupKey];
  if (hintedMatch !== undefined) {
    return {
      countryCode: hintedMatch.countryCode,
      visaTypeHint: hintedMatch.visaTypeHint,
      needsReview: false,
      rawValue,
    };
  }

  const countryCode = COUNTRY_CODE_BY_SPELLING[lookupKey];
  if (countryCode === undefined) {
    return { countryCode: null, visaTypeHint: null, needsReview: true, rawValue };
  }
  return { countryCode, visaTypeHint: null, needsReview: false, rawValue };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/country`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/country.ts packages/shared/test/crm/normalize/country.test.ts
git commit -m "feat(crm): normalize the workbook's 166 country spellings to ISO-3166"
```

---

### Task 3: Entries normalizer (34 variants → entry type × processing × validity)

**Files:**
- Create: `packages/shared/src/crm/normalize/entries.ts`
- Test: `packages/shared/test/crm/normalize/entries.test.ts`

**Interfaces:**
- Consumes: `EntryType`, `ProcessingSpeed` from `../statuses` (Task 1).
- Produces: `interface EntriesNormalizationResult { entryType: EntryType | null; processing: ProcessingSpeed | null; validity: string | null; needsReview: boolean; rawValue: string }` and `normalizeEntries(rawValue: string): EntriesNormalizationResult`.

**Context for the implementer:** the workbook's `Entries` column packs three independent facts into one string — how many entries, how fast, and how long the visa is valid. `Single Exp` is SINGLE + EXPRESS; `Multiple 10 Yr` is MULTIPLE + NORMAL + 10Y. Some values (`1 Yr Exp`) give speed and validity but no entry count — those are partial, and partial means review. `PL` abbreviates Premium Lounge.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/entries.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeEntries } from "../../../src/crm/normalize/entries";

describe("normalizeEntries", () => {
  it("reads a plain entry count and defaults the speed to normal", () => {
    expect(normalizeEntries("Single")).toEqual({
      entryType: "SINGLE",
      processing: "NORMAL",
      validity: null,
      needsReview: false,
      rawValue: "Single",
    });
  });

  it("accepts every spelling of a plain single entry", () => {
    for (const rawValue of ["Single", "single", "Single entry", "X1"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("NORMAL");
      expect(result.needsReview).toBe(false);
    }
  });

  it("splits the express abbreviations", () => {
    for (const rawValue of ["Single Exp", "SINGLE/EXPRESS"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("EXPRESS");
    }
  });

  it("accepts every misspelling of single normal", () => {
    for (const rawValue of ["Single Nrml", "Single Normal", "Single Nrmal", "SINGLE/NORMAL"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("SINGLE");
      expect(result.processing).toBe("NORMAL");
      expect(result.needsReview).toBe(false);
    }
  });

  it("reads PL as premium lounge", () => {
    expect(normalizeEntries("Single PL").processing).toBe("PREMIUM_LOUNGE");
    expect(normalizeEntries("Double PL").processing).toBe("PREMIUM_LOUNGE");
    expect(normalizeEntries("Multiple PL").processing).toBe("PREMIUM_LOUNGE");
  });

  it("reads the double-entry family", () => {
    for (const rawValue of ["Double", "Double entry", "Double Nrml"]) {
      expect(normalizeEntries(rawValue).entryType).toBe("DOUBLE");
    }
    for (const rawValue of ["Double Exp", "DOUBLE EXPRESS", "DOUBLE/EXPRESS"]) {
      const result = normalizeEntries(rawValue);
      expect(result.entryType).toBe("DOUBLE");
      expect(result.processing).toBe("EXPRESS");
    }
  });

  it("pulls validity out of the multiple-entry variants", () => {
    expect(normalizeEntries("Multiple 10 Yr")).toEqual({
      entryType: "MULTIPLE",
      processing: "NORMAL",
      validity: "10Y",
      needsReview: false,
      rawValue: "Multiple 10 Yr",
    });
    expect(normalizeEntries("Multiple 10 Yr/").validity).toBe("10Y");
    expect(normalizeEntries("Multiple 1 Yr").validity).toBe("1Y");
    expect(normalizeEntries("Multiple 6 Months").validity).toBe("6M");
    expect(normalizeEntries("5 YR MULT").validity).toBe("5Y");
  });

  it("reads validity and express together", () => {
    expect(normalizeEntries("Multiple 1 Yr/E")).toEqual({
      entryType: "MULTIPLE",
      processing: "EXPRESS",
      validity: "1Y",
      needsReview: false,
      rawValue: "Multiple 1 Yr/E",
    });
  });

  it("reads the urgent three-month single", () => {
    expect(normalizeEntries("3 MONTHS SINGLE URGENT")).toEqual({
      entryType: "SINGLE",
      processing: "EXPRESS",
      validity: "3M",
      needsReview: false,
      rawValue: "3 MONTHS SINGLE URGENT",
    });
  });

  it("flags values that name a speed but no entry count", () => {
    const oneYearExpress = normalizeEntries("1 Yr Exp");
    expect(oneYearExpress.entryType).toBeNull();
    expect(oneYearExpress.processing).toBe("EXPRESS");
    expect(oneYearExpress.validity).toBe("1Y");
    expect(oneYearExpress.needsReview).toBe(true);

    const sixMonthExpress = normalizeEntries("6M Exp");
    expect(sixMonthExpress.validity).toBe("6M");
    expect(sixMonthExpress.needsReview).toBe(true);
  });

  it("sends column-shift junk to review", () => {
    for (const rawValue of ["Business", "Entries", "", "   "]) {
      const result = normalizeEntries(rawValue);
      expect(result.needsReview).toBe(true);
      expect(result.entryType).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/entries`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/entries.ts`:
```ts
import type { EntryType, ProcessingSpeed } from "../statuses";

export interface EntriesNormalizationResult {
  entryType: EntryType | null;
  processing: ProcessingSpeed | null;
  validity: string | null;
  needsReview: boolean;
  rawValue: string;
}

/** Uppercased, punctuation flattened to single spaces. "Multiple 1 Yr/E" -> "MULTIPLE 1 YR E". */
function buildTokenString(rawValue: string): string {
  return rawValue.trim().toUpperCase().replace(/[/\-,]+/g, " ").replace(/\s+/g, " ").trim();
}

function detectEntryType(tokenString: string): EntryType | null {
  if (/\bMULT/.test(tokenString)) return "MULTIPLE";
  if (/\bDOUBLE\b/.test(tokenString)) return "DOUBLE";
  if (/\bSINGLE\b/.test(tokenString) || tokenString === "X1") return "SINGLE";
  return null;
}

function detectProcessing(tokenString: string): ProcessingSpeed | null {
  if (/\bPL\b/.test(tokenString)) return "PREMIUM_LOUNGE";
  if (/\bEXP(RESS)?\b/.test(tokenString) || /\bURGENT\b/.test(tokenString) || /\bE\b/.test(tokenString)) {
    return "EXPRESS";
  }
  if (/\bN(O)?RM(A)?L\b/.test(tokenString) || /\bNRMAL\b/.test(tokenString)) return "NORMAL";
  return null;
}

/** "10 YR" -> "10Y", "6 MONTHS" -> "6M", "3 MONTHS" -> "3M". */
function detectValidity(tokenString: string): string | null {
  const yearMatch = tokenString.match(/\b(\d+)\s*(?:YR|YEAR|YEARS)\b/);
  if (yearMatch !== null) return `${yearMatch[1]}Y`;
  const monthMatch = tokenString.match(/\b(\d+)\s*(?:M|MONTH|MONTHS)\b/);
  if (monthMatch !== null) return `${monthMatch[1]}M`;
  return null;
}

/** Values that appear in the Entries column but are not entry descriptions at all. */
const COLUMN_SHIFT_JUNK = new Set(["BUSINESS", "ENTRIES"]);

export function normalizeEntries(rawValue: string): EntriesNormalizationResult {
  const tokenString = buildTokenString(rawValue);
  if (tokenString.length === 0 || COLUMN_SHIFT_JUNK.has(tokenString)) {
    return { entryType: null, processing: null, validity: null, needsReview: true, rawValue };
  }

  const entryType = detectEntryType(tokenString);
  const detectedProcessing = detectProcessing(tokenString);
  const validity = detectValidity(tokenString);

  if (entryType === null) {
    // A speed or validity with no entry count is partial information, not a guess.
    return {
      entryType: null,
      processing: detectedProcessing,
      validity,
      needsReview: true,
      rawValue,
    };
  }

  return {
    entryType,
    processing: detectedProcessing ?? "NORMAL",
    validity,
    needsReview: false,
    rawValue,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/entries`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/entries.ts packages/shared/test/crm/normalize/entries.test.ts
git commit -m "feat(crm): split the Entries column into entry type, speed and validity"
```

---

### Task 4: Status normalizer (27 variants → three axes)

**Files:**
- Create: `packages/shared/src/crm/normalize/status.ts`
- Test: `packages/shared/test/crm/normalize/status.test.ts`

**Interfaces:**
- Consumes: `ApplicantOutcome`, `CaseStatus`, `CaseType`, `CourierMode`, `CustodyStatus` from `../statuses` (Task 1).
- Produces: `interface StatusNormalizationResult { caseStatus: CaseStatus | null; custody: CustodyStatus | null; outcome: ApplicantOutcome | null; courierMode: CourierMode | null; caseTypeHint: CaseType | null; lineItemHint: string | null; note: string | null; needsReview: boolean; rawValue: string }` and `normalizeStatus(rawValue: string): StatusNormalizationResult`.

**Context for the implementer:** this is the single most important normalizer in the migration — it is why the three-axis model exists. The workbook's `Status` column mixes case progress (`Submitted`), physical logistics (`Sent on Courier`), service lines (`Payment Only`), and outright column-shift junk (a passport number). Every mapping below comes from spec §6; do not invent new ones. Values that resolve to nothing on any axis go to review.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeStatus } from "../../../src/crm/normalize/status";

describe("normalizeStatus — case progress", () => {
  it("maps the in-progress spellings", () => {
    expect(normalizeStatus("Working on It").caseStatus).toBe("IN_PROGRESS");
    expect(normalizeStatus("In Progress").caseStatus).toBe("IN_PROGRESS");
  });

  it("maps the misspelled appointment status", () => {
    expect(normalizeStatus("Appoinment Scheduled").caseStatus).toBe("APPOINTMENT_SET");
  });

  it("maps submission and places the passport at the embassy", () => {
    const submitted = normalizeStatus("Submitted");
    expect(submitted.caseStatus).toBe("SUBMITTED");
    expect(submitted.custody).toBe("AT_EMBASSY");

    const onlineSubmitted = normalizeStatus("ONLINE SUBMITTED");
    expect(onlineSubmitted.caseStatus).toBe("SUBMITTED");
    expect(onlineSubmitted.custody).toBe("AT_EMBASSY");
  });

  it("maps the not-submitted spellings", () => {
    expect(normalizeStatus("Not submitted").caseStatus).toBe("NOT_SUBMITTED");
    expect(normalizeStatus("NOT PROCESSED").caseStatus).toBe("NOT_SUBMITTED");
  });

  it("maps withdrawal and duplicates", () => {
    expect(normalizeStatus("WITHDRAWAL").caseStatus).toBe("WITHDRAWN");
    expect(normalizeStatus("duplicate entry").caseStatus).toBe("DUPLICATE");
  });
});

describe("normalizeStatus — outcomes", () => {
  it("maps an approval onto the outcome axis, not the case axis alone", () => {
    const approved = normalizeStatus("Approved");
    expect(approved.caseStatus).toBe("DECIDED");
    expect(approved.outcome).toBe("APPROVED");
  });

  it("maps rejection and send-back", () => {
    expect(normalizeStatus("Rejected").outcome).toBe("REJECTED");
    expect(normalizeStatus("SENT BACK").outcome).toBe("SENT_BACK");
  });
});

describe("normalizeStatus — custody and courier", () => {
  it("treats 'Sent on Courier' as custody, leaving the courier unknown", () => {
    const result = normalizeStatus("Sent on Courier");
    expect(result.custody).toBe("IN_TRANSIT");
    expect(result.courierMode).toBeNull();
    expect(result.caseStatus).toBeNull();
  });

  it("reads the named couriers as both custody and mode", () => {
    expect(normalizeStatus("DTDC")).toMatchObject({ custody: "IN_TRANSIT", courierMode: "DTDC" });
    expect(normalizeStatus("SPEED POST")).toMatchObject({
      custody: "IN_TRANSIT",
      courierMode: "SPEEDPOST",
    });
  });

  it("closes the case when the passport goes back by hand", () => {
    for (const [rawValue, expectedMode] of [
      ["Handover", "HANDOVER"],
      ["Pickup", "PICKUP"],
      ["PORTER", "PORTER"],
    ] as const) {
      const result = normalizeStatus(rawValue);
      expect(result.caseStatus).toBe("CLOSED");
      expect(result.custody).toBe("RETURNED");
      expect(result.courierMode).toBe(expectedMode);
    }
  });

  it("maps Delivered to closed and returned with no courier named", () => {
    const result = normalizeStatus("Delivered");
    expect(result.caseStatus).toBe("CLOSED");
    expect(result.custody).toBe("RETURNED");
    expect(result.courierMode).toBeNull();
  });

  it("maps the passport-in-hand statuses to custody only", () => {
    for (const rawValue of ["PASSPORT COLLECTION", "PASSPORT ONLY"]) {
      const result = normalizeStatus(rawValue);
      expect(result.custody).toBe("WITH_RGS");
      expect(result.caseStatus).toBeNull();
    }
  });
});

describe("normalizeStatus — values that are not statuses", () => {
  it("turns service lines into case-type hints", () => {
    expect(normalizeStatus("Payment Only").caseTypeHint).toBe("OTHER");
    expect(normalizeStatus("Documents attestation").caseTypeHint).toBe("ATTESTATION");
  });

  it("turns a booked ticket into a line-item hint, not a status", () => {
    const result = normalizeStatus("TICKET BOOKED");
    expect(result.lineItemHint).toBe("TICKET_BOOKING");
    expect(result.caseStatus).toBeNull();
  });

  it("keeps the biometrics letter as a note on an in-progress case", () => {
    const result = normalizeStatus("REC: Bio Letter");
    expect(result.caseStatus).toBe("IN_PROGRESS");
    expect(result.note).toBe("Biometrics letter received");
  });

  it("sends column-shift junk to review with the original preserved", () => {
    const passportInStatusColumn = "DEU/DEL/190126/0027/01 Passport No: Z7789186";
    const result = normalizeStatus(passportInStatusColumn);
    expect(result.needsReview).toBe(true);
    expect(result.caseStatus).toBeNull();
    expect(result.rawValue).toBe(passportInStatusColumn);

    expect(normalizeStatus("Visa Category: Short Stay").needsReview).toBe(true);
    expect(normalizeStatus("").needsReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/status`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/status.ts`:
```ts
import type {
  ApplicantOutcome,
  CaseStatus,
  CaseType,
  CourierMode,
  CustodyStatus,
} from "../statuses";

export interface StatusNormalizationResult {
  caseStatus: CaseStatus | null;
  custody: CustodyStatus | null;
  outcome: ApplicantOutcome | null;
  courierMode: CourierMode | null;
  caseTypeHint: CaseType | null;
  lineItemHint: string | null;
  note: string | null;
  needsReview: boolean;
  rawValue: string;
}

type StatusMapping = Omit<StatusNormalizationResult, "needsReview" | "rawValue">;

const EMPTY_MAPPING: StatusMapping = {
  caseStatus: null,
  custody: null,
  outcome: null,
  courierMode: null,
  caseTypeHint: null,
  lineItemHint: null,
  note: null,
};

function mapping(overrides: Partial<StatusMapping>): StatusMapping {
  return { ...EMPTY_MAPPING, ...overrides };
}

/** Spec §6. Keys are uppercased and whitespace-collapsed. */
const MAPPING_BY_STATUS: Record<string, StatusMapping> = {
  "WORKING ON IT": mapping({ caseStatus: "IN_PROGRESS" }),
  "IN PROGRESS": mapping({ caseStatus: "IN_PROGRESS" }),
  "APPOINMENT SCHEDULED": mapping({ caseStatus: "APPOINTMENT_SET" }),
  "APPOINTMENT SCHEDULED": mapping({ caseStatus: "APPOINTMENT_SET" }),
  SUBMITTED: mapping({ caseStatus: "SUBMITTED", custody: "AT_EMBASSY" }),
  "ONLINE SUBMITTED": mapping({ caseStatus: "SUBMITTED", custody: "AT_EMBASSY" }),
  APPROVED: mapping({ caseStatus: "DECIDED", outcome: "APPROVED" }),
  REJECTED: mapping({ caseStatus: "DECIDED", outcome: "REJECTED" }),
  "SENT BACK": mapping({ caseStatus: "DECIDED", outcome: "SENT_BACK" }),

  "SENT ON COURIER": mapping({ custody: "IN_TRANSIT" }),
  DTDC: mapping({ custody: "IN_TRANSIT", courierMode: "DTDC" }),
  "SPEED POST": mapping({ custody: "IN_TRANSIT", courierMode: "SPEEDPOST" }),

  HANDOVER: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "HANDOVER" }),
  PICKUP: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "PICKUP" }),
  PORTER: mapping({ caseStatus: "CLOSED", custody: "RETURNED", courierMode: "PORTER" }),
  DELIVERED: mapping({ caseStatus: "CLOSED", custody: "RETURNED" }),

  "PASSPORT COLLECTION": mapping({ custody: "WITH_RGS" }),
  "PASSPORT ONLY": mapping({ custody: "WITH_RGS" }),

  "NOT SUBMITTED": mapping({ caseStatus: "NOT_SUBMITTED" }),
  "NOT PROCESSED": mapping({ caseStatus: "NOT_SUBMITTED" }),
  WITHDRAWAL: mapping({ caseStatus: "WITHDRAWN" }),
  "DUPLICATE ENTRY": mapping({ caseStatus: "DUPLICATE" }),

  "PAYMENT ONLY": mapping({ caseTypeHint: "OTHER" }),
  "DOCUMENTS ATTESTATION": mapping({ caseTypeHint: "ATTESTATION" }),
  "TICKET BOOKED": mapping({ lineItemHint: "TICKET_BOOKING" }),
  "REC: BIO LETTER": mapping({
    caseStatus: "IN_PROGRESS",
    note: "Biometrics letter received",
  }),
};

export function normalizeStatus(rawValue: string): StatusNormalizationResult {
  const lookupKey = rawValue.trim().toUpperCase().replace(/\s+/g, " ");
  if (lookupKey.length === 0) {
    return { ...EMPTY_MAPPING, needsReview: true, rawValue };
  }
  const matchedMapping = MAPPING_BY_STATUS[lookupKey];
  if (matchedMapping === undefined) {
    return { ...EMPTY_MAPPING, needsReview: true, rawValue };
  }
  return { ...matchedMapping, needsReview: false, rawValue };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/status`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/status.ts packages/shared/test/crm/normalize/status.test.ts
git commit -m "feat(crm): split the Status column onto the case, custody and outcome axes"
```

---

### Task 5: Visa type normalizer (30 variants → case type × visa type)

**Files:**
- Create: `packages/shared/src/crm/normalize/visaType.ts`
- Test: `packages/shared/test/crm/normalize/visaType.test.ts`

**Interfaces:**
- Consumes: `CaseType`, `VisaType` from `../statuses` (Task 1).
- Produces: `interface VisaTypeNormalizationResult { caseType: CaseType | null; visaType: VisaType | null; needsReview: boolean; rawValue: string }` and `normalizeVisaType(rawValue: string): VisaTypeNormalizationResult`.

**Context for the implementer:** several values in the workbook's `Visa Type` column are not visa types — attestation, apostille and passport work are separate service lines that become a `caseType`. Those results carry `visaType: null`, which is correct and not a review flag.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/visaType.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeVisaType } from "../../../src/crm/normalize/visaType";

describe("normalizeVisaType — real visa types", () => {
  it("maps the common ones", () => {
    expect(normalizeVisaType("Tourist")).toEqual({
      caseType: "VISA",
      visaType: "TOURIST",
      needsReview: false,
      rawValue: "Tourist",
    });
    expect(normalizeVisaType("Business").visaType).toBe("BUSINESS");
    expect(normalizeVisaType("Evisa - Tourist").visaType).toBe("EVISA_TOURIST");
    expect(normalizeVisaType("B1/B2").visaType).toBe("B1_B2");
    expect(normalizeVisaType("Family Visit").visaType).toBe("FAMILY_VISIT");
    expect(normalizeVisaType("Dependent").visaType).toBe("DEPENDENT");
    expect(normalizeVisaType("Study").visaType).toBe("STUDY");
  });

  it("collapses the three work-visa spellings", () => {
    for (const rawValue of ["Work Visa", "WORK PERMIT", "EMPLOYMENT VISA"]) {
      const result = normalizeVisaType(rawValue);
      expect(result.caseType).toBe("VISA");
      expect(result.visaType).toBe("WORK");
    }
  });

  it("maps the long tail", () => {
    expect(normalizeVisaType("SEAMAN VISA").visaType).toBe("SEAMAN");
    expect(normalizeVisaType("RELATIVE VISA").visaType).toBe("RELATIVE");
    expect(normalizeVisaType("TRADE FAIR").visaType).toBe("TRADE_FAIR");
    expect(normalizeVisaType("SPORTS").visaType).toBe("SPORTS");
    expect(normalizeVisaType("TRANSIT SEA FAIR").visaType).toBe("TRANSIT");
    expect(normalizeVisaType("MDAC").visaType).toBe("MDAC");
    expect(normalizeVisaType("STP").visaType).toBe("STP");
    expect(normalizeVisaType("STR").visaType).toBe("STR");
    expect(normalizeVisaType("F VISA").visaType).toBe("F_VISA");
    expect(normalizeVisaType("VEVO").visaType).toBe("VEVO");
    expect(normalizeVisaType("E-VISA").visaType).toBe("E_VISA");
  });
});

describe("normalizeVisaType — service lines that are not visas", () => {
  it("routes attestation work to its own case type with no visa type", () => {
    for (const rawValue of ["Attestation", "DOCUMENTS ATTESTED", "DEGREE"]) {
      const result = normalizeVisaType(rawValue);
      expect(result.caseType).toBe("ATTESTATION");
      expect(result.visaType).toBeNull();
      expect(result.needsReview).toBe(false);
    }
  });

  it("routes apostille work, including the misspelling", () => {
    for (const rawValue of ["APPOSTIAL", "PCC APPOSTILE"]) {
      expect(normalizeVisaType(rawValue).caseType).toBe("APOSTILLE");
    }
  });

  it("routes passport work", () => {
    for (const rawValue of ["PASSPORT APPLY", "PASSPORT SUBMISSION"]) {
      expect(normalizeVisaType(rawValue).caseType).toBe("PASSPORT");
    }
  });
});

describe("normalizeVisaType — junk", () => {
  it("sends a date sitting in the visa-type column to review", () => {
    const result = normalizeVisaType("2025-01-03 00:00:00");
    expect(result.needsReview).toBe(true);
    expect(result.caseType).toBeNull();
  });

  it("sends the truncated territory string to review", () => {
    expect(normalizeVisaType("DOM(GUADELOUPE,ST MARTIN").needsReview).toBe(true);
  });

  it("sends blank input to review", () => {
    expect(normalizeVisaType("").needsReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/visaType`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/visaType.ts`:
```ts
import type { CaseType, VisaType } from "../statuses";

export interface VisaTypeNormalizationResult {
  caseType: CaseType | null;
  visaType: VisaType | null;
  needsReview: boolean;
  rawValue: string;
}

interface VisaTypeMapping {
  caseType: CaseType;
  visaType: VisaType | null;
}

/** Spec §6. Keys are uppercased and whitespace-collapsed. */
const MAPPING_BY_VISA_TYPE: Record<string, VisaTypeMapping> = {
  TOURIST: { caseType: "VISA", visaType: "TOURIST" },
  BUSINESS: { caseType: "VISA", visaType: "BUSINESS" },
  "EVISA - TOURIST": { caseType: "VISA", visaType: "EVISA_TOURIST" },
  "B1/B2": { caseType: "VISA", visaType: "B1_B2" },
  "FAMILY VISIT": { caseType: "VISA", visaType: "FAMILY_VISIT" },
  DEPENDENT: { caseType: "VISA", visaType: "DEPENDENT" },
  STUDY: { caseType: "VISA", visaType: "STUDY" },
  "WORK VISA": { caseType: "VISA", visaType: "WORK" },
  "WORK PERMIT": { caseType: "VISA", visaType: "WORK" },
  "EMPLOYMENT VISA": { caseType: "VISA", visaType: "WORK" },
  "SEAMAN VISA": { caseType: "VISA", visaType: "SEAMAN" },
  "RELATIVE VISA": { caseType: "VISA", visaType: "RELATIVE" },
  "TRADE FAIR": { caseType: "VISA", visaType: "TRADE_FAIR" },
  SPORTS: { caseType: "VISA", visaType: "SPORTS" },
  "TRANSIT SEA FAIR": { caseType: "VISA", visaType: "TRANSIT" },
  MDAC: { caseType: "VISA", visaType: "MDAC" },
  STP: { caseType: "VISA", visaType: "STP" },
  STR: { caseType: "VISA", visaType: "STR" },
  "F VISA": { caseType: "VISA", visaType: "F_VISA" },
  VEVO: { caseType: "VISA", visaType: "VEVO" },
  "E-VISA": { caseType: "VISA", visaType: "E_VISA" },

  // Service lines — a case type, no visa type.
  ATTESTATION: { caseType: "ATTESTATION", visaType: null },
  "DOCUMENTS ATTESTED": { caseType: "ATTESTATION", visaType: null },
  DEGREE: { caseType: "ATTESTATION", visaType: null },
  APPOSTIAL: { caseType: "APOSTILLE", visaType: null },
  "PCC APPOSTILE": { caseType: "APOSTILLE", visaType: null },
  "PASSPORT APPLY": { caseType: "PASSPORT", visaType: null },
  "PASSPORT SUBMISSION": { caseType: "PASSPORT", visaType: null },
};

export function normalizeVisaType(rawValue: string): VisaTypeNormalizationResult {
  const lookupKey = rawValue.trim().toUpperCase().replace(/\s+/g, " ");
  if (lookupKey.length === 0) {
    return { caseType: null, visaType: null, needsReview: true, rawValue };
  }
  const matchedMapping = MAPPING_BY_VISA_TYPE[lookupKey];
  if (matchedMapping === undefined) {
    return { caseType: null, visaType: null, needsReview: true, rawValue };
  }
  return {
    caseType: matchedMapping.caseType,
    visaType: matchedMapping.visaType,
    needsReview: false,
    rawValue,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/visaType`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/visaType.ts packages/shared/test/crm/normalize/visaType.test.ts
git commit -m "feat(crm): split the Visa Type column into case type and visa type"
```

---

### Task 6: Partner name normalizer (257 strings → canonical partners)

**Files:**
- Create: `packages/shared/src/crm/normalize/partner.ts`
- Test: `packages/shared/test/crm/normalize/partner.test.ts`

**Interfaces:**
- Consumes: `PartnerType` from `../statuses` (Task 1).
- Produces: `interface PartnerNormalizationResult { canonicalKey: string | null; partnerType: PartnerType; needsReview: boolean; rawValue: string }` and `normalizePartnerName(rawValue: string): PartnerNormalizationResult`.

**Context for the implementer:** the workbook holds 257 distinct partner strings for fewer real partners. `VWI`, `VWI BOM`, `VWI Mumbai` and `VWI HYDERABAD` are branches of one agency and collapse to `VWI`. `Customer A/C` is not an agency at all — it is RGS's own direct walk-in business. Two strings (`MEHUL MEHUL` / `MEHUL MANOJ`, and `SAMMY A/C`) are genuinely ambiguous and are flagged for a human, per spec §6 — they may be one person or two, and only RGS knows.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/partner.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizePartnerName } from "../../../src/crm/normalize/partner";

describe("normalizePartnerName", () => {
  it("passes an ordinary agency through as its own canonical key", () => {
    expect(normalizePartnerName("Ozzy Travels")).toEqual({
      canonicalKey: "OZZY TRAVELS",
      partnerType: "AGENCY",
      needsReview: false,
      rawValue: "Ozzy Travels",
    });
  });

  it("collapses the VWI branches onto one partner", () => {
    for (const rawValue of ["VWI", "VWI BOM", "VWI Mumbai", "VWI HYDERABAD"]) {
      const result = normalizePartnerName(rawValue);
      expect(result.canonicalKey).toBe("VWI");
      expect(result.needsReview).toBe(false);
    }
  });

  it("treats direct walk-in business as its own partner type", () => {
    const result = normalizePartnerName("Customer A/C");
    expect(result.canonicalKey).toBe("CUSTOMER A/C");
    expect(result.partnerType).toBe("DIRECT");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizePartnerName("  travefly holidays  ").canonicalKey).toBe("TRAVEFLY HOLIDAYS");
  });

  it("flags the ambiguous personal accounts for a human", () => {
    for (const rawValue of ["MEHUL MEHUL", "MEHUL MANOJ", "SAMMY A/C"]) {
      const result = normalizePartnerName(rawValue);
      expect(result.needsReview).toBe(true);
      expect(result.rawValue).toBe(rawValue);
    }
  });

  it("sends blank input to review", () => {
    expect(normalizePartnerName("").needsReview).toBe(true);
    expect(normalizePartnerName("   ").canonicalKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/partner`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/partner.ts`:
```ts
import type { PartnerType } from "../statuses";

export interface PartnerNormalizationResult {
  canonicalKey: string | null;
  partnerType: PartnerType;
  needsReview: boolean;
  rawValue: string;
}

/** Branch spellings that collapse onto one partner. */
const CANONICAL_KEY_BY_ALIAS: Record<string, string> = {
  VWI: "VWI",
  "VWI BOM": "VWI",
  "VWI MUMBAI": "VWI",
  "VWI HYDERABAD": "VWI",
};

/** RGS's own direct walk-in business, not a referral agency. */
const DIRECT_ACCOUNT_KEYS = new Set(["CUSTOMER A/C"]);

/**
 * Strings that may be one person or two. Only RGS can say, so they go to the
 * migration review queue rather than being merged or split by guess.
 */
const AMBIGUOUS_ACCOUNT_KEYS = new Set(["MEHUL MEHUL", "MEHUL MANOJ", "SAMMY A/C"]);

export function normalizePartnerName(rawValue: string): PartnerNormalizationResult {
  const lookupKey = rawValue.trim().toUpperCase().replace(/\s+/g, " ");
  if (lookupKey.length === 0) {
    return { canonicalKey: null, partnerType: "AGENCY", needsReview: true, rawValue };
  }
  if (AMBIGUOUS_ACCOUNT_KEYS.has(lookupKey)) {
    return { canonicalKey: lookupKey, partnerType: "AGENCY", needsReview: true, rawValue };
  }
  if (DIRECT_ACCOUNT_KEYS.has(lookupKey)) {
    return { canonicalKey: lookupKey, partnerType: "DIRECT", needsReview: false, rawValue };
  }
  return {
    canonicalKey: CANONICAL_KEY_BY_ALIAS[lookupKey] ?? lookupKey,
    partnerType: "AGENCY",
    needsReview: false,
    rawValue,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/partner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/partner.ts packages/shared/test/crm/normalize/partner.test.ts
git commit -m "feat(crm): canonicalize partner names and flag the ambiguous accounts"
```

---

### Task 7: Date normalizer (mixed formats → ISO date)

**Files:**
- Create: `packages/shared/src/crm/normalize/date.ts`
- Test: `packages/shared/test/crm/normalize/date.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface DateNormalizationResult { isoDate: string | null; needsReview: boolean; rawValue: string }` and `normalizeExcelDate(rawValue: string | Date | number | null | undefined): DateNormalizationResult`.

**Context for the implementer:** the workbook stores dates four ways — real Excel date cells, `30-12-2024`, `01/05/2025`, and a handful of nonsense (one row lands in 2006, several in 2027-2030). Ambiguity is the danger: `01/05/2025` could be 1 May or 5 January. RGS is an Indian business and the sheet is day-first throughout, so day-first is the rule — but any value where the day-first reading is impossible (`13/08/2025` read as month 13) falls back to month-first, and anything outside a sane window goes to review rather than importing a case dated 2006.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/normalize/date.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeExcelDate } from "../../../src/crm/normalize/date";

describe("normalizeExcelDate", () => {
  it("passes a real Date cell through", () => {
    const result = normalizeExcelDate(new Date(Date.UTC(2025, 0, 8)));
    expect(result.isoDate).toBe("2025-01-08");
    expect(result.needsReview).toBe(false);
  });

  it("reads the dash format as day-first", () => {
    expect(normalizeExcelDate("30-12-2024").isoDate).toBe("2024-12-30");
    expect(normalizeExcelDate("26-12-2024").isoDate).toBe("2024-12-26");
  });

  it("reads the slash format as day-first, matching Indian convention", () => {
    expect(normalizeExcelDate("01/05/2025").isoDate).toBe("2025-05-01");
    expect(normalizeExcelDate("02/07/2026").isoDate).toBe("2026-07-02");
  });

  it("reads a day above 12 day-first, unambiguously", () => {
    // 13 cannot be a month, so day-first resolves this outright.
    expect(normalizeExcelDate("13-08-2025").isoDate).toBe("2025-08-13");
  });

  it("falls back to month-first only when day-first is impossible", () => {
    // Day-first would mean month 13, which does not exist — so this is 13 August.
    expect(normalizeExcelDate("08-13-2025").isoDate).toBe("2025-08-13");
  });

  it("stays day-first when both readings are valid", () => {
    // 05/09 is ambiguous; the sheet is day-first, so this is 5 September.
    expect(normalizeExcelDate("05/09/2026").isoDate).toBe("2026-09-05");
  });

  it("tolerates the stray spaces the sheet contains", () => {
    expect(normalizeExcelDate("  15-11-2025 ").isoDate).toBe("2025-11-15");
    expect(normalizeExcelDate("01 /09/2026").isoDate).toBe("2026-09-01");
  });

  it("sends dates outside a sane window to review", () => {
    expect(normalizeExcelDate("01-01-2006").needsReview).toBe(true);
    expect(normalizeExcelDate("01-01-2030").needsReview).toBe(true);
  });

  it("sends unparseable and empty values to review", () => {
    expect(normalizeExcelDate("not a date").needsReview).toBe(true);
    expect(normalizeExcelDate("").needsReview).toBe(true);
    expect(normalizeExcelDate(null).needsReview).toBe(true);
    expect(normalizeExcelDate(undefined).needsReview).toBe(true);
  });

  it("preserves the original for the review queue", () => {
    expect(normalizeExcelDate("not a date").rawValue).toBe("not a date");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/normalize/date`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/crm/normalize/date.ts`:
```ts
export interface DateNormalizationResult {
  isoDate: string | null;
  needsReview: boolean;
  rawValue: string;
}

/**
 * The workbook's real business window. Rows outside it (one lands in 2006,
 * several in 2027-2030) are data-entry slips, not history.
 */
const EARLIEST_PLAUSIBLE_YEAR = 2020;
const LATEST_PLAUSIBLE_YEAR = 2027;

function toIsoDate(year: number, month: number, day: number): string {
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");
  return `${year}-${paddedMonth}-${paddedDay}`;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function isPlausibleYear(year: number): boolean {
  return year >= EARLIEST_PLAUSIBLE_YEAR && year <= LATEST_PLAUSIBLE_YEAR;
}

export function normalizeExcelDate(
  rawInput: string | Date | number | null | undefined,
): DateNormalizationResult {
  if (rawInput === null || rawInput === undefined) {
    return { isoDate: null, needsReview: true, rawValue: "" };
  }

  if (rawInput instanceof Date) {
    const rawValue = rawInput.toISOString();
    if (Number.isNaN(rawInput.getTime()) || !isPlausibleYear(rawInput.getUTCFullYear())) {
      return { isoDate: null, needsReview: true, rawValue };
    }
    return {
      isoDate: toIsoDate(
        rawInput.getUTCFullYear(),
        rawInput.getUTCMonth() + 1,
        rawInput.getUTCDate(),
      ),
      needsReview: false,
      rawValue,
    };
  }

  const rawValue = String(rawInput);
  // Strip the stray spaces the sheet contains ("01 /09/2026") before matching.
  const compactValue = rawValue.trim().replace(/\s+/g, "");
  const partsMatch = compactValue.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (partsMatch === null) {
    return { isoDate: null, needsReview: true, rawValue };
  }

  const firstNumber = Number(partsMatch[1]);
  const secondNumber = Number(partsMatch[2]);
  const year = Number(partsMatch[3]);

  if (!isPlausibleYear(year)) {
    return { isoDate: null, needsReview: true, rawValue };
  }

  // Day-first is the sheet's convention; month-first is the fallback only when
  // the day-first reading is not a real date.
  if (isRealCalendarDate(year, secondNumber, firstNumber)) {
    return { isoDate: toIsoDate(year, secondNumber, firstNumber), needsReview: false, rawValue };
  }
  if (isRealCalendarDate(year, firstNumber, secondNumber)) {
    return { isoDate: toIsoDate(year, firstNumber, secondNumber), needsReview: false, rawValue };
  }
  return { isoDate: null, needsReview: true, rawValue };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/normalize/date`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/normalize/date.ts packages/shared/test/crm/normalize/date.test.ts
git commit -m "feat(crm): normalize the workbook's four date formats to ISO dates"
```

---

### Task 8: CRM entity schemas and the line-item catalog

**Files:**
- Create: `packages/shared/src/crm/lineItems.ts`
- Create: `packages/shared/src/crm/schemas.ts`
- Test: `packages/shared/test/crm/schemas.test.ts`

**Interfaces:**
- Consumes: every const array from `./statuses` (Task 1).
- Produces: `LINE_ITEM_CATALOG` and `getLineItemDefinition(lineItemCode: string)`; Zod schemas `PartnerSchema`, `CrmTravellerSchema`, `LineItemSchema`, `CaseApplicantSchema`, `CrmCaseSchema`, `CountryProfileSchema`, `CrmMemorySchema`, `WatchdogConfigSchema`, `CrmUserPrefsSchema`, plus their inferred types `Partner`, `CrmTraveller`, `LineItem`, `CaseApplicant`, `CrmCase`, `CountryProfile`, `CrmMemory`, `WatchdogConfig`, `CrmUserPrefs`, and the constant `WATCHDOG_RULE_IDS`.

**Context for the implementer:** `CrmCaseSchema` embeds `applicants[]` inside the
case. This is deliberate and is **not** the storage shape — spec §5 stores each
applicant as its own `APPLICANT#<nn>` sort-key item under the case partition.
The schema is the domain and API shape: one object a caller can validate, send,
and reason about whole. Plan 2 owns the split on write and the reassembly on
read. Do not "fix" this mismatch by flattening the schema.

Follow the existing `packages/shared/src/schemas.ts` conventions exactly — `isoDate` / `isoDateTime` regex helpers, `z.infer` exports beside each schema. Money is stored as whole rupees in integer paise-free form (`amountInr`), matching the existing `ApplicationAmountsSchema`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/schemas.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  CaseApplicantSchema,
  CrmCaseSchema,
  CrmMemorySchema,
  LineItemSchema,
  PartnerSchema,
  WatchdogConfigSchema,
} from "../../src/crm/schemas";
import { getLineItemDefinition } from "../../src/crm/lineItems";

const validApplicant = {
  applicantRef: "31377",
  travellerId: "trv_1",
  passportNumber: "Z6931368",
  custody: "RETURNED",
  custodySince: "2025-01-01T10:00:00.000Z",
  outcome: "APPROVED",
};

const validCase = {
  tenantId: "rgs",
  caseId: "case_1",
  caseRef: "31377",
  caseType: "VISA",
  partnerId: "partner_1",
  destinationCountry: "BH",
  visaType: "EVISA_TOURIST",
  entryType: "SINGLE",
  processing: "NORMAL",
  caseStatus: "CLOSED",
  billingStatus: "PAID",
  receivedDate: "2024-12-30",
  lineItems: [],
  totalInr: 0,
  applicants: [validApplicant],
  watchdogOverrides: {},
  mutedRules: [],
  createdAt: "2024-12-30T10:00:00.000Z",
  updatedAt: "2025-01-02T10:00:00.000Z",
};

describe("CrmCaseSchema", () => {
  it("accepts a complete case", () => {
    expect(() => CrmCaseSchema.parse(validCase)).not.toThrow();
  });

  it("requires at least one applicant", () => {
    expect(() => CrmCaseSchema.parse({ ...validCase, applicants: [] })).toThrow();
  });

  it("requires a two-letter uppercase country code", () => {
    expect(() => CrmCaseSchema.parse({ ...validCase, destinationCountry: "bh" })).toThrow();
    expect(() => CrmCaseSchema.parse({ ...validCase, destinationCountry: "BHR" })).toThrow();
  });

  it("rejects a status outside the enum", () => {
    expect(() => CrmCaseSchema.parse({ ...validCase, caseStatus: "Sent on Courier" })).toThrow();
  });

  it("requires a visa type on a VISA case and forbids one elsewhere", () => {
    expect(() =>
      CrmCaseSchema.parse({ ...validCase, caseType: "VISA", visaType: undefined }),
    ).toThrow();
    expect(() =>
      CrmCaseSchema.parse({ ...validCase, caseType: "ATTESTATION", visaType: "TOURIST" }),
    ).toThrow();
  });

  it("accepts an attestation case with no visa fields", () => {
    const attestationCase = {
      ...validCase,
      caseType: "ATTESTATION",
      visaType: undefined,
      entryType: undefined,
      processing: undefined,
    };
    expect(() => CrmCaseSchema.parse(attestationCase)).not.toThrow();
  });

  it("keeps migration provenance when present", () => {
    const migratedCase = {
      ...validCase,
      billingStatus: "UNKNOWN",
      sourceSheet: "Mini CRM",
      sourceRow: 4,
      legacyRaw: { status: "Approved", entries: "Single" },
    };
    const parsed = CrmCaseSchema.parse(migratedCase);
    expect(parsed.sourceRow).toBe(4);
    expect(parsed.legacyRaw).toEqual({ status: "Approved", entries: "Single" });
  });
});

describe("CaseApplicantSchema", () => {
  it("defaults a new applicant to pending and not held", () => {
    const parsed = CaseApplicantSchema.parse({
      applicantRef: "31380",
      travellerId: "trv_2",
    });
    expect(parsed.outcome).toBe("PENDING");
    expect(parsed.custody).toBe("NOT_HELD");
  });

  it("requires a tracking number once a courier is named", () => {
    expect(() =>
      CaseApplicantSchema.parse({ ...validApplicant, courierMode: "DTDC" }),
    ).toThrow();
    expect(() =>
      CaseApplicantSchema.parse({
        ...validApplicant,
        courierMode: "DTDC",
        trackingNumber: "QG46TQUVWY",
      }),
    ).not.toThrow();
  });

  it("does not demand a tracking number for a hand-back", () => {
    expect(() =>
      CaseApplicantSchema.parse({ ...validApplicant, courierMode: "HANDOVER" }),
    ).not.toThrow();
  });
});

describe("LineItemSchema", () => {
  it("accepts a catalog item", () => {
    expect(() =>
      LineItemSchema.parse({
        code: "PHOTO_MAKING",
        label: "Photo making",
        amountInr: 150,
        quantity: 1,
        kind: "ADDON",
      }),
    ).not.toThrow();
  });

  it("rejects a negative amount", () => {
    expect(() =>
      LineItemSchema.parse({
        code: "PHOTO_MAKING",
        label: "Photo making",
        amountInr: -150,
        quantity: 1,
        kind: "ADDON",
      }),
    ).toThrow();
  });
});

describe("PartnerSchema", () => {
  it("accepts an agency with branch aliases", () => {
    const parsed = PartnerSchema.parse({
      tenantId: "rgs",
      partnerId: "partner_vwi",
      canonicalName: "VWI",
      aliases: ["VWI BOM", "VWI Mumbai", "VWI HYDERABAD"],
      partnerType: "AGENCY",
      createdAt: "2026-09-09T10:00:00.000Z",
    });
    expect(parsed.aliases).toHaveLength(3);
  });

  it("defaults aliases to empty", () => {
    const parsed = PartnerSchema.parse({
      tenantId: "rgs",
      partnerId: "partner_1",
      canonicalName: "Ozzy Travels",
      partnerType: "AGENCY",
      createdAt: "2026-09-09T10:00:00.000Z",
    });
    expect(parsed.aliases).toEqual([]);
  });
});

describe("WatchdogConfigSchema", () => {
  it("supplies the spec's default thresholds", () => {
    const parsed = WatchdogConfigSchema.parse({});
    expect(parsed.custody_held).toBe(7);
    expect(parsed.case_quiet).toBe(5);
    expect(parsed.courier_unconfirmed).toBe(4);
    expect(parsed.billing_overdue).toBe(30);
  });

  it("accepts a tenant override", () => {
    expect(WatchdogConfigSchema.parse({ custody_held: 10 }).custody_held).toBe(10);
  });

  it("rejects a threshold of zero days", () => {
    expect(() => WatchdogConfigSchema.parse({ custody_held: 0 })).toThrow();
  });
});

describe("CrmMemorySchema", () => {
  it("requires a reason trail on an agent-created memory", () => {
    expect(() =>
      CrmMemorySchema.parse({
        tenantId: "rgs",
        scope: "ORG",
        memoryKey: "ozzy-express",
        text: "Ozzy Travels always wants express processing",
        createdBy: "agent",
        createdAt: "2026-09-09T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts an agent memory that cites the case it learned from", () => {
    expect(() =>
      CrmMemorySchema.parse({
        tenantId: "rgs",
        scope: "ORG",
        memoryKey: "ozzy-express",
        text: "Ozzy Travels always wants express processing",
        createdBy: "agent",
        sourceCaseId: "case_1",
        createdAt: "2026-09-09T10:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("accepts a human memory with no source case", () => {
    expect(() =>
      CrmMemorySchema.parse({
        tenantId: "rgs",
        scope: "USER#ops@rsa-e.com",
        memoryKey: "terse",
        text: "Keep replies short",
        createdBy: "human",
        createdAt: "2026-09-09T10:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

describe("line item catalog", () => {
  it("knows the services the workbook already sells", () => {
    expect(getLineItemDefinition("PHOTO_MAKING")?.kind).toBe("ADDON");
    expect(getLineItemDefinition("GOVT_FEE")?.kind).toBe("GOVT_FEE");
    expect(getLineItemDefinition("VISA_SERVICE_FEE")?.kind).toBe("SERVICE");
    expect(getLineItemDefinition("TICKET_BOOKING")?.kind).toBe("ADDON");
  });

  it("returns undefined for an unknown code", () => {
    expect(getLineItemDefinition("NOPE")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/schemas`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the line-item catalog**

`packages/shared/src/crm/lineItems.ts`:
```ts
import type { LineItemKind } from "./statuses";

export interface LineItemDefinition {
  code: string;
  label: string;
  kind: LineItemKind;
}

/** Seeded from what the workbook already sells (spec §6). */
export const LINE_ITEM_CATALOG: readonly LineItemDefinition[] = [
  { code: "VISA_SERVICE_FEE", label: "Visa service fee", kind: "SERVICE" },
  { code: "GOVT_FEE", label: "Government / embassy fee", kind: "GOVT_FEE" },
  { code: "ATTESTATION", label: "Attestation", kind: "SERVICE" },
  { code: "APOSTILLE", label: "Apostille", kind: "SERVICE" },
  { code: "PCC", label: "Police clearance certificate", kind: "SERVICE" },
  { code: "PHOTO_MAKING", label: "Photo making", kind: "ADDON" },
  { code: "FORM_FILLING", label: "Form filling", kind: "ADDON" },
  { code: "HOTEL_BOOKING", label: "Hotel booking", kind: "ADDON" },
  { code: "TICKET_BOOKING", label: "Ticket booking", kind: "ADDON" },
  { code: "COLLECTION_CHARGE", label: "Collection charge", kind: "ADDON" },
  { code: "COURIER_CHARGE", label: "Courier charge", kind: "ADDON" },
  { code: "CHINESE_TRANSLATION", label: "Chinese translation", kind: "ADDON" },
];

const DEFINITION_BY_CODE = new Map(
  LINE_ITEM_CATALOG.map((lineItemDefinition) => [lineItemDefinition.code, lineItemDefinition]),
);

export function getLineItemDefinition(lineItemCode: string): LineItemDefinition | undefined {
  return DEFINITION_BY_CODE.get(lineItemCode);
}
```

- [ ] **Step 4: Write the schemas**

`packages/shared/src/crm/schemas.ts`:
```ts
import { z } from "zod";
import {
  APPLICANT_OUTCOMES,
  BILLING_STATUSES,
  CASE_STATUSES,
  CASE_TYPES,
  COURIER_MODES,
  CUSTODY_STATUSES,
  ENTRY_TYPES,
  LINE_ITEM_KINDS,
  PARTNER_TYPES,
  PROCESSING_SPEEDS,
  VISA_TYPES,
} from "./statuses";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const isoDateTime = z.string().datetime();
const iso2CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected ISO-3166 alpha-2");
const tenantId = z.string().min(1);

export const WATCHDOG_RULE_IDS = [
  "custody_held",
  "case_quiet",
  "appointment_docs",
  "courier_unconfirmed",
  "duplicate_passport",
  "billing_overdue",
] as const;
export type WatchdogRuleId = (typeof WATCHDOG_RULE_IDS)[number];

/** Tenant-wide defaults, in days. Spec §7. */
export const WatchdogConfigSchema = z.object({
  custody_held: z.number().int().positive().default(7),
  case_quiet: z.number().int().positive().default(5),
  courier_unconfirmed: z.number().int().positive().default(4),
  billing_overdue: z.number().int().positive().default(30),
});
export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>;

export const PartnerSchema = z.object({
  tenantId,
  partnerId: z.string().min(1),
  canonicalName: z.string().trim().min(1),
  aliases: z.array(z.string()).default([]),
  partnerType: z.enum(PARTNER_TYPES),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactWhatsapp: z.string().optional(),
  notes: z.string().optional(),
  createdAt: isoDateTime,
});
export type Partner = z.infer<typeof PartnerSchema>;

export const CrmTravellerSchema = z.object({
  tenantId,
  travellerId: z.string().min(1),
  fullName: z.string().trim().min(1),
  normalizedName: z.string().min(1),
  dateOfBirth: isoDate.optional(),
  phone: z.string().optional(),
  passportNumber: z.string().optional(),
  createdAt: isoDateTime,
});
export type CrmTraveller = z.infer<typeof CrmTravellerSchema>;

export const LineItemSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  amountInr: z.number().int().nonnegative(),
  quantity: z.number().int().positive().default(1),
  kind: z.enum(LINE_ITEM_KINDS),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const CaseApplicantSchema = z
  .object({
    applicantRef: z.string().min(1),
    travellerId: z.string().min(1),
    passportNumber: z.string().optional(),
    custody: z.enum(CUSTODY_STATUSES).default("NOT_HELD"),
    custodySince: isoDateTime.optional(),
    outcome: z.enum(APPLICANT_OUTCOMES).default("PENDING"),
    courierMode: z.enum(COURIER_MODES).optional(),
    trackingNumber: z.string().optional(),
    visaResultKey: z.string().optional(),
  })
  .refine(
    (applicant) =>
      applicant.courierMode === undefined ||
      applicant.courierMode === "HANDOVER" ||
      applicant.courierMode === "PICKUP" ||
      applicant.trackingNumber !== undefined,
    {
      message: "trackingNumber is required when the passport went out by courier",
      path: ["trackingNumber"],
    },
  );
export type CaseApplicant = z.infer<typeof CaseApplicantSchema>;

export const CrmCaseSchema = z
  .object({
    tenantId,
    caseId: z.string().min(1),
    caseRef: z.string().min(1),
    caseType: z.enum(CASE_TYPES),
    partnerId: z.string().min(1),
    destinationCountry: iso2CountryCode,
    visaType: z.enum(VISA_TYPES).optional(),
    entryType: z.enum(ENTRY_TYPES).optional(),
    processing: z.enum(PROCESSING_SPEEDS).optional(),
    validity: z.string().optional(),
    caseStatus: z.enum(CASE_STATUSES),
    billingStatus: z.enum(BILLING_STATUSES),
    receivedDate: isoDate,
    submissionDate: isoDate.optional(),
    appointmentDate: isoDate.optional(),
    expectedCollectionDate: isoDate.optional(),
    courierDate: isoDate.optional(),
    lineItems: z.array(LineItemSchema).default([]),
    totalInr: z.number().int().nonnegative().default(0),
    applicants: z.array(CaseApplicantSchema).min(1, "a case needs at least one applicant"),
    watchdogOverrides: z.record(z.string(), z.number().int().positive()).default({}),
    mutedRules: z.array(z.enum(WATCHDOG_RULE_IDS)).default([]),
    snoozedUntil: isoDateTime.optional(),
    sourceSheet: z.string().optional(),
    sourceRow: z.number().int().positive().optional(),
    legacyRaw: z.record(z.string(), z.string()).optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    createdByEmail: z.string().email().optional(),
  })
  .refine(
    (crmCase) => crmCase.caseType !== "VISA" || crmCase.visaType !== undefined,
    { message: "a VISA case needs a visaType", path: ["visaType"] },
  )
  .refine(
    (crmCase) => crmCase.caseType === "VISA" || crmCase.visaType === undefined,
    { message: "only a VISA case may carry a visaType", path: ["visaType"] },
  );
export type CrmCase = z.infer<typeof CrmCaseSchema>;

export const CountryProfileSchema = z.object({
  tenantId,
  countryCode: iso2CountryCode,
  checklistItems: z.array(z.string()).default([]),
  driveFolderUrl: z.string().url().optional(),
  processingDays: z.number().int().positive().optional(),
  notes: z.string().optional(),
  updatedAt: isoDateTime,
});
export type CountryProfile = z.infer<typeof CountryProfileSchema>;

export const CrmMemorySchema = z
  .object({
    tenantId,
    scope: z.string().min(1),
    memoryKey: z.string().min(1),
    text: z.string().trim().min(1).max(2000),
    sourceCaseId: z.string().optional(),
    createdBy: z.enum(["agent", "human"]),
    createdAt: isoDateTime,
  })
  .refine(
    (memory) => memory.createdBy !== "agent" || memory.sourceCaseId !== undefined,
    {
      message: "an agent-created memory must cite the case it learned from",
      path: ["sourceCaseId"],
    },
  );
export type CrmMemory = z.infer<typeof CrmMemorySchema>;

export const CrmUserPrefsSchema = z.object({
  tenantId,
  email: z.string().email(),
  trustLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  autoApplyOptIn: z.boolean().default(false),
  defaultFilters: z.record(z.string(), z.string()).default({}),
});
export type CrmUserPrefs = z.infer<typeof CrmUserPrefsSchema>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rgs/shared test crm/schemas`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/crm/schemas.ts packages/shared/src/crm/lineItems.ts packages/shared/test/crm/schemas.test.ts
git commit -m "feat(crm): add CRM entity schemas and the line-item catalog"
```

---

### Task 9: Barrel export and full-package green gate

**Files:**
- Create: `packages/shared/src/crm/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/crm/index.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1-8.
- Produces: `@rgs/shared/crm` surface — one import path for the domain layer, migration, agent tools and UI. Everything downstream imports from here, never from a deep path.

**Context for the implementer:** `packages/shared/src/index.ts` currently re-exports the platform modules. Add the CRM namespace beside them without disturbing existing exports — the deployed portal, admin and API all import from this file.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/crm/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  CASE_STATUSES,
  CrmCaseSchema,
  LINE_ITEM_CATALOG,
  WATCHDOG_RULE_IDS,
  canTransitionCaseStatus,
  normalizeCountry,
  normalizeEntries,
  normalizeExcelDate,
  normalizePartnerName,
  normalizeStatus,
  normalizeVisaType,
} from "../../src/crm";

describe("crm barrel export", () => {
  it("exposes the state machines", () => {
    expect(canTransitionCaseStatus("NEW", "IN_PROGRESS")).toBe(true);
    expect(CASE_STATUSES).toContain("APPOINTMENT_SET");
  });

  it("exposes every normalizer", () => {
    expect(normalizeCountry("SWISS").countryCode).toBe("CH");
    expect(normalizeEntries("Single Exp").processing).toBe("EXPRESS");
    expect(normalizeStatus("Handover").custody).toBe("RETURNED");
    expect(normalizeVisaType("APPOSTIAL").caseType).toBe("APOSTILLE");
    expect(normalizePartnerName("VWI BOM").canonicalKey).toBe("VWI");
    expect(normalizeExcelDate("30-12-2024").isoDate).toBe("2024-12-30");
  });

  it("exposes the schemas and catalogs", () => {
    expect(typeof CrmCaseSchema.parse).toBe("function");
    expect(LINE_ITEM_CATALOG.length).toBeGreaterThan(0);
    expect(WATCHDOG_RULE_IDS).toContain("custody_held");
  });
});

describe("a full Excel row survives the whole pipeline", () => {
  it("rebuilds case 31377 (Luxe Escape / Bahrain) from its raw cells", () => {
    const country = normalizeCountry("Bahrain");
    const visa = normalizeVisaType("Evisa - Tourist");
    const entries = normalizeEntries("Single");
    const status = normalizeStatus("Approved");
    const partner = normalizePartnerName("Luxe Escape");
    const receivedDate = normalizeExcelDate("30-12-2024");

    for (const result of [country, visa, entries, status, partner, receivedDate]) {
      expect(result.needsReview).toBe(false);
    }

    const rebuiltCase = CrmCaseSchema.parse({
      tenantId: "rgs",
      caseId: "case_31377",
      caseRef: "31377",
      caseType: visa.caseType,
      partnerId: "partner_luxe_escape",
      destinationCountry: country.countryCode,
      visaType: visa.visaType,
      entryType: entries.entryType,
      processing: entries.processing,
      caseStatus: status.caseStatus,
      billingStatus: "UNKNOWN",
      receivedDate: receivedDate.isoDate,
      applicants: [
        {
          applicantRef: "31377",
          travellerId: "trv_umesh",
          passportNumber: "Z6931368",
          outcome: status.outcome,
        },
      ],
      sourceSheet: "Mini CRM",
      sourceRow: 3,
      createdAt: "2024-12-30T10:00:00.000Z",
      updatedAt: "2024-12-30T10:00:00.000Z",
    });

    expect(rebuiltCase.destinationCountry).toBe("BH");
    expect(rebuiltCase.visaType).toBe("EVISA_TOURIST");
    expect(rebuiltCase.caseStatus).toBe("DECIDED");
    expect(rebuiltCase.applicants[0].outcome).toBe("APPROVED");
    expect(rebuiltCase.applicants[0].custody).toBe("NOT_HELD");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rgs/shared test crm/index`
Expected: FAIL — cannot resolve `../../src/crm`.

- [ ] **Step 3: Write the barrel and wire it into the package root**

`packages/shared/src/crm/index.ts`:
```ts
export * from "./statuses";
export * from "./stateMachines";
export * from "./schemas";
export * from "./lineItems";
export * from "./normalize/country";
export * from "./normalize/entries";
export * from "./normalize/status";
export * from "./normalize/visaType";
export * from "./normalize/partner";
export * from "./normalize/date";
```

Append to `packages/shared/src/index.ts`, leaving the existing exports untouched:
```ts
export * as crm from "./crm";
```

- [ ] **Step 4: Run the whole package suite and the typechecker**

Run: `pnpm --filter @rgs/shared test`
Expected: PASS — the new CRM suites plus every pre-existing suite (`schemas`, `statusMachine`, `countryProducts`, `sanity`) still green.

Run: `pnpm -r typecheck`
Expected: PASS across every workspace package. The CRM namespace must not break the deployed portal, admin or API, all of which import from `@rgs/shared`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/crm/index.ts packages/shared/src/index.ts packages/shared/test/crm/index.test.ts
git commit -m "feat(crm): export the CRM shared core from @rgs/shared"
```

---

## Done when

- `pnpm --filter @rgs/shared test` is green, including every pre-existing suite.
- `pnpm -r typecheck` is green across the workspace.
- Every distinct value listed in spec §6 has a passing assertion, and every unmapped value returns `needsReview: true` with `rawValue` preserved.
- No normalizer throws on any input, including `null`, `undefined` and empty string.

## Next plan

Plan 2 — domain layer and admin REST routes: `services/api/src/domain/crm/*` built on the in-memory `TableClient`, the tenant-scoped key builders from spec §5, and the `/api/v1/crm/*` routes on `AdminApiFunction`.
