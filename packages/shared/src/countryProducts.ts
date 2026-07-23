import type { DocType } from "./statuses";

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
    // Home Affairs discourages booking flights before grant — no itinerary here
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "ITR", "EMPLOYMENT_PROOF"],
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
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "ITR", "EMPLOYMENT_PROOF"],
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
    docsRequired: ["PASSPORT_BIO", "PHOTO", "BANK_STATEMENT", "EMPLOYMENT_PROOF"],
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
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING"],
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
    processingDays: 3,
    // Yellow fever certificate mandatory for all arrivals into Uganda
    docsRequired: ["PASSPORT_BIO", "PHOTO", "YELLOW_FEVER_CERT", "FLIGHT_ITINERARY"],
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
    governmentFeeInr: 21500,
    serviceFeeInr: 2500,
    processingDays: 5,
    docsRequired: ["PASSPORT_BIO", "PHOTO", "FLIGHT_ITINERARY", "HOTEL_BOOKING", "BANK_STATEMENT"],
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
