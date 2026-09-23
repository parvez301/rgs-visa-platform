import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  parseCognitoGroupsClaim,
  requireAdmin,
  requireRole,
  requireScreen,
  requireWrite,
} from "../../src/http/adminAccess";
import { ApiError } from "../../src/lib/errors";
import { Router, type RequestContext } from "../../src/http/router";

function ctx(partial: Partial<RequestContext>): RequestContext {
  return {
    callerId: "sub-1",
    callerEmail: "a@example.com",
    roles: [],
    pathParams: {},
    queryParams: {},
    body: undefined,
    ...partial,
  };
}

describe("parseCognitoGroupsClaim", () => {
  it("parses the JSON string API Gateway puts in JWT claims", () => {
    expect(parseCognitoGroupsClaim("[\"Owner\",\"Ops\"]")).toEqual(["Owner", "Ops"]);
  });

  it("accepts an already-parsed string array", () => {
    expect(parseCognitoGroupsClaim(["Finance", "Viewer"])).toEqual(["Finance", "Viewer"]);
  });

  it.each([undefined, "not-json", "{\"Owner\":true}", [1, "Ops"]])(
    "returns empty for a missing or malformed claim: %j",
    (claim) => {
      expect(parseCognitoGroupsClaim(claim)).toEqual([]);
    },
  );
});

describe("requireAdmin", () => {
  it("throws 403 when signed in but no role group is present", () => {
    expectForbidden(() => requireAdmin(ctx({ roles: [] })));
  });

  it("throws 403 when a role exists but caller identity is missing", () => {
    expectForbidden(() => requireAdmin(ctx({ callerId: "", roles: ["Owner"] })));
  });

  it("returns the primary role and caller identity", () => {
    expect(requireAdmin(ctx({ roles: ["Ops", "Owner"] }))).toEqual({
      adminId: "sub-1",
      adminEmail: "a@example.com",
      role: "Owner",
    });
  });
});

describe("access helpers", () => {
  it("allows only listed roles", () => {
    expect(requireRole(ctx({ roles: ["Ops"] }), ["Owner", "Ops"]).role).toBe("Ops");
    expectForbidden(() => requireRole(ctx({ roles: ["Finance"] }), ["Owner", "Ops"]));
  });

  it("allows Viewer read access to crm but denies inaccessible screens", () => {
    expect(requireScreen(ctx({ roles: ["Viewer"] }), "crm").role).toBe("Viewer");
    expectForbidden(() => requireScreen(ctx({ roles: ["Viewer"] }), "notices"));
  });

  it("throws 403 for Viewer on crm writes", () => {
    expectForbidden(() => requireWrite(ctx({ roles: ["Viewer"] }), "crm"));
  });

  it("allows Ops on crm writes", () => {
    expect(requireWrite(ctx({ roles: ["Ops"] }), "crm").role).toBe("Ops");
  });
});

describe("Router Cognito groups", () => {
  it("adds parsed groups to RequestContext", async () => {
    const router = new Router().add("GET", "/roles", async (requestContext) => ({
      roles: requestContext.roles,
    }));
    const event = {
      rawPath: "/roles",
      requestContext: {
        http: { method: "GET" },
        authorizer: {
          jwt: {
            claims: {
              sub: "sub-1",
              email: "a@example.com",
              "cognito:groups": "[\"Owner\",\"Ops\"]",
            },
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2;

    const response = (await router.dispatch(event)) as { statusCode: number; body: string };

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ roles: ["Owner", "Ops"] });
  });
});

function expectForbidden(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(403);
  }
}
