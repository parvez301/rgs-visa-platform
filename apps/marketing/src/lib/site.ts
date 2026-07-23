export const SITE_NAME = "Rays Global Services";
// Staging portal by default; prod build overrides via NEXT_PUBLIC_APPLY_URL
// once apply.raysglobalservices.com DNS exists (Plan 7 cutover).
export const APPLY_BASE_URL =
  process.env.NEXT_PUBLIC_APPLY_URL ?? "https://d1s2d74oqq75i0.cloudfront.net";
export const OFFICE_ADDRESS =
  "Flat-139, Ansal Chamber-II, 6 Bhikaji Cama Place, New Delhi-110066";
export const CONTACT_EMAIL = "info@raysglobalservices.com";
export const CONTACT_PHONE = "+91-9818067432";
export const CONTACT_PHONE_HREF = "tel:+919818067432";
export const YEARS_IN_BUSINESS = 15;

export function applyUrl(countryCode?: string): string {
  return countryCode ? `${APPLY_BASE_URL}/?country=${countryCode}` : APPLY_BASE_URL;
}

export function formatInr(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
}
