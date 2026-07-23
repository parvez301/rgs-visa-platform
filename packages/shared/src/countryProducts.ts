import { z } from "zod";
import { DOC_TYPES, type DocType } from "./statuses";

export const VISA_TYPES = [
  "E_VISA",
  "ASSISTED",
  "VISA_ON_ARRIVAL",
  "VISA_FREE",
  "ETA",
] as const;
export type VisaType = (typeof VISA_TYPES)[number];

export const REGIONS = [
  "ASIA",
  "MIDDLE_EAST",
  "EUROPE",
  "AFRICA",
  "AMERICAS",
  "OCEANIA",
] as const;
export type Region = (typeof REGIONS)[number];

/** FULFILLED = travellers can apply through the portal; INFO_ONLY = informational page + enquiry CTA. */
export const COUNTRY_TIERS = ["FULFILLED", "INFO_ONLY"] as const;
export type CountryTier = (typeof COUNTRY_TIERS)[number];

export interface CountryProduct {
  countryCode: string;
  productCode: string;
  countryName: string;
  visaType: VisaType;
  region: Region;
  tier: CountryTier;
  validityDays: number;
  stayDays: number;
  entry: "SINGLE" | "MULTIPLE";
  governmentFeeInr: number;
  serviceFeeInr: number;
  processingDays: number;
  docsRequired: readonly DocType[];
  active: boolean;
  /** Official government source for the facts — shown for trust, used at review time. */
  officialUrl?: string;
}

/** Validates admin-edited config rows; the DB copy is the runtime source of truth. */
export const CountryProductSchema = z
  .object({
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    productCode: z.string().min(1),
    countryName: z.string().min(1),
    visaType: z.enum(VISA_TYPES),
    region: z.enum(REGIONS),
    tier: z.enum(COUNTRY_TIERS),
    validityDays: z.number().int().positive(),
    stayDays: z.number().int().positive(),
    entry: z.enum(["SINGLE", "MULTIPLE"]),
    governmentFeeInr: z.number().int().nonnegative(),
    serviceFeeInr: z.number().int().nonnegative(),
    processingDays: z.number().int().positive(),
    docsRequired: z.array(z.enum(DOC_TYPES)),
    active: z.boolean(),
    officialUrl: z.string().url().optional(),
  })
  .refine(
    (countryProduct) =>
      countryProduct.tier !== "FULFILLED" || countryProduct.docsRequired.length > 0,
    { message: "Fulfilled countries need a documents checklist", path: ["docsRequired"] },
  ) satisfies z.ZodType<CountryProduct>;

interface ResearchSeed {
  code: string;
  name: string;
  visaType: VisaType;
  region: Region;
  validityDays: number;
  stayDays: number;
  entry: "SINGLE" | "MULTIPLE";
  governmentFeeInr: number;
  processingDays: number;
  officialUrl: string;
}

/**
 * Research batch 1 (2026-07-23): top Indian outbound destinations, facts from
 * official government sources (see docs/research/2026-07-23-batch-1-countries.md).
 * Seeded INACTIVE and INFO_ONLY — the owner verifies fees/rules in the admin
 * Config screen, sets a service fee and docs checklist, then activates.
 */
function researchSeed(seed: ResearchSeed): CountryProduct {
  return {
    countryCode: seed.code,
    productCode: `${seed.code}_TOURIST_INFO`,
    countryName: seed.name,
    visaType: seed.visaType,
    region: seed.region,
    tier: "INFO_ONLY",
    validityDays: seed.validityDays,
    stayDays: seed.stayDays,
    entry: seed.entry,
    governmentFeeInr: seed.governmentFeeInr,
    serviceFeeInr: 0,
    processingDays: seed.processingDays,
    docsRequired: [],
    active: false,
    officialUrl: seed.officialUrl,
  };
}

