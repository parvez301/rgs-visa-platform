export const SITE_NAME = "Rays Global Services";
export const APPLY_BASE_URL = "https://apply.raysglobalservices.com";
export const OFFICE_ADDRESS =
  "Flat-139, Ansal Chamber-II, 6 Bhikaji Cama Place, New Delhi-110066";
export const CONTACT_EMAIL = "info@raysglobalservices.com";
export const CONTACT_PHONE = "+91-9818067432";
export const CONTACT_PHONE_HREF = "tel:+919818067432";
export const YEARS_IN_BUSINESS = 15;

export function applyUrl(countryCode?: string): string {
  return countryCode ? `${APPLY_BASE_URL}/start?country=${countryCode}` : APPLY_BASE_URL;
}

export function formatInr(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
}
