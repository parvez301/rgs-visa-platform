import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { buildUserRouter } from "../src/http/userApi";
import { buildAdminRouter } from "../src/http/adminApi";
import { buildTestContext } from "./helpers";

function makeEvent(
  method: string,
  path: string,
  options: { body?: unknown; sub?: string; email?: string; query?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {},
    queryStringParameters: options.query,
    requestContext: {
      accountId: "",
      apiId: "",
      domainName: "",
      domainPrefix: "",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      requestId: "test",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      ...(options.sub !== undefined
        ? { authorizer: { jwt: { claims: { sub: options.sub, email: options.email ?? "" } } } }
        : {}),
    } as APIGatewayProxyEventV2["requestContext"],
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
  };
}

function parseResult(result: unknown): { statusCode: number; payload: unknown } {
  const structuredResult = result as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: structuredResult.statusCode ?? 0,
    payload: JSON.parse(structuredResult.body ?? "{}"),
  };
}

describe("user API routing", () => {
  it("creates a draft through the HTTP layer", async () => {
    const context = buildTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(
      await router.dispatch(
        makeEvent("POST", "/api/v1/applications", {
          body: { countryCode: "AE" },
          sub: "user_1",
          email: "asha@example.com",
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect((result.payload as { status: string }).status).toBe("DRAFT");
  });

  it("returns 403 without authentication", async () => {
    const context = buildTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(
      await router.dispatch(
        makeEvent("POST", "/api/v1/applications", { body: { countryCode: "AE" } }),
      ),
    );
    expect(result.statusCode).toBe(403);
  });

  it("maps validation failures to 400 with a helpful message", async () => {
    const context = buildTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(
      await router.dispatch(
        makeEvent("POST", "/api/v1/applications", {
          body: { countryCode: "uae" },
          sub: "user_1",
        }),
      ),
    );
    expect(result.statusCode).toBe(400);
    expect((result.payload as { message: string }).message).toContain("countryCode");
  });

  it("accepts anonymous leads", async () => {
    const context = buildTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(
      await router.dispatch(
        makeEvent("POST", "/api/v1/leads", {
          body: {
            fullName: "Walk In",
            phone: "+919999999999",
            topic: "Study abroad",
            message: "Want UK admission help",
          },
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(context.email.sentEmails[0]!.toAddress).toBe("info@raysglobalservices.com");
  });

  it("404s unknown routes", async () => {
    const context = buildTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(await router.dispatch(makeEvent("GET", "/api/v1/nope")));
    expect(result.statusCode).toBe(404);
  });
});

describe("admin API routing", () => {
  it("serves the queue with a status filter", async () => {
    const context = buildTestContext();
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/applications", {
          sub: "admin_1",
          query: { status: "SUBMITTED" },
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(Array.isArray(result.payload)).toBe(true);
  });

  it("lists user profiles for activity name resolution", async () => {
    const context = buildTestContext();
    const userRouter = buildUserRouter(context);
    await userRouter.dispatch(
      makeEvent("POST", "/api/v1/me", {
        body: { fullName: "Priya Sharma" },
        sub: "user_1",
        email: "priya@example.com",
      }),
    );
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/users", {
          sub: "admin_1",
          email: "admin@example.com",
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    const profiles = result.payload as Array<{ userId: string; fullName: string }>;
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user_1", fullName: "Priya Sharma" }),
      ]),
    );
  });

  it("rejects unauthenticated admin calls", async () => {
    const context = buildTestContext();
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(makeEvent("GET", "/api/v1/admin/activity")),
    );
    expect(result.statusCode).toBe(403);
  });
});
