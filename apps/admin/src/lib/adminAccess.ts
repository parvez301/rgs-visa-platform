import {
  canAccessScreen,
  canWriteScreen,
  type AdminScreen,
} from "@rgs/shared";
import { useCallback } from "react";
import { useAuth } from "./auth";

export function useAdminAccess() {
  const { primaryRole } = useAuth();

  return {
    primaryRole,
    canAccess: useCallback(
      (screen: AdminScreen) => canAccessScreen(primaryRole, screen),
      [primaryRole],
    ),
    canWrite: useCallback(
      (screen: AdminScreen) => canWriteScreen(primaryRole, screen),
      [primaryRole],
    ),
  };
}