const RESEARCH_BATCH_1_SEEDS: readonly ResearchSeed[] = [
  { code: "SG", name: "Singapore", visaType: "E_VISA", region: "ASIA", validityDays: 63, stayDays: 30, entry: "MULTIPLE", governmentFeeInr: 2600, processingDays: 4, officialUrl: "https://www.ica.gov.sg" },
  { code: "TH", name: "Thailand", visaType: "VISA_FREE", region: "ASIA", validityDays: 60, stayDays: 60, entry: "SINGLE", governmentFeeInr: 0, processingDays: 1, officialUrl: "https://www.mfa.go.th" },
  { code: "MY", name: "Malaysia", visaType: "VISA_FREE", region: "ASIA", validityDays: 30, stayDays: 30, entry: "SINGLE", governmentFeeInr: 0, processingDays: 1, officialUrl: "https://www.imi.gov.my" },
  { code: "VN", name: "Vietnam", visaType: "E_VISA", region: "ASIA", validityDays: 90, stayDays: 90, entry: "SINGLE", governmentFeeInr: 2100, processingDays: 5, officialUrl: "https://evisa.xuatnhapcanh.gov.vn" },
  { code: "ID", name: "Indonesia", visaType: "VISA_ON_ARRIVAL", region: "ASIA", validityDays: 30, stayDays: 30, entry: "SINGLE", governmentFeeInr: 2700, processingDays: 1, officialUrl: "https://molina.imigrasi.go.id" },
  { code: "LK", name: "Sri Lanka", visaType: "ETA", region: "ASIA", validityDays: 30, stayDays: 30, entry: "MULTIPLE", governmentFeeInr: 0, processingDays: 2, officialUrl: "https://eta.gov.lk" },
  { code: "NP", name: "Nepal", visaType: "VISA_FREE", region: "ASIA", validityDays: 365, stayDays: 365, entry: "MULTIPLE", governmentFeeInr: 0, processingDays: 1, officialUrl: "https://www.immigration.gov.np" },
  { code: "MV", name: "Maldives", visaType: "VISA_ON_ARRIVAL", region: "ASIA", validityDays: 30, stayDays: 30, entry: "SINGLE", governmentFeeInr: 0, processingDays: 1, officialUrl: "https://immigration.gov.mv" },
  { code: "KH", name: "Cambodia", visaType: "E_VISA", region: "ASIA", validityDays: 90, stayDays: 30, entry: "SINGLE", governmentFeeInr: 2500, processingDays: 3, officialUrl: "https://www.evisa.gov.kh" },
  { code: "PH", name: "Philippines", visaType: "ASSISTED", region: "ASIA", validityDays: 90, stayDays: 59, entry: "SINGLE", governmentFeeInr: 3000, processingDays: 10, officialUrl: "https://evisa.gov.ph" },
  { code: "JP", name: "Japan", visaType: "ASSISTED", region: "ASIA", validityDays: 90, stayDays: 15, entry: "SINGLE", governmentFeeInr: 1700, processingDays: 5, officialUrl: "https://www.mofa.go.jp" },
  { code: "KR", name: "South Korea", visaType: "ASSISTED", region: "ASIA", validityDays: 90, stayDays: 90, entry: "SINGLE", governmentFeeInr: 3400, processingDays: 10, officialUrl: "https://www.visa.go.kr" },
  { code: "CN", name: "China", visaType: "ASSISTED", region: "ASIA", validityDays: 90, stayDays: 30, entry: "SINGLE", governmentFeeInr: 3900, processingDays: 5, officialUrl: "https://www.visaforchina.cn" },
  { code: "HK", name: "Hong Kong", visaType: "ETA", region: "ASIA", validityDays: 180, stayDays: 14, entry: "MULTIPLE", governmentFeeInr: 0, processingDays: 1, officialUrl: "https://www.immd.gov.hk" },
  { code: "TR", name: "Türkiye", visaType: "ASSISTED", region: "MIDDLE_EAST", validityDays: 180, stayDays: 30, entry: "SINGLE", governmentFeeInr: 5100, processingDays: 15, officialUrl: "https://www.mfa.gov.tr" },
  { code: "GE", name: "Georgia", visaType: "E_VISA", region: "EUROPE", validityDays: 120, stayDays: 30, entry: "SINGLE", governmentFeeInr: 2100, processingDays: 5, officialUrl: "https://www.evisa.gov.ge" },
  { code: "AM", name: "Armenia", visaType: "E_VISA", region: "EUROPE", validityDays: 120, stayDays: 21, entry: "SINGLE", governmentFeeInr: 2600, processingDays: 3, officialUrl: "https://evisa.mfa.am" },
  { code: "AZ", name: "Azerbaijan", visaType: "E_VISA", region: "EUROPE", validityDays: 90, stayDays: 30, entry: "SINGLE", governmentFeeInr: 2200, processingDays: 3, officialUrl: "https://evisa.gov.az" },
  { code: "EG", name: "Egypt", visaType: "E_VISA", region: "AFRICA", validityDays: 90, stayDays: 30, entry: "SINGLE", governmentFeeInr: 2100, processingDays: 5, officialUrl: "https://visa2egypt.gov.eg" },
  { code: "KE", name: "Kenya", visaType: "ETA", region: "AFRICA", validityDays: 90, stayDays: 90, entry: "SINGLE", governmentFeeInr: 2900, processingDays: 3, officialUrl: "https://www.etakenya.go.ke" },
  { code: "US", name: "United States", visaType: "ASSISTED", region: "AMERICAS", validityDays: 3650, stayDays: 180, entry: "MULTIPLE", governmentFeeInr: 15500, processingDays: 60, officialUrl: "https://travel.state.gov" },
  { code: "GB", name: "United Kingdom", visaType: "ASSISTED", region: "EUROPE", validityDays: 180, stayDays: 180, entry: "MULTIPLE", governmentFeeInr: 12300, processingDays: 15, officialUrl: "https://www.gov.uk/standard-visitor-visa" },
  { code: "FR", name: "France (Schengen)", visaType: "ASSISTED", region: "EUROPE", validityDays: 180, stayDays: 90, entry: "MULTIPLE", governmentFeeInr: 8100, processingDays: 15, officialUrl: "https://france-visas.gouv.fr" },
  { code: "DE", name: "Germany (Schengen)", visaType: "ASSISTED", region: "EUROPE", validityDays: 180, stayDays: 90, entry: "MULTIPLE", governmentFeeInr: 8100, processingDays: 15, officialUrl: "https://digital.diplo.de" },
  { code: "IT", name: "Italy (Schengen)", visaType: "ASSISTED", region: "EUROPE", validityDays: 180, stayDays: 90, entry: "MULTIPLE", governmentFeeInr: 8100, processingDays: 15, officialUrl: "https://vistoperitalia.esteri.it" },
  { code: "NL", name: "Netherlands (Schengen)", visaType: "ASSISTED", region: "EUROPE", validityDays: 180, stayDays: 90, entry: "MULTIPLE", governmentFeeInr: 8100, processingDays: 15, officialUrl: "https://www.netherlandsandyou.nl" },
];

