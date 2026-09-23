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
  listCasesByPartner,
  listCasesByStatus,
  updateCaseDetails,
  type UpdateCaseDetailsInput,
} from "../domain/crm/cases";
import {
  ensureCaseDocumentChecklist,
  setCaseDocumentCheckState,
} from "../domain/crm/caseDocumentChecklist";
import { generateCaseInvoice } from "../domain/crm/caseInvoice";
import { runAppointmentReminders } from "../domain/crm/appointmentReminders";
import { listCaseEvents } from "../domain/crm/crmEvents";
import { DEFAULT_TENANT_ID } from "../domain/crm/keys";
import {
  DEFAULT_LEDGER_PAGE_LIMIT,
  MAX_LEDGER_PAGE_LIMIT,
  listLedgerRows,
} from "../domain/crm/ledger";
import {
  listOpenReviewGroups,
  resolveReviewGroup,
  type ResolveReviewGroupInput,
} from "../domain/crm/reviewGroups";
import { createPartner, listPartners } from "../domain/crm/partners";
import {
  getReviewItemOrThrow,
  listReviewItems,
  resolveReviewItem,
  summariseOpenReviewItems,
  type ReviewItemResolution,
} from "../domain/crm/reviewQueue";
import {
  findTravellerByName,
  findTravellerByPassport,
  upsertTraveller,
} from "../domain/crm/travellers";
import { Router, parseBody, parseQueryParam } from "./router";
import { requireAdmin } from "./adminAccess";

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
  expectedCollectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  remarks: z.string().trim().min(1).max(2000).optional(),
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

const isoDateBody = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * The plain fields `updateCaseDetails` is allowed to touch, written out by name.
 * NOT a passthrough of the request body: `caseStatus`, per-applicant `custody`,
 * per-applicant `outcome` and `billingStatus` each have a state machine and
 * their own route, and a general "update any field" body is one forgotten key
 * away from walking around all four. Typed as the domain's own interface below
 * so a drift between the two fails to compile.
 */
const UpdateCaseDetailsBody = z.object({
  visaType: z.enum(crm.VISA_TYPES).optional(),
  entryType: z.enum(crm.ENTRY_TYPES).optional(),
  processing: z.enum(crm.PROCESSING_SPEEDS).optional(),
  submissionDate: isoDateBody.optional(),
  appointmentDate: isoDateBody.optional(),
  expectedCollectionDate: isoDateBody.optional(),
  remarks: z.string().trim().min(1).max(2000).optional(),
});

const CaseStatusBody = z.object({ toStatus: z.enum(crm.CASE_STATUSES) });
const BillingStatusBody = z.object({ toBillingStatus: z.enum(crm.BILLING_STATUSES) });
const CustodyBody = z.object({ toCustody: z.enum(crm.CUSTODY_STATUSES) });
const OutcomeBody = z.object({ toOutcome: z.enum(crm.APPLICANT_OUTCOMES) });
const DocumentCheckBody = z.object({
  label: z.string().trim().min(1),
  state: z.enum(crm.DOCUMENT_CHECK_STATES),
});

/**
 * Resolving means closing an open item, so OPEN is not among the destinations
 * even though crm.REVIEW_STATUSES carries it — a "resolution" back to OPEN is
 * a no-op the reviewer did not intend.
 */
const ResolveReviewItemBody = z.object({
  reviewStatus: z.enum(["APPLIED", "DISMISSED"]),
  resolvedValue: z.string().min(1).optional(),
});

