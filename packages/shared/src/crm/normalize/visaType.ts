import type { CaseType, VisaType } from "../statuses";
import { buildLookupKey } from "./lookupKey";

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

export function normalizeVisaType(rawValue: unknown): VisaTypeNormalizationResult {
  if (typeof rawValue !== "string") {
    return {
      caseType: null,
      visaType: null,
      needsReview: true,
      rawValue: rawValue == null ? "" : String(rawValue),
    };
  }
  const lookupKey = buildLookupKey(rawValue);
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
