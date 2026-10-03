import {
  assertTransition,
  type Application,
  type ApplicationDocument,
  type ApplicationStatus,
  type DocType,
  type PaymentStatus,
} from "@rgs/shared";
import type { AppContext } from "../lib/context";
import { logActivity } from "../lib/context";
import { badRequest, conflict, notFound } from "../lib/errors";
import {
  getApplicationDocument,
  listApplicationDocuments,
  saveApplication,
  saveApplicationDocument,
} from "./applications";
import { listApplicationDocumentsPostgres } from "./applicationDocumentsPostgres";
import {
  getApplicationPostgres,
  listApplicationsByStatusPostgres,
} from "./applicationsPostgres";
import { requireSql } from "./crm/postgresClient";

/** Admin lookup by application id alone. */
export async function getApplicationById(
  context: AppContext,
  applicationId: string,
): Promise<Application> {
  const application = await getApplicationPostgres(requireSql(context), applicationId);
  if (!application) throw notFound("Application");
  return application;
}

export interface ApplicationListing {
  applications: Application[];
  /**
   * Rows the index names that could not be turned back into an Application.
   * Named rather than merely absent: this is the ops team's work queue, and
   * an application that vanishes from it is indistinguishable from one never
   * submitted.
   */
  unreadableApplicationIds: string[];
}

export async function listApplicationsByStatus(
  context: AppContext,
  status: ApplicationStatus,
  limit = 50,
): Promise<ApplicationListing> {
  return listApplicationsByStatusPostgres(requireSql(context), status, limit);
}

export interface AdminApplicationDetail {
  application: Application;
  documents: ApplicationDocument[];
}

export async function getApplicationDetailForAdmin(
  context: AppContext,
  applicationId: string,
): Promise<AdminApplicationDetail> {
  const application = await getApplicationById(context, applicationId);
  const documents = await listApplicationDocuments(context, applicationId);
  return { application, documents };
}

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  UNPAID: ["REQUESTED"],
  REQUESTED: ["PAID_OFFLINE"],
  PAID_OFFLINE: [],
};

export async function setPaymentStatus(
  context: AppContext,
  adminId: string,
  adminEmail: string,
  applicationId: string,
  toPaymentStatus: PaymentStatus,
  userEmail: string,
): Promise<Application> {
  const application = await getApplicationById(context, applicationId);
  if (!PAYMENT_TRANSITIONS[application.paymentStatus].includes(toPaymentStatus)) {
    throw conflict(
      `Payment cannot move ${application.paymentStatus} -> ${toPaymentStatus}`,
    );
  }
  const updatedApplication: Application = {
    ...application,
    paymentStatus: toPaymentStatus,
    updatedAt: context.now().toISOString(),
  };
  await saveApplication(context, updatedApplication);
  const eventType =
    toPaymentStatus === "REQUESTED" ? "PAYMENT_REQUESTED" : "PAYMENT_MARKED_PAID";
  await logActivity(
    context,
    eventType,
    application.userId,
    applicationId,
    {
      actor: adminId,
    },
    { actorEmail: adminEmail, actorRole: "admin" },
  );
  if (toPaymentStatus === "REQUESTED") {
    const totalAmountInr =
      application.amounts.governmentFeeInr + application.amounts.serviceFeeInr;
    await context.email.send({
      toAddress: userEmail,
      subject: `Payment request — ${application.countryCode} visa application`,
      bodyText: [
        `Your documents are verified. Total payable: INR ${totalAmountInr}.`,
        "Our team will share payment options (UPI / bank transfer).",
        "Reply to this email or call us for assistance.",
      ].join("\n"),
    });
  }
  return updatedApplication;
}

