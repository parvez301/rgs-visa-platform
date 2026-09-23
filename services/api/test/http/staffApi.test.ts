import type { AdminRole } from "@rgs/shared";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdminRouter } from "../../src/http/adminApi";
import { buildProductionContext } from "../../src/http/handler";
import {
  AwsCognitoAdmins,
  InMemoryCognitoAdmins,
} from "../../src/lib/cognitoAdmins";
import { buildTestContext, type TestContext } from "../helpers";

interface ApiResponse {
  statusCode: number;
  body: string;
}

function event(
  method: string,
  path: string,
  role: AdminRole = "Owner",
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: {
        jwt: {
          claims: {
            sub: role === "Owner" ? "owner-sub" : "ops-sub",
            email: `${role.toLowerCase()}@rgs.test`,
            "cognito:username":
              role === "Owner" ? "owner-cognito-username" : "ops-cognito-username",
            "cognito:groups": JSON.stringify([role]),
          },
        },
      },
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  } as unknown as APIGatewayProxyEventV2;
}

describe("staff admin routes", () => {
  let context: TestContext;
  let cognitoAdmins: InMemoryCognitoAdmins;

  beforeEach(() => {
    context = buildTestContext();
    cognitoAdmins = new InMemoryCognitoAdmins([
      {
        username: "owner-cognito-username",
        email: "owner@rgs.test",
        groups: ["Owner"],
        status: "CONFIRMED",
        enabled: true,
      },
    ]);
    context.cognitoAdmins = cognitoAdmins;
  });

  it("lists Cognito staff with their primary roles", async () => {
    const response = (await buildAdminRouter(context).dispatch(
      event("GET", "/api/v1/admin/staff"),
    )) as ApiResponse;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        username: "owner-cognito-username",
        email: "owner@rgs.test",
        role: "Owner",
        status: "CONFIRMED",
        enabled: true,
      },
    ]);
  });

  it("invites a staff member with the requested role", async () => {
    const response = (await buildAdminRouter(context).dispatch(
      event("POST", "/api/v1/admin/staff", "Owner", {
        email: "new.ops@rgs.test",
        role: "Ops",
      }),
    )) as ApiResponse;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      username: "new.ops@rgs.test",
      email: "new.ops@rgs.test",
      role: "Ops",
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
    });
  });

  it("changes a staff member role", async () => {
    await cognitoAdmins.adminCreateUser({ email: "finance@rgs.test" });
    await cognitoAdmins.adminAddUserToGroup("finance@rgs.test", "Finance");

    const response = (await buildAdminRouter(context).dispatch(
      event("PUT", "/api/v1/admin/staff/finance%40rgs.test/role", "Owner", {
        role: "Viewer",
      }),
    )) as ApiResponse;

    expect(response.statusCode).toBe(200);
    expect(await cognitoAdmins.adminListGroupsForUser("finance@rgs.test")).toEqual(["Viewer"]);
  });

  it("disables and enables a staff member", async () => {
    await cognitoAdmins.adminCreateUser({ email: "ops@rgs.test" });
    await cognitoAdmins.adminAddUserToGroup("ops@rgs.test", "Ops");
    const router = buildAdminRouter(context);

    const disabled = (await router.dispatch(
      event("POST", "/api/v1/admin/staff/ops%40rgs.test/disable"),
    )) as ApiResponse;
    expect(disabled.statusCode).toBe(200);
    expect((await cognitoAdmins.adminGetUser("ops@rgs.test")).enabled).toBe(false);

    const enabled = (await router.dispatch(
      event("POST", "/api/v1/admin/staff/ops%40rgs.test/enable"),
    )) as ApiResponse;
    expect(enabled.statusCode).toBe(200);
    expect((await cognitoAdmins.adminGetUser("ops@rgs.test")).enabled).toBe(true);
  });

  it("returns 403 when Ops attempts to invite staff", async () => {
    const response = (await buildAdminRouter(context).dispatch(
      event("POST", "/api/v1/admin/staff", "Ops", {
        email: "blocked@rgs.test",
        role: "Viewer",
      }),
    )) as ApiResponse;

    expect(response.statusCode).toBe(403);
    expect(await cognitoAdmins.listUsers()).toHaveLength(1);
  });

  it("uses the Cognito username to prevent an Owner disabling themself", async () => {
    await cognitoAdmins.adminCreateUser({ email: "other.owner@rgs.test" });
    await cognitoAdmins.adminAddUserToGroup("other.owner@rgs.test", "Owner");

    const response = (await buildAdminRouter(context).dispatch(
      event("POST", "/api/v1/admin/staff/owner-cognito-username/disable"),
    )) as ApiResponse;

    expect(response.statusCode).toBe(400);
    expect((await cognitoAdmins.adminGetUser("owner-cognito-username")).enabled).toBe(true);
  });
});

describe("production staff client wiring", () => {
  it("builds the real Cognito admins client when ADMINS_USER_POOL_ID is present", () => {
    const savedEnvironment = { ...process.env };
    process.env["TABLE_NAME"] = "rgs-table";
    process.env["DOCUMENTS_BUCKET"] = "rgs-documents";
    process.env["EMAIL_SENDER"] = "noreply@rgs.test";
    process.env["ADMIN_NOTIFICATION_EMAIL"] = "info@rgs.test";
    process.env["ADMINS_USER_POOL_ID"] = "ap-south-1_test";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(buildProductionContext().cognitoAdmins).toBeInstanceOf(AwsCognitoAdmins);
    } finally {
      warnSpy.mockRestore();
      process.env = savedEnvironment;
    }
  });
});
