export const ADMIN_ROLES = ["Owner", "Ops", "Finance", "Viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_SCREENS = [
  "queue",
  "activity",
  "leads",
  "notices",
  "config",
  "crm",
  "crmReview",
  "portalUser",
  "adminUsers",
] as const;
export type AdminScreen = (typeof ADMIN_SCREENS)[number];

export type ScreenAccess = "none" | "read" | "write";

const allScreensWriteExceptPortalUser = (): Record<
  AdminScreen,
  ScreenAccess
> => ({
  queue: "write",
  activity: "write",
  leads: "write",
  notices: "write",
  config: "write",
  crm: "write",
  crmReview: "write",
  portalUser: "read",
  adminUsers: "write",
});

const noneExcept = (
  access: Partial<Record<AdminScreen, ScreenAccess>>,
): Record<AdminScreen, ScreenAccess> => {
  const base = Object.fromEntries(
    ADMIN_SCREENS.map((screen) => [screen, "none" as ScreenAccess]),
  ) as Record<AdminScreen, ScreenAccess>;
  return { ...base, ...access };
};

export const SCREEN_ACCESS: Record<
  AdminRole,
  Record<AdminScreen, ScreenAccess>
> = {
  Owner: allScreensWriteExceptPortalUser(),
  Ops: noneExcept({
    queue: "write",
    activity: "write",
    leads: "write",
    notices: "write",
    crm: "write",
    crmReview: "write",
    portalUser: "read",
  }),
  Finance: noneExcept({
    activity: "write",
    crm: "write",
    portalUser: "read",
  }),
  Viewer: noneExcept({
    queue: "read",
    activity: "read",
    crm: "read",
    portalUser: "read",
  }),
};

export function primaryRole(roles: readonly string[]): AdminRole | null {
  const roleSet = new Set(roles);
  for (const role of ADMIN_ROLES) {
    if (roleSet.has(role)) {
      return role;
    }
  }
  return null;
}

function screenAccessForRole(
  role: AdminRole | null,
  screen: AdminScreen,
): ScreenAccess {
  if (role === null) {
    return "none";
  }
  return SCREEN_ACCESS[role][screen];
}

export function canAccessScreen(
  role: AdminRole | null,
  screen: AdminScreen,
): boolean {
  return screenAccessForRole(role, screen) !== "none";
}

export function canWriteScreen(
  role: AdminRole | null,
  screen: AdminScreen,
): boolean {
  return screenAccessForRole(role, screen) === "write";
}