const RESEARCH_BATCH_1: readonly CountryProduct[] = RESEARCH_BATCH_1_SEEDS.map(researchSeed);

// Launch seed values (fees in INR, processing in working days). Owner-editable;
// moves to admin-managed DB config post-v1.
export const COUNTRY_PRODUCTS: readonly CountryProduct[] = [
  ...RESEARCH_BATCH_1,
  {
    countryCode: "AE",
    productCode: "AE_TOURIST_30D_SINGLE",
    region: "MIDDLE_EAST",
    tier: "FULFILLED",
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
    region: "OCEANIA",
    tier: "FULFILLED",
    countryName: "Australia",
    visaType: "ASSISTED",
    validityDays: 365,
    stayDays: 90,
    entry: "MULTIPLE",
    governmentFeeInr: 10800,
    serviceFeeInr: 3500,
    processingDays: 30,
    // Home Affairs discourages booking flights before grant — no itinerary here
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "ITR", "EMPLOYMENT_PROOF"],
    active: true,
  },
  {
    countryCode: "CA",
    productCode: "CA_VISITOR_TRV",
    region: "AMERICAS",
    tier: "FULFILLED",
    countryName: "Canada",
    visaType: "ASSISTED",
    validityDays: 3650,
    stayDays: 180,
    entry: "MULTIPLE",
    governmentFeeInr: 7500,
    serviceFeeInr: 3500,
    processingDays: 45,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "ITR", "EMPLOYMENT_PROOF"],
    active: true,
  },
  {
    countryCode: "NZ",
    productCode: "NZ_VISITOR",
    region: "OCEANIA",
    tier: "FULFILLED",
    countryName: "New Zealand",
    visaType: "ASSISTED",
    validityDays: 270,
    stayDays: 90,
    entry: "MULTIPLE",
    governmentFeeInr: 17500,
    serviceFeeInr: 3500,
    processingDays: 30,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "EMPLOYMENT_PROOF"],
    active: true,
  },
  {
    countryCode: "TZ",
    productCode: "TZ_TOURIST_EVISA",
    region: "AFRICA",
    tier: "FULFILLED",
    countryName: "Tanzania",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 90,
    entry: "SINGLE",
    governmentFeeInr: 4300,
    serviceFeeInr: 1500,
    processingDays: 7,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING"],
    active: true,
  },
  {
    countryCode: "UG",
    productCode: "UG_TOURIST_EVISA",
    region: "AFRICA",
    tier: "FULFILLED",
    countryName: "Uganda",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 45,
    entry: "SINGLE",
    governmentFeeInr: 4300,
    serviceFeeInr: 1500,
    processingDays: 3,
    // Yellow fever certificate mandatory for all arrivals into Uganda
    docsRequired: ["PASSPORT_BIO", "PHOTO", "YELLOW_FEVER_CERT", "FLIGHT_ITINERARY"],
    active: true,
  },
  {
    countryCode: "NG",
    productCode: "NG_TOURIST_EVISA",
    region: "AFRICA",
    tier: "FULFILLED",
    countryName: "Nigeria",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 21500,
    serviceFeeInr: 2500,
    processingDays: 5,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING", "BANK_STATEMENT"],
    active: true,
  },
  {
    countryCode: "ZM",
    productCode: "ZM_TOURIST_EVISA",
    region: "AFRICA",
    tier: "FULFILLED",
    countryName: "Zambia",
    visaType: "E_VISA",
    validityDays: 90,
    stayDays: 30,
    entry: "SINGLE",
    governmentFeeInr: 2200,
    serviceFeeInr: 1500,
    processingDays: 7,
    // Cover letter addressed to the Director General of Immigration
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING", "COVER_LETTER"],
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

/** Countries travellers can actually apply for through the portal. */
export function isApplyable(countryProduct: CountryProduct): boolean {
  return countryProduct.active && countryProduct.tier === "FULFILLED";
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