/** One raw-value group of the review queue, and what to do with all of it. */
const ResolveReviewGroupBody = z.object({
  reason: z.enum(crm.REVIEW_REASONS),
  fieldName: z.string().min(1),
  rawValue: z.string(),
  reviewStatus: z.enum(["APPLIED", "DISMISSED"]),
  resolvedValue: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/**
 * API Gateway v2 collapses a repeated query parameter into one comma-joined
 * string, and RequestContext.queryParams is Record<string, string> -- so
 * "repeatable status" is `?status=NEW,SUBMITTED`, split here. An unrecognised
 * value is a 400 naming it, never a quiet fall back to "all": a typo that
 * silently widens the filter shows an operator rows they filtered out.
 */
function parseLedgerStatuses(rawStatuses: string | undefined): crm.CaseStatus[] {
  if (rawStatuses === undefined || rawStatuses.trim() === "") return [...crm.CASE_STATUSES];
  const requestedStatuses = rawStatuses.split(",").map((statusName) => statusName.trim());
  const parsedStatuses: crm.CaseStatus[] = [];
  for (const requestedStatus of requestedStatuses) {
    const matchedStatus = crm.CASE_STATUSES.find((caseStatus) => caseStatus === requestedStatus);
    if (matchedStatus === undefined) {
      // `?status=,` or `?status=NEW,` yields an empty-string token here. Named
      // explicitly rather than interpolated blank, or the 400 reads as
      // "Unknown case status " with nothing after it -- correct but useless.
      const describedToken = requestedStatus === "" ? "(blank)" : requestedStatus;
      throw badRequest(`Unknown case status ${describedToken}`);
    }
    if (!parsedStatuses.includes(matchedStatus)) parsedStatuses.push(matchedStatus);
  }
  return parsedStatuses;
}

const LedgerLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_LEDGER_PAGE_LIMIT)
  .default(DEFAULT_LEDGER_PAGE_LIMIT);

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
      // { partners, unreadablePartnerIds } — a row that would not parse is
      // named in the response rather than silently missing from it, and never
      // takes the whole tenant's partner list down with it.
      return listPartners(context, tenantId);
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
      // { cases, unreadableCaseIds } — a row the store could not reassemble is
      // named in the response rather than silently missing from it.
      return listCasesByStatus(context, tenantId, requestedStatus as crm.CaseStatus);
    })
    .add("GET", "/api/v1/admin/crm/cases/by-partner/{partnerId}", async (requestContext) => {
      requireAdmin(requestContext);
      return listCasesByPartner(context, tenantId, requestContext.pathParams["partnerId"]!);
    })
    .add("POST", "/api/v1/admin/crm/cases", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(CreateCaseBody, requestContext.body);
      return createCase(context, tenantId, body, requestContext.callerEmail);
    })
    // BEFORE "/api/v1/admin/crm/cases/{caseId}", and it must stay that way:
    // Router.match returns the first route whose segment count and literals
    // match, both paths are six segments, and registered after it this route
    // would be answered by getCase with caseId="ledger" -- a 404 that looks
    // like a missing case. A test in crmApi.test.ts asserts the order.
    .add("GET", "/api/v1/admin/crm/cases/ledger", async (requestContext) => {
      requireAdmin(requestContext);
      const partnerId = requestContext.queryParams["partnerId"];
      const statuses = parseLedgerStatuses(requestContext.queryParams["status"]);
      const limit = parseQueryParam(
        LedgerLimitSchema,
        "limit",
        requestContext.queryParams["limit"],
      );
      const cursor = requestContext.queryParams["cursor"];

      const ledgerPage = await listLedgerRows(context, tenantId, {
        statuses,
        ...(partnerId !== undefined ? { partnerId } : {}),
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      return {
        ...ledgerPage,
        // What ran, not what was asked for. In partner mode the status filter
        // is not applied server-side (domain/crm/ledger.ts, decision 3), and a
        // client that could not see that would draw a filter chip for a filter
        // nothing is enforcing. `statuses` is omitted entirely in partner mode
        // rather than sent as `[]`: an empty array reads just as naturally as
        // "filtered down to nothing" as it does "no filter is in force", and
        // partner mode really does return a nonempty `rows` alongside it. Omitting
        // the field forces a client to handle its absence rather than leaving the
        // meaning in a comment.
        appliedQuery: {
          ...(partnerId !== undefined ? { partnerId } : { statuses }),
          limit,
        },
      };
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireAdmin(requestContext);
      return getCase(context, tenantId, requestContext.pathParams["caseId"]!);
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}", async (requestContext) => {
      requireAdmin(requestContext);
      const input: UpdateCaseDetailsInput = parseBody(UpdateCaseDetailsBody, requestContext.body);
      return updateCaseDetails(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        input,
        requestContext.callerEmail,
      );
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
    .add("POST", "/api/v1/admin/crm/cases/{caseId}/document-checklist/ensure", async (requestContext) => {
      requireAdmin(requestContext);
      return ensureCaseDocumentChecklist(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        requestContext.callerEmail,
      );
    })
    .add("PUT", "/api/v1/admin/crm/cases/{caseId}/document-checklist", async (requestContext) => {
      requireAdmin(requestContext);
      const body = parseBody(DocumentCheckBody, requestContext.body);
      return setCaseDocumentCheckState(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        body.label,
        body.state,
        requestContext.callerEmail,
      );
    })
    .add("GET", "/api/v1/admin/crm/cases/{caseId}/invoice", async (requestContext) => {
      requireAdmin(requestContext);
      return generateCaseInvoice(
        context,
        tenantId,
        requestContext.pathParams["caseId"]!,
        requestContext.callerEmail,
      );
    })
    .add("POST", "/api/v1/admin/crm/appointment-reminders/run", async (requestContext) => {
      requireAdmin(requestContext);
      const todayIso = context.now().toISOString().slice(0, 10);
      return runAppointmentReminders(
        context,
        tenantId,
        todayIso,
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
    )
    .add("GET", "/api/v1/admin/crm/review", async (requestContext) => {
      requireAdmin(requestContext);
      const requestedStatus = requestContext.queryParams["status"] ?? "OPEN";
      // `find` over the shared tuple narrows to crm.ReviewStatus without a
      // cast. An unrecognised value is a 400, never a quiet fall back to OPEN:
      // a typo that returns the wrong queue looks like an empty queue.
      const parsedStatus = crm.REVIEW_STATUSES.find((status) => status === requestedStatus);
      if (parsedStatus === undefined) {
        throw badRequest(`Unknown review status ${requestedStatus}`);
      }
      // { reviewItems, unreadableReviewItemIds, hasMore } — a row that would
      // not parse is named in the response rather than silently missing from
      // it, exactly as the case and partner listings shape theirs. An item
      // that vanishes from this queue is indistinguishable from one never
      // imported. `hasMore` says the same thing about the page as a whole: a
      // real import fills this queue with thousands of items and the page is
      // capped, so a caller that cannot see the cap cannot know it is looking
      // at 5% of the work.
      return listReviewItems(context, tenantId, parsedStatus);
    })
    // BEFORE "/api/v1/admin/crm/review/{reviewItemId}" -- same six-segment
    // collision as the ledger route above, same consequence: registered after
    // it, this answers `getReviewItemOrThrow("summary")` and 404s.
    .add("GET", "/api/v1/admin/crm/review/summary", async (requestContext) => {
      requireAdmin(requestContext);
      return summariseOpenReviewItems(context, tenantId);
    })
    // Same six-segment collision as /review/summary; must also stay before
    // "/api/v1/admin/crm/review/{reviewItemId}".
    .add("GET", "/api/v1/admin/crm/review/groups", async (requestContext) => {
      requireAdmin(requestContext);
      return listOpenReviewGroups(context, tenantId);
    })
    .add("POST", "/api/v1/admin/crm/review/groups/resolve", async (requestContext) => {
      requireAdmin(requestContext);
      const input: ResolveReviewGroupInput = parseBody(ResolveReviewGroupBody, requestContext.body);
      return resolveReviewGroup(context, tenantId, input, requestContext.callerEmail);
    })
    .add("GET", "/api/v1/admin/crm/review/{reviewItemId}", async (requestContext) => {
      requireAdmin(requestContext);
      return getReviewItemOrThrow(
        context,
        tenantId,
        requestContext.pathParams["reviewItemId"]!,
      );
    })
    .add("PUT", "/api/v1/admin/crm/review/{reviewItemId}/resolve", async (requestContext) => {
      requireAdmin(requestContext);
      // Typed as the domain's own interface, so a drift between this body
      // schema and what resolveReviewItem accepts fails to compile here.
      const resolution: ReviewItemResolution = parseBody(
        ResolveReviewItemBody,
        requestContext.body,
      );
      return resolveReviewItem(
        context,
        tenantId,
        requestContext.pathParams["reviewItemId"]!,
        resolution,
        requestContext.callerEmail,
      );
    });
}
