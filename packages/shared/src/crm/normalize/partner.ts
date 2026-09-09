import type { PartnerType } from "../statuses";
import { buildLookupKey } from "./lookupKey";

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

export function normalizePartnerName(rawValue: unknown): PartnerNormalizationResult {
  if (typeof rawValue !== "string") {
    return {
      canonicalKey: null,
      partnerType: "AGENCY",
      needsReview: true,
      rawValue: rawValue == null ? "" : String(rawValue),
    };
  }
  const lookupKey = buildLookupKey(rawValue);
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
