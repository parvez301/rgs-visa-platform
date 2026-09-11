import type { VisaType } from "../statuses";
import { buildLookupKey } from "./lookupKey";

export interface CountryNormalizationResult {
  countryCode: string | null;
  visaTypeHint: VisaType | null;
  needsReview: boolean;
  rawValue: string;
}

/** Country spellings observed in the workbook, mapped to ISO-3166 alpha-2. */
const COUNTRY_CODE_BY_SPELLING: Record<string, string> = {
  ALGERIA: "DZ", ARMENIA: "AM", AUSTRALIA: "AU", AUSTRIA: "AT", AZERBAIJAN: "AZ",
  BAHRAIN: "BH", BANGLADESH: "BD", BELGIUM: "BE", BOLIVIA: "BO",
  BOTSWANA: "BW", BRAZIL: "BR", "BURKINA FASO": "BF", CAMBODIA: "KH",
  CAMEROON: "CM", CANADA: "CA", CHILE: "CL", CHINA: "CN",
  COLOMBIA: "CO", CONGO: "CG", "COTE D'IVOIRE (IVORY COAST)": "CI",
  "IVORY COAST": "CI", CROATIA: "HR", CROTIA: "HR", "CZECH GROUP": "CZ",
  "CZECH REPUBLIC": "CZ", DENMARK: "DK",
  "DOMINICAN REPUBLIC": "DO", DUBAI: "AE", EGYPT: "EG", ESTONIA: "EE",
  ETHIOPIA: "ET", ETHOPIA: "ET", FINLAND: "FI", FRANCE: "FR",
  GEORGIA: "GE", GERMANY: "DE", GHANA: "GH", GREECE: "GR",
  "HONG KONG": "HK", HUNGARY: "HU", ICELAND: "IS", INDONESIA: "ID",
  IRELAND: "IE", ISRAEL: "IL", ITALY: "IT", JAPAN: "JP",
  KENYA: "KE", KOREA: "KR", "SOUTH KOREA": "KR", LATVIA: "LV",
  LUXEMBOURG: "LU", LEXUMBOURG: "LU",
  MALAYSIA: "MY", MALI: "ML", MALTA: "MT", MAURITIUS: "MU",
  MEXICO: "MX", MONGOLIA: "MN", MOROCCO: "MA",
  MYANMAR: "MM", MYANNMAR: "MM", NAMIBIA: "NA",
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

export function normalizeCountry(rawValue: unknown): CountryNormalizationResult {
  if (typeof rawValue !== "string") {
    return {
      countryCode: null,
      visaTypeHint: null,
      needsReview: true,
      rawValue: rawValue == null ? "" : String(rawValue),
    };
  }
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
