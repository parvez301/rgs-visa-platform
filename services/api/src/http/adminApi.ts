import { APPLICATION_STATUSES, DOC_TYPES, PAYMENT_STATUSES } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { forbidden } from "../lib/errors";
import { listRecentActivity, listUserActivity } from "../domain/activity";
import {
  addInternalNote,
  getApplicationDetailForAdmin,
  listApplicationsByStatus,
  presignDocumentDownloadForAdmin,
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
import { listUserProfiles } from "../domain/users";
import {
  deleteNotice,
  listNotices,
  upsertNotice,
} from "../domain/notices";
import { Router, parseBody, parseQueryParam, type RequestContext } from "./router";
import { registerAgentRoutes } from "./agentApi";
import { registerCrmRoutes } from "./crmApi";

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

export function requireAdmin(requestContext: RequestContext): {
  adminId: string;
  adminEmail: string;
} {
  if (!requestContext.callerId) throw forbidden("Admin sign in required");
  return { adminId: requestContext.callerId, adminEmail: requestContext.callerEmail };
}

export function buildAdminRouter(context: AppContext): Router {
  const adminRouter = new Router()
    .add("GET", "/api/v1/admin/applications", async (requestContext) => {
      requireAdmin(requestContext);
      const status = parseQueryParam(
        z.enum(APPLICATION_STATUSES),
        "status",
        requestContext.queryParams["status"] ?? "SUBMITTED",
      );
      // { applications, unreadableApplicationIds } — a row that would not
      // parse is named in the response rather than taking the ops team's
      // whole work queue down with it.
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
        const { adminId, adminEmail } = requireAdmin(requestContext);
        const input = parseBody(TransitionSchema, requestContext.body);
        return transitionApplication(
          context,
          adminId,
          adminEmail,
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
        const { adminId, adminEmail } = requireAdmin(requestContext);
        const input = parseBody(PaymentSchema, requestContext.body);
        return setPaymentStatus(
          context,
          adminId,
          adminEmail,
          requestContext.pathParams["applicationId"]!,
          input.toPaymentStatus,
          input.userEmail,
        );
      },
    )
    .add(
      "GET",
      "/api/v1/admin/applications/{applicationId}/documents/download",
      async (requestContext) => {
        requireAdmin(requestContext);
        const docType = parseQueryParam(
          z.enum(DOC_TYPES),
          "docType",
          requestContext.queryParams["docType"] ?? "",
        );
        const travellerIndex = Number(requestContext.queryParams["travellerIndex"] ?? "0");
        const downloadUrl = await presignDocumentDownloadForAdmin(
          context,
          requestContext.pathParams["applicationId"]!,
          docType,
          travellerIndex,
        );
        return { downloadUrl };
      },
    )
    .add("POST", "/api/v1/admin/documents/review", async (requestContext) => {
      const { adminId, adminEmail } = requireAdmin(requestContext);
      const input = parseBody(ReviewDocumentSchema, requestContext.body);
      return reviewDocument(
        context,
        adminId,
        adminEmail,
        input.applicationId,
        input.docType,
        input.travellerIndex,
        input.decision,
        input.userEmail,
        input.rejectReason,
      );
    })
    .add("POST", "/api/v1/admin/applications/{applicationId}/notes", async (requestContext) => {
      const { adminId } = requireAdmin(requestContext);
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
    .add("GET", "/api/v1/admin/users", async (requestContext) => {
      requireAdmin(requestContext);
      return listUserProfiles(context);
    })
    .add("GET", "/api/v1/admin/notices", async (requestContext) => {
      requireAdmin(requestContext);
      return listNotices(context);
    })
    .add("PUT", "/api/v1/admin/notices", async (requestContext) => {
      const { adminEmail } = requireAdmin(requestContext);
      return upsertNotice(context, adminEmail, requestContext.body);
    })
    .add("DELETE", "/api/v1/admin/notices/{noticeId}", async (requestContext) => {
      requireAdmin(requestContext);
      await deleteNotice(context, requestContext.pathParams["noticeId"]!);
      return { deleted: true };
    })
    // Country config management: docs, fees, timelines — admin-editable
    .add("GET", "/api/v1/admin/config/countries", async (requestContext) => {
      requireAdmin(requestContext);
      return listCountryConfig(context);
    })
    .add("PUT", "/api/v1/admin/config/countries", async (requestContext) => {
      const { adminId, adminEmail } = requireAdmin(requestContext);
      return upsertCountryProduct(context, adminId, adminEmail, requestContext.body);
    })
    .add("POST", "/api/v1/admin/config/seed", async (requestContext) => {
      requireAdmin(requestContext);
      const seededCount = await seedCountryConfig(context);
      return { seededCount };
    });
  return registerAgentRoutes(registerCrmRoutes(adminRouter, context), context);
}
