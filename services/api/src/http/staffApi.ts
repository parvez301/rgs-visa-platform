import { ADMIN_ROLES } from "@rgs/shared";
import { z } from "zod";
import {
  disableStaff,
  enableStaff,
  inviteStaff,
  listStaff,
  setStaffRole,
} from "../domain/admin/staff";
import type { AppContext } from "../lib/context";
import type { CognitoAdminsClient } from "../lib/cognitoAdmins";
import { requireRole } from "./adminAccess";
import { parseBody, Router } from "./router";

const StaffInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ADMIN_ROLES),
});

const StaffRoleSchema = z.object({
  role: z.enum(ADMIN_ROLES),
});

export function registerStaffRoutes(
  adminRouter: Router,
  context: AppContext,
): Router {
  return adminRouter
    .add("GET", "/api/v1/admin/staff", async (requestContext) => {
      requireRole(requestContext, ["Owner"]);
      return listStaff(requireCognitoAdmins(context));
    })
    .add("POST", "/api/v1/admin/staff", async (requestContext) => {
      const { adminEmail } = requireRole(requestContext, ["Owner"]);
      const input = parseBody(StaffInviteSchema, requestContext.body);
      return inviteStaff(
        requireCognitoAdmins(context),
        input,
        adminEmail,
      );
    })
    .add(
      "PUT",
      "/api/v1/admin/staff/{username}/role",
      async (requestContext) => {
        requireRole(requestContext, ["Owner"]);
        const { role } = parseBody(StaffRoleSchema, requestContext.body);
        await setStaffRole(
          requireCognitoAdmins(context),
          requestContext.pathParams["username"]!,
          role,
          requestContext.callerUsername,
        );
        return { updated: true };
      },
    )
    .add(
      "POST",
      "/api/v1/admin/staff/{username}/disable",
      async (requestContext) => {
        requireRole(requestContext, ["Owner"]);
        await disableStaff(
          requireCognitoAdmins(context),
          requestContext.pathParams["username"]!,
          requestContext.callerUsername,
        );
        return { disabled: true };
      },
    )
    .add(
      "POST",
      "/api/v1/admin/staff/{username}/enable",
      async (requestContext) => {
        requireRole(requestContext, ["Owner"]);
        await enableStaff(
          requireCognitoAdmins(context),
          requestContext.pathParams["username"]!,
        );
        return { enabled: true };
      },
    );
}

function requireCognitoAdmins(context: AppContext): CognitoAdminsClient {
  if (context.cognitoAdmins === undefined) {
    throw new Error("Staff administration is not configured");
  }
  return context.cognitoAdmins;
}
