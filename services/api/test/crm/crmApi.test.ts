import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { buildTestContext } from "../helpers";
import { Router } from "../../src/http/router";
import { registerCrmRoutes } from "../../src/http/crmApi";
import { writeCase } from "../../src/domain/crm/caseStore";
import {
  META_SORT_KEY,
  REVIEW_ITEM_SORT_KEY,
  partnerListGsi1Pk,
  partnerPartitionKey,
  passportGsi3Pk,
  reviewItemPartitionKey,
  reviewQueueGsi1Pk,
  travellerPartitionKey,
} from "../../src/domain/crm/keys";
import { recordReviewItem } from "../../src/domain/crm/reviewQueue";
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

/**
 * An admin token that carries `sub` but no `email` claim — router.ts defaults
 * callerEmail to "" for it, which is a real shape (apps/admin/src/lib/auth.tsx
 * falls back for the same reason).
 */
function buildEventWithoutEmailClaim(
  method: string,
  path: string,
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { sub: "admin_1" } } },
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as unknown as APIGatewayProxyEventV2;
}

async function callWithoutEmailClaim(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; payload: any }> {
  const response = (await router.dispatch(buildEventWithoutEmailClaim(method, path, body))) as {
    statusCode: number;
    body: string;
  };
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
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
    expect(listed.payload.unreadableCaseIds).toEqual([]);
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

  // The embassy hands a passport back after ops has already marked the case
  // decided. All of these calls are legal — the NEW -> DECIDED skip-ahead is
  // intended, real e-visas are approved with no recorded submission — and
  // DECIDED used to absorb the case from there: every off-ramp requires a LIVE
  // status and the derivation short-circuited on DECIDED, so a case holding a
  // SENT_BACK applicant could only be got rid of by CLOSING a file the embassy
  // had actually returned.
  it("reopens a decided case when a passport comes back, then works and closes it normally", async () => {
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
    expect(created.payload.caseStatus).toBe("NEW");
    const caseId = created.payload.caseId;
    const applicantPath = `/api/v1/admin/crm/cases/${caseId}/applicants/31377`;

    const markedDecided = await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/status`, {
      toStatus: "DECIDED",
    });
    expect(markedDecided.statusCode).toBe(200);
    expect(markedDecided.payload.caseStatus).toBe("DECIDED");

    // The embassy returns the passport for a correction.
    const sentBack = await call(router, "PUT", `${applicantPath}/outcome`, {
      toOutcome: "SENT_BACK",
    });
    expect(sentBack.statusCode).toBe(200);
    expect(sentBack.payload.applicants[0].outcome).toBe("SENT_BACK");
    // The case is live work again, not a decided file.
    expect(sentBack.payload.caseStatus).toBe("SUBMITTED");

    // ...which means it is back in a queue ops can see, and back within reach
    // of the off-ramps, instead of being stranded.
    const submittedQueue = await call(router, "GET", "/api/v1/admin/crm/cases", undefined, {
      status: "SUBMITTED",
    });
    expect(submittedQueue.payload.cases.map((listedCase: any) => listedCase.caseId)).toEqual([
      caseId,
    ]);

    // Ops corrects the file and resubmits it; the applicant goes back to PENDING.
    const resubmitted = await call(router, "PUT", `${applicantPath}/outcome`, {
      toOutcome: "PENDING",
    });
    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.payload.caseStatus).toBe("SUBMITTED");

    // This time the embassy approves it, and the case decides again.
    const approved = await call(router, "PUT", `${applicantPath}/outcome`, {
      toOutcome: "APPROVED",
    });
    expect(approved.payload.caseStatus).toBe("DECIDED");

    // Passport back with its owner and the bill settled: the case closes itself.
    await call(router, "PUT", `${applicantPath}/custody`, { toCustody: "WITH_RGS" });
    await call(router, "PUT", `${applicantPath}/custody`, { toCustody: "RETURNED" });
    await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/billing`, {
      toBillingStatus: "BILL_SENT",
    });
    const paid = await call(router, "PUT", `/api/v1/admin/crm/cases/${caseId}/billing`, {
      toBillingStatus: "PAID",
    });
    expect(paid.payload.caseStatus).toBe("CLOSED");
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

  // A traveller is created for every case, so this route is on the critical
  // path for case creation. `min(1)` accepts "   ", CrmTravellerSchema then
  // trims it to "" and rejects it, and an unwrapped ZodError is not an
  // ApiError — the router maps it to a 500. The status code is the assertion:
  // `.rejects.toThrow()` passes for any error, including the 500 shape.
  it("returns 400, not 500, for a traveller name that is only whitespace", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const blankName = await call(router, "POST", "/api/v1/admin/crm/travellers", {
      fullName: "   ",
    });
    expect(blankName.statusCode).toBe(400);
    expect(blankName.payload.code).toBe("BAD_REQUEST");
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

  it("lists the cases belonging to one partner, and only that partner's", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const ozzy = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const luxe = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Luxe Escape",
    });
    for (const caseRef of ["31377", "31378"]) {
      const travellerId = await seedTraveller(router, `Ozzy Traveller ${caseRef}`);
      await call(router, "POST", "/api/v1/admin/crm/cases", {
        caseRef,
        caseType: "VISA",
        partnerId: ozzy.payload.partnerId,
        destinationCountry: "BH",
        visaType: "EVISA_TOURIST",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: caseRef, travellerId }],
      });
    }
    const luxeTravellerId = await seedTraveller(router, "Luxe Traveller");
    await call(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31999",
      caseType: "VISA",
      partnerId: luxe.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31999", travellerId: luxeTravellerId }],
    });

    const listed = await call(
      router,
      "GET",
      `/api/v1/admin/crm/cases/by-partner/${ozzy.payload.partnerId}`,
    );
    expect(listed.statusCode).toBe(200);
    expect(
      listed.payload.cases.map((listedCase: { caseRef: string }) => listedCase.caseRef).sort(),
    ).toEqual(["31377", "31378"]);
  });

  it("rejects an unauthenticated caller on the by-partner route", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(
      router,
      "GET",
      "/api/v1/admin/crm/cases/by-partner/prt_1",
    );
    expect(rejected.statusCode).toBe(403);
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

  it("creates a case for an admin token that carries no email claim", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const partner = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Ozzy Travels",
    });
    const travellerId = await seedTraveller(router, "Umesh Kumar Yadav");
    const created = await callWithoutEmailClaim(router, "POST", "/api/v1/admin/crm/cases", {
      caseRef: "31377",
      caseType: "VISA",
      partnerId: partner.payload.partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: "31377", travellerId }],
    });
    expect(created.statusCode).toBe(200);
    expect(created.payload.caseRef).toBe("31377");
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
    // The skipped row is named in the payload. Without this the case simply is
    // not there, and nothing tells the operator that anything went wrong.
    expect(listed.payload.unreadableCaseIds).toEqual([corrupted.payload.caseId]);

    // The broken case itself is still reported, and as a typed error rather than a 500.
    const broken = await call(
      router,
      "GET",
      `/api/v1/admin/crm/cases/${corrupted.payload.caseId}`,
    );
    expect(broken.statusCode).toBe(409);
    expect(broken.payload.code).toBe("CORRUPT_RECORD");
  });

  // The partner list carries the same blast radius the case queue was fixed
  // for: one bad row used to 500 the list for the whole tenant.
  it("still serves the partner list, naming the row it skipped, when one stored partner will not parse", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const healthy = await call(router, "POST", "/api/v1/admin/crm/partners", {
      canonicalName: "Luxe Escape",
    });
    // Indexed into the partner list, but the body has lost its partnerType.
    await context.table.put({
      PK: partnerPartitionKey("rgs", "prt_half_written"),
      SK: META_SORT_KEY,
      GSI1PK: partnerListGsi1Pk("rgs"),
      GSI1SK: crm.normalizePartnerName("Ozzy Travels").canonicalKey ?? "",
      tenantId: "rgs",
      partnerId: "prt_half_written",
      canonicalName: "Ozzy Travels",
      aliases: [],
      createdAt: "2026-07-23T10:00:00.000Z",
    });

    const listed = await call(router, "GET", "/api/v1/admin/crm/partners");
    expect(listed.statusCode).toBe(200);
    expect(
      listed.payload.partners.map((partner: { partnerId: string }) => partner.partnerId),
    ).toEqual([healthy.payload.partnerId]);
    expect(listed.payload.unreadablePartnerIds).toEqual(["prt_half_written"]);
  });

  // A stored traveller row that will not parse must reach the caller as a
  // typed 409 over HTTP, not a 500. Asserted on the real router response,
  // because the status code is the part that was wrong.
  it("answers 409 rather than 500 when a stored traveller record will not parse", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    // Indexed under its passport, but the body has lost its normalizedName —
    // the shape a half-written row or an older importer leaves behind.
    await context.table.put({
      PK: travellerPartitionKey("rgs", "trv_half_written"),
      SK: META_SORT_KEY,
      GSI3PK: passportGsi3Pk("rgs", "Z6931368"),
      GSI3SK: "trv_half_written",
      tenantId: "rgs",
      travellerId: "trv_half_written",
      fullName: "Umesh Kumar Yadav",
      passportNumber: "Z6931368",
      createdAt: "2026-07-23T10:00:00.000Z",
    });

    const looked = await call(
      router,
      "GET",
      "/api/v1/admin/crm/travellers/by-passport/Z6931368",
    );
    expect(looked.statusCode).toBe(409);
    expect(looked.payload.code).toBe("CORRUPT_RECORD");
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

  // ------------------------------------------------------------------
  // Migration review queue (spec §9): the rows the importer could not
  // apply deterministically, parked for a human.
  // ------------------------------------------------------------------

  const baseReviewInput = {
    reason: "UNMAPPED_STATUS",
    sourceSheet: "Mini CRM",
    sourceRow: 42,
    caseRef: "31376",
    fieldName: "Status",
    rawValue: "DEU/DEL/190126/",
  } as const;

  function reviewItemIdsOf(payload: { reviewItems: { reviewItemId: string }[] }): string[] {
    return payload.reviewItems.map((reviewItem) => reviewItem.reviewItemId);
  }

  it("lists open review items and resolves one", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const listed = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(listed.statusCode).toBe(200);
    expect(reviewItemIdsOf(listed.payload)).toEqual([recorded.reviewItemId]);
    expect(listed.payload.unreadableReviewItemIds).toEqual([]);
    // The truncation flag has to survive the route, not just the domain call:
    // the admin screen reads this response and nothing else.
    expect(listed.payload.hasMore).toBe(false);

    const resolved = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "APPLIED", resolvedValue: "IN_PROGRESS" },
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.payload.reviewStatus).toBe("APPLIED");
    // The chosen value and the reviewer who chose it both have to survive the
    // round trip — this is the audit record of a human decision.
    expect(resolved.payload.resolvedValue).toBe("IN_PROGRESS");
    expect(resolved.payload.resolvedBy).toBe("ops@rgs.test");

    const afterResolve = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(afterResolve.payload.reviewItems).toHaveLength(0);
  });

  // The ?status= value has to reach the domain call. A handler that always
  // asked for OPEN would still pass the test above, so this asks for the
  // partition a resolved item actually moved to.
  it("lists a resolved item under the status named in the query parameter", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);
    const dismissal = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "DISMISSED" },
    );
    expect(dismissal.statusCode).toBe(200);

    const dismissed = await call(router, "GET", "/api/v1/admin/crm/review", undefined, {
      status: "DISMISSED",
    });
    expect(dismissed.statusCode).toBe(200);
    expect(reviewItemIdsOf(dismissed.payload)).toEqual([recorded.reviewItemId]);

    const stillOpen = await call(router, "GET", "/api/v1/admin/crm/review", undefined, {
      status: "OPEN",
    });
    expect(stillOpen.payload.reviewItems).toHaveLength(0);
  });

  it("rejects an unknown review status with a 400 rather than silently listing OPEN", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/review", undefined, {
      status: "NONSENSE",
    });
    expect(response.statusCode).toBe(400);
    expect(response.payload.code).toBe("BAD_REQUEST");
  });

  it("reads a single review item back by id", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const read = await call(router, "GET", `/api/v1/admin/crm/review/${recorded.reviewItemId}`);
    expect(read.statusCode).toBe(200);
    expect(read.payload.reviewItemId).toBe(recorded.reviewItemId);
    // Provenance is the point of the queue: the row has to name the cell.
    expect(read.payload.rawValue).toBe("DEU/DEL/190126/");
    expect(read.payload.sourceSheet).toBe("Mini CRM");
    expect(read.payload.sourceRow).toBe(42);
  });

  it("returns 404 for an unknown review item", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const response = await call(router, "GET", "/api/v1/admin/crm/review/nope");
    expect(response.statusCode).toBe(404);
    expect(response.payload.code).toBe("NOT_FOUND");
  });

  // parseBody, never a bare .parse(): router.ts maps only ApiError subclasses,
  // so an unwrapped ZodError on request input escapes as a 500 where the
  // caller deserves a 400.
  it("rejects an unknown reviewStatus in the resolve body with 400, not 500", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "MAYBE" },
    );
    expect(response.statusCode).toBe(400);
    expect(response.payload.code).toBe("BAD_REQUEST");
  });

  it("rejects a resolve call with no body at all with 400, not 500", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const response = await call(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.payload.code).toBe("BAD_REQUEST");
  });

  // Two reviewers working the queue at once is the expected case, so the
  // second decision is a 409 rather than a silent overwrite of the first.
  it("answers 409 when an already resolved item is resolved again", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);
    const resolvePath = `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`;

    const first = await call(router, "PUT", resolvePath, { reviewStatus: "APPLIED" });
    expect(first.statusCode).toBe(200);

    const second = await call(router, "PUT", resolvePath, { reviewStatus: "DISMISSED" });
    expect(second.statusCode).toBe(409);
    expect(second.payload.code).toBe("CONFLICT");
  });

  // A row that will not parse must be named in the response, not dropped from
  // it. Dropping unreadableReviewItemIds passes every other test in this file,
  // and an item silently missing from the queue looks exactly like an item
  // that was never imported — the failure this shape exists to prevent.
  it("names an unreadable review row in the listing instead of dropping it", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const healthy = await recordReviewItem(context, "rgs", baseReviewInput);
    // Indexed in the OPEN partition, but the body has lost its caseRef — the
    // shape a half-written row or an older importer leaves behind.
    await context.table.put({
      PK: reviewItemPartitionKey("rgs", "rev_half_written"),
      SK: REVIEW_ITEM_SORT_KEY,
      GSI1PK: reviewQueueGsi1Pk("rgs", "OPEN"),
      GSI1SK: "2026-07-23T10:00:00.000Z",
      tenantId: "rgs",
      reviewItemId: "rev_half_written",
      reason: "UNMAPPED_STATUS",
      reviewStatus: "OPEN",
      sourceSheet: "Mini CRM",
      sourceRow: 42,
      fieldName: "Status",
      rawValue: "DEU/DEL/190126/",
      createdAt: "2026-07-23T10:00:00.000Z",
    });

    const listed = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(listed.statusCode).toBe(200);
    expect(reviewItemIdsOf(listed.payload)).toEqual([healthy.reviewItemId]);
    expect(listed.payload.unreadableReviewItemIds).toEqual(["rev_half_written"]);
  });

  // 409 and not 404 on the single read: the item is on file, it is unreadable.
  it("answers 409 rather than 500 when a stored review item will not parse", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    await context.table.put({
      PK: reviewItemPartitionKey("rgs", "rev_half_written"),
      SK: REVIEW_ITEM_SORT_KEY,
      GSI1PK: reviewQueueGsi1Pk("rgs", "OPEN"),
      GSI1SK: "2026-07-23T10:00:00.000Z",
      tenantId: "rgs",
      reviewItemId: "rev_half_written",
      reason: "UNMAPPED_STATUS",
      reviewStatus: "OPEN",
      sourceSheet: "Mini CRM",
      sourceRow: 42,
      fieldName: "Status",
      rawValue: "DEU/DEL/190126/",
      createdAt: "2026-07-23T10:00:00.000Z",
    });

    const read = await call(router, "GET", "/api/v1/admin/crm/review/rev_half_written");
    expect(read.statusCode).toBe(409);
    expect(read.payload.code).toBe("CORRUPT_RECORD");
  });

  it("rejects an unauthenticated caller on the review listing route", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const rejected = await callUnauthenticated(router, "GET", "/api/v1/admin/crm/review");
    expect(rejected.statusCode).toBe(403);
    expect(rejected.payload.code).toBe("FORBIDDEN");
  });

  // requireAdmin has to be the *first* statement, not merely present: the
  // rejected call must leave the item untouched, still OPEN for a real
  // reviewer. A guard that ran after resolveReviewItem would 403 the response
  // and still have written the decision.
  it("rejects an unauthenticated caller on the review resolve route without writing", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const rejected = await callUnauthenticated(
      router,
      "PUT",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "APPLIED" },
    );
    expect(rejected.statusCode).toBe(403);

    const stillOpen = await call(router, "GET", "/api/v1/admin/crm/review");
    expect(reviewItemIdsOf(stillOpen.payload)).toEqual([recorded.reviewItemId]);
  });

  // The CDK admin route declares GET/POST/PUT/DELETE and no PATCH, so a PATCH
  // resolve route would pass its unit tests and then 404 in deployment. Assert
  // the absence, so adding one goes red here rather than in production.
  it("exposes no PATCH route for resolving a review item", async () => {
    const context = buildTestContext();
    const router = buildRouter(context);
    const recorded = await recordReviewItem(context, "rgs", baseReviewInput);

    const patched = await call(
      router,
      "PATCH",
      `/api/v1/admin/crm/review/${recorded.reviewItemId}/resolve`,
      { reviewStatus: "APPLIED" },
    );
    expect(patched.statusCode).toBe(404);
  });
});
