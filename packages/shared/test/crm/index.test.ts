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
  summariseApplicants,
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

  it("exposes the applicant roll-up", () => {
    expect(summariseApplicants([{ custody: "WITH_RGS", outcome: "PENDING" }])).toEqual({
      count: 1,
      custody: { WITH_RGS: 1 },
      outcome: { PENDING: 1 },
    });
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
    expect(rebuiltCase.applicants[0]!.outcome).toBe("APPROVED");
    expect(rebuiltCase.applicants[0]!.custody).toBe("NOT_HELD");
  });
});
