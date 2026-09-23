import type { AdminScreen } from "@rgs/shared";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAdminAccess } from "../lib/adminAccess";

export function RequireScreen({
  screen,
  write = false,
  children,
}: {
  screen: AdminScreen;
  write?: boolean;
  children: ReactNode;
}) {
  const access = useAdminAccess();
  const isAllowed = write ? access.canWrite(screen) : access.canAccess(screen);

  if (!isAllowed) return <Navigate to="/no-access" replace />;
  return <>{children}</>;
}
