import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { buildTestContext } from "../helpers";
import { Router } from "../../src/http/router";
import { registerCrmRoutes } from "../../src/http/crmApi";
import { writeCase } from "../../src/domain/crm/caseStore";
import type { AppContext } from "../../src/lib/context";

function buildRouter(context: AppContext): Router {
  return registerCrmRoutes(new Router(), context);
}

function buildEvent(
  method: string,
  path: string,
  body?: unknown,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: "admin_1", email: "ops@rgs.test" } } },
    },
    ...(queryStringParameters ? { queryStringParameters } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function call(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEvent(method, path, body, query))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

// Mirrors buildEvent, but omits the authorizer claims entirely — the same
// way router.test.ts's "rejects unauthenticated admin calls" constructs an
// unauthenticated request (no `authorizer` key at all, so the router's
// jwtClaims default to {} and callerId becomes "").
function buildUnauthenticatedEvent(
  method: string,
  path: string,
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function callUnauthenticated(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildUnauthenticatedEvent(method, path, body))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

/**
 * Cases point at travellers on file, so a case fixture creates its traveller
 * through the traveller route first and uses the id that comes back.
 */
async function seedTraveller(router: Router, fullName: string): Promise<string> {
  const created = await call(router, "POST", "/api/v1/admin/crm/travellers", { fullName });
  return created.payload.travellerId;
}

describe("crm admin routes", () => {
  it("creates a partner then a case, and reads the case back", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);

    const partnerResponse = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    expect(partnerResponse.statusCode).toBe(200);
    const partnerId = partnerResponse.payload.partnerId;

    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const caseResponse = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    expect(caseResponse.statusCode).toBe(200);
    expect(caseResponse.payload.caseStatus).toBe("NEW");

    const caseId = caseResponse.payload.caseId;
    const readResponse = await call(router, "GET", `/api/v1/admin/crm/cases/${caseId}`);
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.payload.caseRef).toBe("31377");
  });

  it("lists cases by status from the query parameter", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });

    const listed = await call(router, "GET", "/api/v1/admin/crm/cases", undefined, {
      status: "NEW",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.cases).toHaveLength(1);
  });

  it("moves the case status through PUT", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });

    const moved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/status`,
      { toStatus: "IN_PROGRESS" },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.payload.caseStatus).toBe("IN_PROGRESS");
  });

  it("returns 409 for an illegal transition", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const caseId = created.payload.caseId;
    await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/status`, {
      toStatus: "WITHDRAWN",
    });
    const illegal = await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/status`, {
      toStatus: "IN_PROGRESS",
    });
    expect(illegal.statusCode).toBe(409);
  });

  it("returns 400 for a body that fails validation", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const bad = await call(router, "PUT", "/api/v1/admin/crm/cases/case_1/status", {
      toStatus: "NOT_A_STATUS",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("returns 404 for a case that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const missing = await call(router, "GET", "/api/v1/admin/crm/cases/nope");
    expect(missing.statusCode).toBe(404);
  });

  it("exposes the audit trail for a case", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const events = await call(
      router,
      "GET",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/events`,
    );
    expect(events.statusCode).toBe(200);
    expect(events.payload.events[0].eventType).toBe("CASE_CREATED");
  });

  it("creates a traveller and finds the same one again by passport", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const created = await call(router, "POST", "/api/v1/admin/crm/travellers", {
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
    });
    expect(created.statusCode).toBe(200);

    const found = await call(
      router,
      "GET",
      "/api/v1/admin/crm/travellers/by-passport/Z6931368",
    );
    expect(found.statusCode).toBe(200);
    expect(found.payload.travellerId).toBe(created.payload.travellerId);
  });

  it("returns 404 looking up a passport with no traveller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const missing = await call(
      router,
      "GET",
      "/api/v1/admin/crm/travellers/by-passport/NOPE12345",
    );
    expect(missing.statusCode).toBe(404);
  });

  it("moves applicant custody through PUT", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const moved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/applicants/31377/custody`,
      { toCustody: "WITH_RGS" },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.payload.applicants[0].custody).toBe("WITH_RGS");
  });

  it("returns 404 moving custody for an applicant that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const missing = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/applicants/NOT_A_REF/custody`,
      { toCustody: "WITH_RGS" },
    );
    expect(missing.statusCode).toBe(404);
  });

  // --- Authorised addition (1): findTravellerByName + its route. ---
  // 74% of source rows carry no passport number, so name matching is the
  // only dedup path available through the API for that majority — this is
  // the route Plan 3's migration importer needs.
  it("creates a traveller with no passport and finds it again by name", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const created = await call(router, "POST", "/api/v1/admin/crm/travellers", {
      fullName: "No Passport Person",
    });
    expect(created.statusCode).toBe(200);

    const found = await call(
      router,
      "GET",
      `/api/v1/admin/crm/travellers/by-name/${encodeURIComponent("No Passport Person")}`,
    );
    expect(found.statusCode).toBe(200);
    expect(found.payload.travellerId).toBe(created.payload.travellerId);
  });

  it("returns 404 looking up a name with no traveller", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const missing = await call(
      router,
      "GET",
      `/api/v1/admin/crm/travellers/by-name/${encodeURIComponent("Nobody At All")}`,
    );
    expect(missing.statusCode).toBe(404);
  });

  // --- Authorised addition (2): a route for changeApplicantOutcome. ---
  // Task 7 gave the CRM a way to record a visa's outcome; the brief predates
  // it and has no route, so this exercises the route added for it.
  it("changes an applicant's outcome through PUT and derives the case status", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });

    const moved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/applicants/31377/outcome`,
      { toOutcome: "APPROVED" },
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.payload.applicants[0].outcome).toBe("APPROVED");
    // Single applicant, now decided — the derived-status rule (spec §5) fires
    // automatically, same as custody/billing driving CLOSED.
    expect(moved.payload.caseStatus).toBe("DECIDED");
  });

  it("returns 404 changing the outcome of an applicant that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const missing = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/cases/${created.payload.caseId}/applicants/NOT_A_REF/outcome`,
      { toOutcome: "APPROVED" },
    );
    expect(missing.statusCode).toBe(404);
  });

  it("returns 404 creating a case for a traveller that does not exist", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const missingTraveller = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId: "trv_totally_made_up" }],
    });
    expect(missingTraveller.statusCode).toBe(404);
  });

  // --- One half-written case partition must not take the whole queue down. ---
  it("still lists the healthy cases when one case partition lost its applicants", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const healthy = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    const secondTravellerId = await seedTraveller(router, "Aman Kapoor");
    const corrupted = await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31378",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31378", travellerId: secondTravellerId }],
    });
    await writeCase(context, { ...corrupted.payload, applicants: [] });

    const listed = await call(router, "GET", "/api/v1/admin/crm/cases", undefined, {
      status: "NEW",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.cases.map((listedCase: { caseId: string }) => listedCase.caseId)).toEqual([
      healthy.payload.caseId,
    ]);

    // The broken case itself is still reported, and as a typed error rather than a 500.
    const broken = await call(
      router,
      "GET",
      `/api/v1/admin/crm/cases/${corrupted.payload.caseId}`,
    );
    expect(broken.statusCode).toBe(409);
    expect(broken.payload.code).toBe("CORRUPT_RECORD");
  });

  // requireAdmin(requestContext) is the first statement in every CRM route,
  // verified statically elsewhere — these two prove the reject path actually
  // fires on a CRM route itself: one read route, one mutating route.
  it("rejects an unauthenticated caller on a CRM read route", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "GET", "/api/v1/admin/crm/partners");
    expect(rejected.statusCode).toBe(403);
  });

  it("rejects an unauthenticated caller on a CRM write route", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    expect(rejected.statusCode).toBe(403);
  });
});
