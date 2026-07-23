import { DOC_TYPES } from "@rgs/shared";
import { z } from "zod";
import type { AppContext } from "../lib/context";
import { forbidden } from "../lib/errors";
import {
  PatchDraftSchema,
  createDraft,
  getOwnedApplication,
  listApplicationDocuments,
  listMyApplications,
  patchDraft,
  submitApplication,
} from "../domain/applications";
import {
  presignDocumentUpload,
  presignOwnedDocumentDownload,
  recordDocumentUpload,
} from "../domain/documents";
import { CreateLeadSchema, createLead } from "../domain/leads";
import { listActiveCountryConfig } from "../domain/config";
import { Router, parseBody, type RequestContext } from "./router";

const CreateDraftSchema = z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) });

const PresignSchema = z.object({
  docType: z.enum(DOC_TYPES),
  travellerIndex: z.number().int().nonnegative(),
  contentType: z.string(),
});

const RecordUploadSchema = PresignSchema.omit({ contentType: true }).extend({
  objectKey: z.string().min(1),
});

function requireUser(requestContext: RequestContext): { userId: string; email: string } {
  if (!requestContext.callerId) throw forbidden("Sign in required");
  return { userId: requestContext.callerId, email: requestContext.callerEmail };
}

export function buildUserRouter(context: AppContext): Router {
  return new Router()
    .add("POST", "/api/v1/applications", async (requestContext) => {
      const { userId } = requireUser(requestContext);
      const input = parseBody(CreateDraftSchema, requestContext.body);
      return createDraft(context, userId, input.countryCode);
    })
    .add("GET", "/api/v1/applications", async (requestContext) => {
      const { userId } = requireUser(requestContext);
      return listMyApplications(context, userId);
    })
    .add("GET", "/api/v1/applications/{applicationId}", async (requestContext) => {
      const { userId } = requireUser(requestContext);
      const application = await getOwnedApplication(
        context,
        userId,
        requestContext.pathParams["applicationId"]!,
      );
      const documents = await listApplicationDocuments(context, application.applicationId);
      return { application, documents };
    })
    .add("PATCH", "/api/v1/applications/{applicationId}", async (requestContext) => {
      const { userId } = requireUser(requestContext);
      const patch = parseBody(PatchDraftSchema, requestContext.body);
      return patchDraft(context, userId, requestContext.pathParams["applicationId"]!, patch);
    })
    .add("POST", "/api/v1/applications/{applicationId}/submit", async (requestContext) => {
      const { userId, email } = requireUser(requestContext);
      return submitApplication(
        context,
        userId,
        requestContext.pathParams["applicationId"]!,
        email,
      );
    })
    .add(
      "POST",
      "/api/v1/applications/{applicationId}/documents/presign",
      async (requestContext) => {
        const { userId } = requireUser(requestContext);
        const input = parseBody(PresignSchema, requestContext.body);
        return presignDocumentUpload(
          context,
          userId,
          requestContext.pathParams["applicationId"]!,
          input.docType,
          input.travellerIndex,
          input.contentType,
        );
      },
    )
    .add("POST", "/api/v1/applications/{applicationId}/documents", async (requestContext) => {
      const { userId } = requireUser(requestContext);
      const input = parseBody(RecordUploadSchema, requestContext.body);
      return recordDocumentUpload(
        context,
        userId,
        requestContext.pathParams["applicationId"]!,
        input.docType,
        input.travellerIndex,
        input.objectKey,
      );
    })
    .add(
      "GET",
      "/api/v1/applications/{applicationId}/documents/download",
      async (requestContext) => {
        const { userId } = requireUser(requestContext);
        const docType = requestContext.queryParams["docType"] ?? "";
        const travellerIndex = Number(requestContext.queryParams["travellerIndex"] ?? "0");
        const parsedDocType = z.enum(DOC_TYPES).parse(docType);
        const downloadUrl = await presignOwnedDocumentDownload(
          context,
          userId,
          requestContext.pathParams["applicationId"]!,
          parsedDocType,
          travellerIndex,
        );
        return { downloadUrl };
      },
    )
    .add("POST", "/api/v1/leads", async (requestContext) => {
      const input = parseBody(CreateLeadSchema, requestContext.body);
      return createLead(context, input);
    })
    // Public: live catalog for marketing site + portal (no auth)
    .add("GET", "/api/v1/config/countries", async () => {
      return listActiveCountryConfig(context);
    });
}
