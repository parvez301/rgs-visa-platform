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

  it("rejects a typo'd watchdog rule id and accepts a valid one", () => {
    expect(() =>
      CrmCaseSchema.parse({
        ...validCase,
        watchdogOverrides: { custody_helD: 14, totally_made_up_rule: 99 },
      }),
    ).toThrow();
    expect(() =>
      CrmCaseSchema.parse({
        ...validCase,
        watchdogOverrides: { custody_held: 14 },
      }),
    ).not.toThrow();
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

  it("parses a couriered applicant without a tracking number, since the spec marks it optional", () => {
    expect(() =>
      CaseApplicantSchema.parse({ ...validApplicant, courierMode: "DTDC" }),
    ).not.toThrow();
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
