import { crm } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { badRequest, notFound } from "../lib/errors";
import {
  changeApplicantCustody,
  changeApplicantOutcome,
  changeBillingStatus,
  changeCaseStatus,
  createCase,
  getCase,
  listCasesByStatus,
} from "../domain/crm/cases";
import { listCaseEvents } from "../domain/crm/crmEvents";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import { createPartner, listPartners } from "../domain/crm/partners";
import {
  findTravellerByName,
  findTravellerByPassport,
  upsertTraveller,
} from "../domain/crm/travellers";
import { Router, parseBody } from "./router";
import { requireAdmin } from "./adminApi";

const CreatePartnerBody = z.object({
  canonicalName: z.string().min(1),
  partnerType: z.enum(crm.PARTNER_TYPES).optional(),
  aliases: z.array(z.string()).optional(),
  notes: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactWhatsapp: z.string().optional(),
});

const CreateCaseBody = z.object({
  caseRef: z.string().min(1),
  caseType: z.enum(crm.CASE_TYPES),
  partnerId: z.string().min(1),
  destinationCountry: z.string().length(2),
  visaType: z.enum(crm.VISA_TYPES).optional(),
  entryType: z.enum(crm.ENTRY_TYPES).optional(),
  processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  applicants: z
    .array(
      z.object({
        applicantRef: z.string().min(1),
        travellerId: z.string().min(1),
        passportNumber: z.string().optional(),
      }),
    )
    .min(1),
});

const UpsertTravellerBody = z.object({
  fullName: z.string().min(1),
  passportNumber: z.string().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  phone: z.string().optional(),
});

const CaseStatusBody = z.object({ toStatus: z.enum(crm.CASE_STATUSES) });
const BillingStatusBody = z.object({ toBillingStatus: z.enum(crm.BILLING_STATUSES) });
const CustodyBody = z.object({ toCustody: z.enum(crm.CUSTODY_STATUSES) });
const OutcomeBody = z.object({ toOutcome: z.enum(crm.APPLICANT_OUTCOMES) });

/**
 * Mounted onto the admin router, so these inherit the admin Cognito authorizer
 * and the existing /api/v1/admin/{proxy+} API Gateway route — no CDK change.
 * PUT, never PATCH: PATCH is not among the routed admin methods.
 */
export function registerCrmRoutes(router: Router, context: AppContext): Router {
  const tenantId = DEFAULT_TENANT_ID;

  return router
    .add("GET", "/api/v1/admin/crm/partners", async (requestContext) => {
      requireAdmin(requestContext);
      return { partners: await listPartners(context, tenantId) };
    })
    .add("POST", "/api/v1/admin/crm/partners", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CreatePartnerBody, requestContext.body);
      return createPartner(context, tenantId, body, requestContext.callerEmail);
    })
    .add("POST", "/api/v1/admin/crm/travellers", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(UpsertTravellerBody, requestContext.body);
      return upsertTraveller(context, tenantId, body);
    })
    .add(
      "GET",
      "/api/v1/admin/crm/travellers/by-passport/{passportNumber}",
      async (requestContext) => {
        requireAdmin(requestContext);
        const traveller = await findTravellerByPassport(
          context,
          tenantId,
          requestContext.pathParams["passportNumber"]!,
        );
        if (!traveller) throw notFound("Traveller");
        return traveller;
      },
    )
    .add(
      "GET",
      "/api/v1/admin/crm/travellers/by-name/{fullName}",
      async (requestContext) => {
        requireAdmin(requestContext);
        const traveller = await findTravellerByName(
          context,
          tenantId,
          requestContext.pathParams["fullName"]!,
        );
        if (!traveller) throw notFound("Traveller");
        return traveller;
      },
    )
    .add("GET", "/api/v1/admin/crm/cases", async (requestContext) => {
      requireAdmin(requestContext);
      const requestedStatus = requestContext.queryParams["status"] ?? "NEW";
      if (!crm.CASE_STATUSES.includes(requestedStatus as crm.CaseStatus)) {
        throw badRequest(`Unknown case status ${requestedStatus}`);
      }
      return {
        cases: await listCasesByStatus(context, tenantId, requestedStatus as crm.CaseStatus),
      };
    })
    .add("POST", "/api/v1/admin/crm/cases", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CreateCaseBody, requestContext.body);
      return createCase(context, tenantId, body, requestContext.callerEmail);
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireAdmin(requestContext);
      return getCase(context, tenantId, requestContext.pathParams["caseId"]!);
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}/events", async (requestContext) => {
      requireAdmin(requestContext);
      return {
        events: await listCaseEvents(context, tenantId, requestContext.pathParams["caseId"]!),
      };
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/status", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CaseStatusBody, requestContext.body);
      return changeCaseStatus(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        body.toStatus,
        requestContext.callerEmail,
      );
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/billing", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(BillingStatusBody, requestContext.body);
      return changeBillingStatus(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        body.toBillingStatus,
        requestContext.callerEmail,
      );
    })
    .add(
      "PUT",
      "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/custody",
      async (requestContext) => {
        requireAdmin(requestContext);
        const body = parseBody(CustodyBody, requestContext.body);
        return changeApplicantCustody(
          context,
          tenantId,
          requestContext.pathParams["caseId"]!,
          requestContext.pathParams["applicantRef"]!,
          body.toCustody,
          requestContext.callerEmail,
        );
      },
    )
    .add(
      "PUT",
      "/api/v1/admin/crm/cases/{caseId}/applicants/{applicantRef}/outcome",
      async (requestContext) => {
        requireAdmin(requestContext);
        const body = parseBody(OutcomeBody, requestContext.body);
        return changeApplicantOutcome(
          context,
          tenantId,
          requestContext.pathParams["caseId"]!,
          requestContext.pathParams["applicantRef"]!,
          body.toOutcome,
          requestContext.callerEmail,
        );
      },
    );
}
