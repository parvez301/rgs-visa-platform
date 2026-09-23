import { APPLICATION_STATUSES, DOC_TYPES, PAYMENT_STATUSES } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
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
import { Router, parseBody, parseQueryParam } from "./router";
import { requireScreen, requireWrite } from "./adminAccess";
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

export function buildAdminRouter(context: AppContext): Router {
  const adminRouter = new Router()
    .add("GET", "/api/v1/admin/applications", async (requestContext) => {
      requireScreen(requestContext, "queue");
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
      requireScreen(requestContext, "queue");
      return getApplicationDetailForAdmin(
        context,
        requestContext.pathParams["applicationId"]!,
      );
    })
    .add(
      "POST",
      "/api/v1/admin/applications/{applicationId}/transition",
      async (requestContext) => {
        const { adminId, adminEmail } = requireWrite(requestContext, "queue");
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
        const { adminId, adminEmail } = requireWrite(requestContext, "queue");
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
        requireScreen(requestContext, "queue");
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
      const { adminId, adminEmail } = requireWrite(requestContext, "queue");
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
      const { adminId } = requireWrite(requestContext, "queue");
      const input = parseBody(NoteSchema, requestContext.body);
      return addInternalNote(
        context,
        adminId,
        requestContext.pathParams["applicationId"]!,
        input.noteText,
      );
    })
    .add("GET", "/api/v1/admin/activity", async (requestContext) => {
      requireScreen(requestContext, "activity");
      const userId = requestContext.queryParams["userId"];
      if (userId) return listUserActivity(context, userId);
      const daysBack = Number(requestContext.queryParams["daysBack"] ?? "2");
      return listRecentActivity(context, daysBack);
    })
    .add("GET", "/api/v1/admin/leads", async (requestContext) => {
      requireScreen(requestContext, "leads");
      return listNewLeads(context);
    })
    .add("GET", "/api/v1/admin/users", async (requestContext) => {
      requireScreen(requestContext, "activity");
      return listUserProfiles(context);
    })
    .add("GET", "/api/v1/admin/notices", async (requestContext) => {
      requireScreen(requestContext, "notices");
      return listNotices(context);
    })
    .add("PUT", "/api/v1/admin/notices", async (requestContext) => {
      const { adminEmail } = requireWrite(requestContext, "notices");
      return upsertNotice(context, adminEmail, requestContext.body);
    })
    .add("DELETE", "/api/v1/admin/notices/{noticeId}", async (requestContext) => {
      requireWrite(requestContext, "notices");
      await deleteNotice(context, requestContext.pathParams["noticeId"]!);
      return { deleted: true };
    })
    // Country config management: docs, fees, timelines — admin-editable
    .add("GET", "/api/v1/admin/config/countries", async (requestContext) => {
      requireScreen(requestContext, "config");
      return listCountryConfig(context);
    })
    .add("PUT", "/api/v1/admin/config/countries", async (requestContext) => {
      const { adminId, adminEmail } = requireWrite(requestContext, "config");
      return upsertCountryProduct(context, adminId, adminEmail, requestContext.body);
    })
    .add("POST", "/api/v1/admin/config/seed", async (requestContext) => {
      requireWrite(requestContext, "config");
      const seededCount = await seedCountryConfig(context);
      return { seededCount };
    });
  return registerAgentRoutes(registerCrmRoutes(adminRouter, context), context);
}
