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

  it("never throws on a non-string cell, routing it to review instead", () => {
    expect(() => normalizeVisaType(undefined)).not.toThrow();
    expect(normalizeVisaType(undefined).needsReview).toBe(true);
    expect(normalizeVisaType(undefined).rawValue).toBe("");

    expect(() => normalizeVisaType(null)).not.toThrow();
    expect(normalizeVisaType(null).needsReview).toBe(true);
    expect(normalizeVisaType(null).rawValue).toBe("");

    // The spec documents a date sitting in the Visa Type column.
    const dateInVisaTypeColumn = new Date("2025-01-03");
    expect(() => normalizeVisaType(dateInVisaTypeColumn)).not.toThrow();
    const dateResult = normalizeVisaType(dateInVisaTypeColumn);
    expect(dateResult.needsReview).toBe(true);
    expect(dateResult.rawValue).toBe(String(dateInVisaTypeColumn));
  });
});
