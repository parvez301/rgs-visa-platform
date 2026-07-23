import { APPLICATION_STATUSES, DOC_TYPES, PAYMENT_STATUSES } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { forbidden } from "../lib/errors";
import { listRecentActivity, listUserActivity } from "../domain/activity";
import {
  addInternalNote,
  getApplicationDetailForAdmin,
  listApplicationsByStatus,
  reviewDocument,
  setPaymentStatus,
  transitionApplication,
} from "../domain/admin";
import { listNewLeads } from "../domain/leads";
import {
  listCountryConfig,
  seedCountryConfig,
  upsertCountryProduct,
} from "../domain/config";
import { Router, parseBody, type RequestContext } from "./router";

const TransitionSchema = z.object({
  toStatus: z.enum(APPLICATION_STATUSES),
  userEmail: z.string().email(),
});

const PaymentSchema = z.object({
  toPaymentStatus: z.enum(PAYMENT_STATUSES),
  userEmail: z.string().email(),
});

const ReviewDocumentSchema = z.object({
  applicationId: z.string().min(1),
  docType: z.enum(DOC_TYPES),
  travellerIndex: z.number().int().nonnegative(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  userEmail: z.string().email(),
  rejectReason: z.string().min(1).optional(),
});

const NoteSchema = z.object({ noteText: z.string().min(1).max(2000) });

function requireAdmin(requestContext: RequestContext): string {
  if (!requestContext.callerId) throw forbidden("Admin sign in required");
  return requestContext.callerId;
}

export function buildAdminRouter(context: AppContext): Router {
  return new Router()
    .add("GET", "/api/v1/admin/applications", async (requestContext) => {
      requireAdmin(requestContext);
      const status = z
        .enum(APPLICATION_STATUSES)
        .parse(requestContext.queryParams["status"] ?? "SUBMITTED");
      return listApplicationsByStatus(context, status);
    })
    .add("GET", "/api/v1/admin/applications/{applicationId}", async (requestContext) => {
      requireAdmin(requestContext);
      return getApplicationDetailForAdmin(
        context,
        requestContext.pathParams["applicationId"]!,
      );
    })
    .add(
      "POST",
      "/api/v1/admin/applications/{applicationId}/transition",
      async (requestContext) => {
        const adminId = requireAdmin(requestContext);
        const input = parseBody(TransitionSchema, requestContext.body);
        return transitionApplication(
          context,
          adminId,
          requestContext.pathParams["applicationId"]!,
          input.toStatus,
          input.userEmail,
        );
      },
    )
    .add(
      "POST",
      "/api/v1/admin/applications/{applicationId}/payment",
      async (requestContext) => {
        const adminId = requireAdmin(requestContext);
        const input = parseBody(PaymentSchema, requestContext.body);
        return setPaymentStatus(
          context,
          adminId,
          requestContext.pathParams["applicationId"]!,
          input.toPaymentStatus,
          input.userEmail,
        );
      },
    )
    .add("POST", "/api/v1/admin/documents/review", async (requestContext) => {
      const adminId = requireAdmin(requestContext);
      const input = parseBody(ReviewDocumentSchema, requestContext.body);
      return reviewDocument(
        context,
        adminId,
        input.applicationId,
        input.docType,
        input.travellerIndex,
        input.decision,
        input.userEmail,
        input.rejectReason,
      );
    })
    .add("POST", "/api/v1/admin/applications/{applicationId}/notes", async (requestContext) => {
      const adminId = requireAdmin(requestContext);
      const input = parseBody(NoteSchema, requestContext.body);
      return addInternalNote(
        context,
        adminId,
        requestContext.pathParams["applicationId"]!,
        input.noteText,
      );
    })
    .add("GET", "/api/v1/admin/activity", async (requestContext) => {
      requireAdmin(requestContext);
      const userId = requestContext.queryParams["userId"];
      if (userId) return listUserActivity(context, userId);
      const daysBack = Number(requestContext.queryParams["daysBack"] ?? "2");
      return listRecentActivity(context, daysBack);
    })
    .add("GET", "/api/v1/admin/leads", async (requestContext) => {
      requireAdmin(requestContext);
      return listNewLeads(context);
    })
    // Country config management: docs, fees, timelines — admin-editable
    .add("GET", "/api/v1/admin/config/countries", async (requestContext) => {
      requireAdmin(requestContext);
      return listCountryConfig(context);
    })
    .add("PUT", "/api/v1/admin/config/countries", async (requestContext) => {
      const adminId = requireAdmin(requestContext);
      return upsertCountryProduct(context, adminId, requestContext.body);
    })
    .add("POST", "/api/v1/admin/config/seed", async (requestContext) => {
      requireAdmin(requestContext);
      const seededCount = await seedCountryConfig(context);
      return { seededCount };
    });
}
