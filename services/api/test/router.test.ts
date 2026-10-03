import { afterEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { buildUserRouter } from "../src/http/userApi";
import { buildAdminRouter } from "../src/http/adminApi";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "./helpers";

afterEach(closeSqlTestContexts);

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
        ? {
            authorizer: {
              jwt: {
                claims: {
                  sub: options.sub,
                  email: options.email ?? "",
                  "cognito:groups": "[\"Owner\"]",
                },
              },
            },
          }
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
    const context = await buildSqlTestContext();
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
    const context = await buildSqlTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(
      await router.dispatch(
        makeEvent("POST", "/api/v1/applications", { body: { countryCode: "AE" } }),
      ),
    );
    expect(result.statusCode).toBe(403);
  });

  it("maps validation failures to 400 with a helpful message", async () => {
    const context = await buildSqlTestContext();
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
    const context = await buildSqlTestContext();
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
    const context = await buildSqlTestContext();
    const router = buildUserRouter(context);
    const result = parseResult(await router.dispatch(makeEvent("GET", "/api/v1/nope")));
    expect(result.statusCode).toBe(404);
  });
});

/**
 * C3, swept rather than patched.
 *
 * The class is "one malformed stored row 500s an entire listing", and the
 * first fix round closed only the three paths the review happened to name.
 * These are the rest, endpoint by endpoint, each with a real bad row in the
 * store beside a real good one: 200, the good rows served, the bad id named.
 *
 * The two public ones matter most. `GET /api/v1/notices` and
 * `GET /api/v1/config/countries` are unauthenticated, and are what the
 * marketing site's ticker and price list call — so a single hand-repaired row
 * used to answer 500 to every visitor to the website, not just to an admin.
 */
