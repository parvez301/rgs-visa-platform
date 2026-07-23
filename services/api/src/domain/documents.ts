import {
  getDocsChecklist,
  type ApplicationDocument,
  type DocType,
} from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  type AllowedUploadContentType,
} from "../lib/documentStore";
import { badRequest, notFound } from "../lib/errors";
import { getOwnedApplication } from "./applications";

const CONTENT_TYPE_EXTENSIONS: Record<AllowedUploadContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

export function documentObjectKey(
  applicationId: string,
  travellerIndex: number,
  docType: DocType,
  fileExtension: string,
): string {
  return `applications/${applicationId}/traveller-${travellerIndex}/${docType}.${fileExtension}`;
}

function assertValidDocRequest(
  countryCode: string,
  travellerCount: number,
  docType: DocType,
  travellerIndex: number,
): void {
  if (travellerIndex < 0 || travellerIndex >= travellerCount) {
    throw badRequest(`travellerIndex ${travellerIndex} is out of range`);
  }
  const requiredDocTypes = getDocsChecklist(countryCode);
  if (!requiredDocTypes.includes(docType)) {
    throw badRequest(`${docType} is not part of the ${countryCode} document checklist`);
  }
}

export async function presignDocumentUpload(
  context: AppContext,
  userId: string,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
  contentType: string,
): Promise<{ uploadUrl: string; objectKey: string }> {
  const application = await getOwnedApplication(context, userId, applicationId);
  assertValidDocRequest(
    application.countryCode,
    application.travellers.length,
    docType,
    travellerIndex,
  );
  if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(contentType as AllowedUploadContentType)) {
    throw badRequest(
      `contentType must be one of: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(", ")}`,
    );
  }
  const allowedContentType = contentType as AllowedUploadContentType;
  const objectKey = documentObjectKey(
    applicationId,
    travellerIndex,
    docType,
    CONTENT_TYPE_EXTENSIONS[allowedContentType],
  );
  const uploadUrl = await context.documents.presignUpload(objectKey, allowedContentType);
  return { uploadUrl, objectKey };
}

export async function recordDocumentUpload(
  context: AppContext,
  userId: string,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
  objectKey: string,
): Promise<ApplicationDocument> {
  const application = await getOwnedApplication(context, userId, applicationId);
  assertValidDocRequest(
    application.countryCode,
    application.travellers.length,
    docType,
    travellerIndex,
  );
  const expectedKeyPrefix = `applications/${applicationId}/traveller-${travellerIndex}/${docType}.`;
  if (!objectKey.startsWith(expectedKeyPrefix)) {
    throw badRequest("objectKey does not match the presigned location");
  }
  const applicationDocument: ApplicationDocument = {
    applicationId,
    docType,
    travellerIndex,
    s3Key: objectKey,
    reviewStatus: "PENDING",
    uploadedAt: context.now().toISOString(),
  };
  await context.table.put({
    PK: `APP#${applicationId}`,
    SK: `DOC#${docType}#${travellerIndex}`,
    ...applicationDocument,
  });
  await logActivity(context, "DOC_UPLOADED", userId, applicationId, {
    docType,
    travellerIndex,
  });
  return applicationDocument;
}

export async function presignOwnedDocumentDownload(
  context: AppContext,
  userId: string,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
): Promise<string> {
  await getOwnedApplication(context, userId, applicationId);
  const documentItem = await context.table.get(
    `APP#${applicationId}`,
    `DOC#${docType}#${travellerIndex}`,
  );
  if (!documentItem) throw notFound("Document");
  return context.documents.presignDownload(String(documentItem.s3Key));
}
