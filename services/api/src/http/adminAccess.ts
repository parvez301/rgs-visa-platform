import {
  canAccessScreen,
  canWriteScreen,
  primaryRole,
  type AdminRole,
  type AdminScreen,
} from "@rgs/shared";
import { forbidden } from "../lib/errors";
import type { RequestContext } from "./router";

export interface AdminIdentity {
  adminId: string;
  adminEmail: string;
  role: AdminRole;
}

export function parseCognitoGroupsClaim(claim: unknown): string[] {
  if (claim === undefined || claim === null) return [];

  let parsedClaim: unknown = claim;
  if (typeof claim === "string") {
    try {
      parsedClaim = JSON.parse(claim);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsedClaim) || !parsedClaim.every((group) => typeof group === "string")) {
    return [];
  }
  return parsedClaim;
}

export function requireAdmin(requestContext: RequestContext): AdminIdentity {
  const role = primaryRole(requestContext.roles);
  if (!requestContext.callerId || role === null) {
    throw forbidden("Admin sign in and role required");
  }
  return {
    adminId: requestContext.callerId,
    adminEmail: requestContext.callerEmail,
    role,
  };
}

export function requireRole(
  requestContext: RequestContext,
  allowedRoles: readonly AdminRole[],
): AdminIdentity {
  const admin = requireAdmin(requestContext);
  if (!allowedRoles.includes(admin.role)) {
    throw forbidden();
  }
  return admin;
}

export function requireScreen(
  requestContext: RequestContext,
  screen: AdminScreen,
): AdminIdentity {
  const admin = requireAdmin(requestContext);
  if (!canAccessScreen(admin.role, screen)) {
    throw forbidden();
  }
  return admin;
}

export function requireWrite(
  requestContext: RequestContext,
  screen: AdminScreen,
): AdminIdentity {
  const admin = requireAdmin(requestContext);
  if (!canWriteScreen(admin.role, screen)) {
    throw forbidden();
  }
  return admin;
}
