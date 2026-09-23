import { canAccessScreen, type AdminRole, type AdminScreen } from "@rgs/shared";

export interface AdminNavLink {
  label: string;
  to: string;
  screen: AdminScreen;
}

/**
 * Nav order doubles as landing priority: the first entry a role can reach is
 * where it lands after sign-in.
 */
export const ADMIN_NAV_LINKS: readonly AdminNavLink[] = [
  { label: "Queue", to: "/", screen: "queue" },
  { label: "Activity", to: "/activity", screen: "activity" },
  { label: "Leads", to: "/leads", screen: "leads" },
  { label: "Notices", to: "/notices", screen: "notices" },
  { label: "Config", to: "/config", screen: "config" },
  { label: "CRM", to: "/crm", screen: "crm" },
  { label: "Users", to: "/admin/users", screen: "adminUsers" },
] as const;

/**
 * Where a role should land. Finance has no `queue` access, so sending it to
 * `/` would bounce it straight to `/no-access` -- a dead end with no nav --
 * despite having Activity and the whole CRM.
 */
export function landingPath(role: AdminRole | null): string {
  const firstReachable = ADMIN_NAV_LINKS.find((navLink) =>
    canAccessScreen(role, navLink.screen),
  );
  return firstReachable?.to ?? "/no-access";
}