describe("C3 — one malformed stored row never takes a listing down", () => {
  const goodNoticeInput = {
    title: "UAE processing update",
    body: "Processing times may extend by 2 business days.",
    category: "RULE_CHANGE" as const,
    severity: "IMPORTANT" as const,
    countryCode: "AE",
    status: "PUBLISHED" as const,
  };

  /** A notice row whose title is empty: stored, indexed, unparseable. */
  async function seedMalformedNoticeRow(context: SqlTestContext) {
    await context.sql.query(
      `insert into portal_notices (notice_id, title, body, category, severity, pinned, status,
         published_at, created_at, updated_at)
       values ('ntc_broken', '', 'Body is fine; the title is empty.', 'RULE_CHANGE', 'INFO', false,
         'PUBLISHED', '2026-07-23T09:00:00Z', '2026-07-23T09:00:00Z', '2026-07-23T09:00:00Z')`,
    );
    return "ntc_broken";
  }

  it("serves the PUBLIC notice feed with the bad row named, not a 500", async () => {
    const context = await buildSqlTestContext();
    const userRouter = buildUserRouter(context);
    const adminRouter = buildAdminRouter(context);
    const published = parseResult(
      await adminRouter.dispatch(
        makeEvent("PUT", "/api/v1/admin/notices", {
          body: goodNoticeInput,
          sub: "admin_1",
          email: "admin@example.com",
        }),
      ),
    ).payload as { noticeId: string };
    const brokenNoticeId = await seedMalformedNoticeRow(context);

    const result = parseResult(
      await userRouter.dispatch(makeEvent("GET", "/api/v1/notices")),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      notices: Array<{ noticeId: string }>;
      unreadableNoticeIds: string[];
    };
    expect(listing.notices.map((notice) => notice.noticeId)).toEqual([published.noticeId]);
    expect(listing.unreadableNoticeIds).toEqual([brokenNoticeId]);
  });

  it("serves the admin notice list with the bad row named, not a 500", async () => {
    const context = await buildSqlTestContext();
    const adminRouter = buildAdminRouter(context);
    const published = parseResult(
      await adminRouter.dispatch(
        makeEvent("PUT", "/api/v1/admin/notices", {
          body: goodNoticeInput,
          sub: "admin_1",
          email: "admin@example.com",
        }),
      ),
    ).payload as { noticeId: string };
    const brokenNoticeId = await seedMalformedNoticeRow(context);

    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/notices", { sub: "admin_1", email: "a@example.com" }),
      ),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      notices: Array<{ noticeId: string }>;
      unreadableNoticeIds: string[];
    };
    expect(listing.notices.map((notice) => notice.noticeId)).toEqual([published.noticeId]);
    expect(listing.unreadableNoticeIds).toEqual([brokenNoticeId]);
  });

  it("serves the admin user list with the bad row named, not a 500", async () => {
    const context = await buildSqlTestContext();
    const userRouter = buildUserRouter(context);
    await userRouter.dispatch(
      makeEvent("POST", "/api/v1/me", {
        body: { fullName: "Priya Sharma" },
        sub: "user_1",
        email: "priya@example.com",
      }),
    );
    // A profile whose email is no longer an email address: the schema refuses
    // it, and every name lookup on the activity screens used to 500 with it.
    await context.sql.query(
      `insert into portal_user_profiles (user_id, email, full_name, created_at)
       values ('user_broken', 'not-an-email', 'Broken Row', '2026-07-23T09:00:00Z')`,
    );

    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/users", { sub: "admin_1", email: "a@example.com" }),
      ),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      users: Array<{ userId: string }>;
      unreadableUserIds: string[];
    };
    expect(listing.users.map((userProfile) => userProfile.userId)).toEqual(["user_1"]);
    expect(listing.unreadableUserIds).toEqual(["user_broken"]);
  });

  it("serves an applicant's own list with the bad row named, not a whole-page failure", async () => {
    const context = await buildSqlTestContext();
    const userRouter = buildUserRouter(context);
    const draft = parseResult(
      await userRouter.dispatch(
        makeEvent("POST", "/api/v1/applications", {
          body: { countryCode: "AE" },
          sub: "user_1",
          email: "asha@example.com",
        }),
      ),
    ).payload as { applicationId: string };
    // A half-written draft in the same partition. This path threw
    // CorruptRecordError for the WHOLE listing, so one bad row cost the
    // applicant every application they had.
    await context.sql.query(
      `insert into portal_applications (application_id, user_id, country_code, product_code,
         status, step_reached, travellers, amounts, payment_status, created_at, updated_at)
       values ('app_broken', 'user_1', 'AE', 'tourist', 'DRAFT', 'travellers', '[]'::jsonb,
         '{"governmentFeeInr":1,"serviceFeeInr":1,"currency":"INR"}'::jsonb, 'UNPAID', now(), now())`,
    );

    const result = parseResult(
      await userRouter.dispatch(
        makeEvent("GET", "/api/v1/applications", { sub: "user_1", email: "asha@example.com" }),
      ),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      applications: Array<{ applicationId: string }>;
      unreadableApplicationIds: string[];
    };
    expect(listing.applications.map((application) => application.applicationId)).toEqual([
      draft.applicationId,
    ]);
    expect(listing.unreadableApplicationIds).toEqual(["app_broken"]);
  });

  /**
   * A catalog row an admin edit broke. `AE_TOURIST_30D_SINGLE` is a real seed
   * so this also exercises the schema-evolution heal: merging the seed
   * defaults cannot rescue it, because the stored value wins the merge and the
   * stored value is the problem.
   */
  async function seedCatalogWithOneBrokenRow(
    context: SqlTestContext,
  ): Promise<string> {
    // The migration already seeded the catalog; corrupt one row in place.
    await context.sql.query(
      `update crm_country_products set visa_type = 'BOGUS' where product_code = $1`,
      ["AE_TOURIST_30D_SINGLE"],
    );
    return "AE_TOURIST_30D_SINGLE";
  }

  it("serves the PUBLIC country catalog with the bad row named, not a 500", async () => {
    const context = await buildSqlTestContext();
    const brokenProductCode = await seedCatalogWithOneBrokenRow(context);

    const result = parseResult(
      await buildUserRouter(context).dispatch(makeEvent("GET", "/api/v1/config/countries")),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      countryProducts: Array<{ productCode: string }>;
      unreadableCountryProductIds: string[];
    };
    expect(listing.countryProducts.length).toBeGreaterThan(0);
    expect(
      listing.countryProducts.some((product) => product.productCode === brokenProductCode),
    ).toBe(false);
    expect(listing.unreadableCountryProductIds).toEqual([`AE#${brokenProductCode}`]);
  });

  it("serves the admin country catalog with the bad row named, not a 500", async () => {
    const context = await buildSqlTestContext();
    const brokenProductCode = await seedCatalogWithOneBrokenRow(context);

    const result = parseResult(
      await buildAdminRouter(context).dispatch(
        makeEvent("GET", "/api/v1/admin/config/countries", {
          sub: "admin_1",
          email: "a@example.com",
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    const listing = result.payload as {
      countryProducts: Array<{ productCode: string }>;
      unreadableCountryProductIds: string[];
    };
    expect(listing.countryProducts.length).toBeGreaterThan(0);
    expect(listing.unreadableCountryProductIds).toEqual([`AE#${brokenProductCode}`]);
  });

  // The other half of C3: a query parameter is caller input, so a bad one is a
  // 400. Both of these were bare `.parse()` calls, and router.ts maps only
  // ApiError -- so they answered 500 "Internal error" to a caller who had
  // simply mistyped a word.
  it("400s a bad ?countryCode= on the PUBLIC notice feed rather than 500ing", async () => {
    const context = await buildSqlTestContext();
    const result = parseResult(
      await buildUserRouter(context).dispatch(
        makeEvent("GET", "/api/v1/notices", { query: { countryCode: "xx" } }),
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(result.payload)).toContain("countryCode");
  });

  it("400s a bad ?docType= on the applicant document download rather than 500ing", async () => {
    const context = await buildSqlTestContext();
    const result = parseResult(
      await buildUserRouter(context).dispatch(
        makeEvent("GET", "/api/v1/applications/app_1/documents/download", {
          sub: "user_1",
          email: "asha@example.com",
          query: { docType: "PASSPORT_BI" },
        }),
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(result.payload)).toContain("docType");
  });
});

describe("admin API routing", () => {
  it("serves the queue with a status filter", async () => {
    const context = await buildSqlTestContext();
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
    // { applications, unreadableApplicationIds }: a row that will not parse is
    // named rather than 500ing the whole ops queue.
    expect(result.payload).toEqual({ applications: [], unreadableApplicationIds: [] });
  });

  // C3: a query parameter is caller input, so a bad one is a 400. Parsed with
  // a bare `.parse()` these threw a ZodError, which router.ts does not map --
  // so a typo answered 500 "Internal error" and told the operator nothing.
  it("400s a mistyped ?status= rather than 500ing", async () => {
    const context = await buildSqlTestContext();
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/applications", {
          sub: "admin_1",
          query: { status: "SUBMITTTED" },
        }),
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(result.payload)).toContain("status");
  });

  it("400s a missing ?docType= on the document download rather than 500ing", async () => {
    const context = await buildSqlTestContext();
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(
        makeEvent("GET", "/api/v1/admin/applications/app_1/documents/download", {
          sub: "admin_1",
        }),
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(result.payload)).toContain("docType");
  });

  it("lists user profiles for activity name resolution", async () => {
    const context = await buildSqlTestContext();
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
    // { users, unreadableUserIds }: one malformed USER# row is named rather
    // than 500ing every name lookup on the activity screens.
    const listing = result.payload as {
      users: Array<{ userId: string; fullName: string }>;
      unreadableUserIds: string[];
    };
    expect(listing.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "user_1", fullName: "Priya Sharma" }),
      ]),
    );
    expect(listing.unreadableUserIds).toEqual([]);
  });

  it("rejects unauthenticated admin calls", async () => {
    const context = await buildSqlTestContext();
    const adminRouter = buildAdminRouter(context);
    const result = parseResult(
      await adminRouter.dispatch(makeEvent("GET", "/api/v1/admin/activity")),
    );
    expect(result.statusCode).toBe(403);
  });
});
