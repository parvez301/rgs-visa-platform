export const SITE_NAME = "Rays Global Services";
// Until marketing.raysglobalservices.com is signed off onto the apex,
// prod builds bake app. as the portal. Override with NEXT_PUBLIC_APPLY_URL.
export const APPLY_BASE_URL =
  process.env.NEXT_PUBLIC_APPLY_URL ?? "https://app.raysglobalservices.com";
export const OFFICE_ADDRESS =
  "Flat-139, Ansal Chamber-II, 6 Bhikaji Cama Place, New Delhi-110066";
export const CONTACT_EMAIL = "info@raysglobalservices.com";
export const CONTACT_PHONE = "+91-9818067432";
export const CONTACT_PHONE_HREF = "tel:+919818067432";
export const CONTACT_PHONE_ALT = "+91-9599717431";
export const CONTACT_PHONE_ALT_HREF = "tel:+919599717431";
/** Matches the live raysglobalservices.com contact page. */
export const OFFICE_HOURS = "Mon–Sun, 9:30am–6:30pm IST";
export const SOCIAL_LINKS = [
  {
    name: "Facebook",
    href: "https://www.facebook.com/raysglobalservice/",
  },
  {
    name: "Instagram",
    href: "https://www.instagram.com/raysglobalservices/",
  },
  {
    name: "X",
    href: "https://x.com/raysglobal05",
  },
  {
    name: "YouTube",
    href: "https://www.youtube.com/@RaysGlobalService",
  },
] as const;
export const YEARS_IN_BUSINESS = 15;

export function applyUrl(countryCode?: string): string {
  return countryCode ? `${APPLY_BASE_URL}/?country=${countryCode}` : APPLY_BASE_URL;
}

export function formatInr(amount: number): string {
  return `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
}
