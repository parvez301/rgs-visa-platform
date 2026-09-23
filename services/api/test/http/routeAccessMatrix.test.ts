import type { AdminRole, AdminScreen } from "@rgs/shared";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { buildAdminRouter } from "../../src/http/adminApi";
import { buildTestContext } from "../helpers";

interface RouteAccess {
  method: string;
  pathPattern: string;
  screen: AdminScreen;
  mode: "read" | "write";
}

const ROUTE_ACCESS: RouteAccess[] = [
  { method: "GET", pathPattern: "/api/v1/admin/applications", screen: "queue", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/applications/{applicationId}", screen: "queue", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/applications/{applicationId}/transition", screen: "queue", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/applications/{applicationId}/payment", screen: "queue", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/applications/{applicationId}/documents/download", screen: "queue", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/documents/review", screen: "queue", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/applications/{applicationId}/notes", screen: "queue", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/activity", screen: "activity", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/leads", screen: "leads", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/users", screen: "activity", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/notices", screen: "notices", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/notices", screen: "notices", mode: "write" },
  { method: "DELETE", pathPattern: "/api/v1/admin/notices/{noticeId}", screen: "notices", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/config/countries", screen: "config", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/config/countries", screen: "config", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/config/seed", screen: "config", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/partners", screen: "crm", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/partners", screen: "crm", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/travellers", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/travellers/by-passport/{passportNumber}", screen: "crm", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/travellers/by-name/{fullName}", screen: "crm", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases", screen: "crm", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases/by-partner/{partnerId}", screen: "crm", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/cases", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases/ledger", screen: "crm", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases/{caseId}", screen: "crm", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases/{caseId}/events", screen: "crm", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}/status", screen: "crm", mode: "write" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}/billing", screen: "crm", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/cases/{caseId}/document-checklist/ensure", screen: "crm", mode: "write" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}/document-checklist", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/cases/{caseId}/invoice", screen: "crm", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/appointment-reminders/run", screen: "crm", mode: "write" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/custody", screen: "crm", mode: "write" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/outcome", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/review", screen: "crmReview", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/review/summary", screen: "crmReview", mode: "read" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/review/groups", screen: "crmReview", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/review/groups/resolve", screen: "crmReview", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/review/{reviewItemId}", screen: "crmReview", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/review/{reviewItemId}/resolve", screen: "crmReview", mode: "write" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/agent/turn", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/agent/proposals", screen: "crm", mode: "read" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/agent/proposals/{proposalId}/approve", screen: "crm", mode: "write" },
  { method: "PUT", pathPattern: "/api/v1/admin/crm/agent/proposals/{proposalId}/discard", screen: "crm", mode: "write" },
  { method: "GET", pathPattern: "/api/v1/admin/crm/agent/memories", screen: "crm", mode: "read" },
  { method: "POST", pathPattern: "/api/v1/admin/crm/agent/memories", screen: "crm", mode: "write" },
  { method: "DELETE", pathPattern: "/api/v1/admin/crm/agent/memories/{memoryKey}", screen: "crm", mode: "write" },
];

const deniedRoleByAccess: Partial<
  Record<`${AdminScreen}:${RouteAccess["mode"]}`, AdminRole>
> = {
  "queue:read": "Finance",
  "queue:write": "Viewer",
  "leads:read": "Viewer",
  "notices:read": "Viewer",
  "notices:write": "Viewer",
  "config:read": "Ops",
  "config:write": "Ops",
  "crm:write": "Viewer",
  "crmReview:read": "Viewer",
  "crmReview:write": "Viewer",
};

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function fillPathParams(pathPattern: string): string {
  return pathPattern.replace(/\{[^}]+\}/g, "x");
}

function eventFor(route: RouteAccess, role: AdminRole): APIGatewayProxyEventV2 {
  return {
    rawPath: fillPathParams(route.pathPattern),
    requestContext: {
      http: { method: route.method },
      authorizer: {
        jwt: {
          claims: {
            sub: "admin_1",
            email: "admin@rgs.test",
            "cognito:groups": JSON.stringify([role]),
          },
        },
      },
    },
    body: JSON.stringify({}),
  } as unknown as APIGatewayProxyEventV2;
}

describe("admin route access matrix", () => {
  const router = buildAdminRouter(buildTestContext());

  it("classifies every registered route exactly once", () => {
    const registeredRouteKeys = router.registeredRoutes.map(routeKey).sort();
    const classifiedRouteKeys = ROUTE_ACCESS.map(({ method, pathPattern }) =>
      routeKey({ method, path: pathPattern }),
    ).sort();

    expect(new Set(classifiedRouteKeys).size).toBe(classifiedRouteKeys.length);
    expect(classifiedRouteKeys).toEqual(registeredRouteKeys);
  });

  it.each(
    ROUTE_ACCESS.flatMap((route) => {
      const deniedRole = deniedRoleByAccess[`${route.screen}:${route.mode}`];
      return deniedRole === undefined ? [] : [{ ...route, deniedRole }];
    }),
  )("$method $pathPattern rejects $deniedRole for $screen $mode", async (route) => {
    const response = (await router.dispatch(eventFor(route, route.deniedRole))) as {
      statusCode: number;
    };

    expect(response.statusCode).toBe(403);
  });
});