export async function transitionApplication(
  context: AppContext,
  adminId: string,
  adminEmail: string,
  applicationId: string,
  toStatus: ApplicationStatus,
  userEmail: string,
  meta: Record<string, string | number | boolean> = {},
): Promise<Application> {
  const application = await getApplicationById(context, applicationId);
  assertTransition(application.status, toStatus);

  if (toStatus === "DOCS_VERIFIED") {
    // A document row that will not parse is not an approved document.
    const { unreadableDocumentIds } = await listApplicationDocumentsPostgres(
      requireSql(context),
      applicationId,
    );
    if (unreadableDocumentIds.length > 0) {
      throw conflict(
        `Unreadable document records must be fixed first: ${unreadableDocumentIds.join(", ")}`,
      );
    }
    const documents = await listApplicationDocuments(context, applicationId);
    const allApproved =
      documents.length > 0 &&
      documents.every((applicationDocument) => applicationDocument.reviewStatus === "APPROVED");
    if (!allApproved) {
      throw conflict("All documents must be approved before marking docs verified");
    }
  }

  const updatedApplication: Application = {
    ...application,
    status: toStatus,
    updatedAt: context.now().toISOString(),
  };
  await saveApplication(context, updatedApplication);
  await logActivity(
    context,
    "STATUS_CHANGED",
    application.userId,
    applicationId,
    {
      ...meta,
      actor: adminId,
      fromStatus: application.status,
      toStatus,
    },
    { actorEmail: adminEmail, actorRole: "admin" },
  );
  const statusMessages: Partial<Record<ApplicationStatus, string>> = {
    DOCS_VERIFIED: "Your documents have been verified by our team.",
    SENT_TO_IMMIGRATION: "Your application has been submitted to immigration.",
    APPROVED: "Great news — your visa has been approved!",
    REJECTED:
      "Unfortunately your application was not approved. Our team will contact you about next steps and our rejection-support options.",
    DELIVERED: "Your visa is ready — download it from your RGS dashboard.",
  };
  const statusMessage = statusMessages[toStatus];
  if (statusMessage) {
    await context.email.send({
      toAddress: userEmail,
      subject: `Update on your ${application.countryCode} visa application`,
      bodyText: statusMessage,
    });
  }
  return updatedApplication;
}

export async function reviewDocument(
  context: AppContext,
  adminId: string,
  adminEmail: string,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
  decision: "APPROVED" | "REJECTED",
  userEmail: string,
  rejectReason?: string,
): Promise<ApplicationDocument> {
  const documentItem = await getApplicationDocument(
    context,
    applicationId,
    docType,
    travellerIndex,
  );
  if (!documentItem) throw notFound("Document");
  if (decision === "REJECTED" && !rejectReason) {
    throw badRequest("rejectReason is required when rejecting a document");
  }
  const application = await getApplicationById(context, applicationId);
  const reviewedDocument: ApplicationDocument = {
    applicationId,
    docType,
    travellerIndex,
    s3Key: String(documentItem.s3Key),
    reviewStatus: decision,
    ...(decision === "REJECTED" ? { rejectReason } : {}),
    uploadedAt: String(documentItem.uploadedAt),
  };
  await saveApplicationDocument(context, reviewedDocument);
  await logActivity(
    context,
    "DOC_REVIEWED",
    application.userId,
    applicationId,
    {
      actor: adminId,
      docType,
      travellerIndex,
      decision,
    },
    { actorEmail: adminEmail, actorRole: "admin" },
  );
  if (decision === "REJECTED") {
    await context.email.send({
      toAddress: userEmail,
      subject: `Action needed — re-upload a document (${application.countryCode} visa)`,
      bodyText: [
        `Your ${docType} for traveller ${travellerIndex + 1} needs to be re-uploaded.`,
        `Reason: ${rejectReason}`,
        "Sign in to your RGS dashboard to upload a corrected copy.",
      ].join("\n"),
    });
  }
  return reviewedDocument;
}

export async function presignDocumentDownloadForAdmin(
  context: AppContext,
  applicationId: string,
  docType: DocType,
  travellerIndex: number,
): Promise<string> {
  await getApplicationById(context, applicationId);
  const documentItem = await getApplicationDocument(
    context,
    applicationId,
    docType,
    travellerIndex,
  );
  if (!documentItem) throw notFound("Document");
  return context.documents.presignDownload(String(documentItem.s3Key));
}

export async function addInternalNote(
  context: AppContext,
  adminId: string,
  applicationId: string,
  noteText: string,
): Promise<Application> {
  if (noteText.trim() === "") throw badRequest("Note cannot be empty");
  const application = await getApplicationById(context, applicationId);
  const timestampedNote = `[${context.now().toISOString()} ${adminId}] ${noteText.trim()}`;
  const updatedApplication: Application = {
    ...application,
    internalNotes: [...application.internalNotes, timestampedNote],
    updatedAt: context.now().toISOString(),
  };
  await saveApplication(context, updatedApplication);
  return updatedApplication;
}
