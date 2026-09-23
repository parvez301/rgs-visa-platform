import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAdminAccess } from "../lib/adminAccess";
import { landingPath } from "../lib/navLinks";

/**
 * `/` is the Queue, which Finance cannot see. Rather than the generic
 * `RequireScreen` bounce to `/no-access`, send a role that has other screens
 * to the first one it can reach. Everything funnels through here -- the
 * post-sign-in redirect, the logo link and the catch-all route -- so no role
 * with any access can land on a dead end.
 */
export function HomeRoute({ children }: { children: ReactNode }) {
  const { primaryRole, canAccess } = useAdminAccess();
  if (!canAccess("queue")) return <Navigate to={landingPath(primaryRole)} replace />;
  return <>{children}</>;
}
