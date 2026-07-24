import { describe, expect, it } from "vitest";
import { IllegalStatusTransitionError } from "@rgs/shared";
import { submitApplication } from "../src/domain/applications";
import {
  addInternalNote,
  getApplicationDetailForAdmin,
  listApplicationsByStatus,
  presignDocumentDownloadForAdmin,
  reviewDocument,
  setPaymentStatus,
  transitionApplication,
} from "../src/domain/admin";
import { listRecentActivity, listUserActivity } from "../src/domain/activity";
import { buildTestContext, createSubmittableUaeDraft } from "./helpers";

async function submittedApplication(context = buildTestContext()) {
  const applicationId = await createSubmittableUaeDraft(context);
  await submitApplication(context, "user_1", applicationId, "asha@example.com");
  return { context, applicationId };
}

async function approveAllDocuments(
  context: Awaited<ReturnType<typeof submittedApplication>>["context"],
  applicationId: string,
) {
  for (const docType of ["PASSPORT_BIO", "PHOTO"] as const) {
    await reviewDocument(
      context,
      "admin_1",
      "admin@example.com",
      applicationId,
      docType,
      0,
      "APPROVED",
      "asha@example.com",
    );
  }
}

describe("status queues", () => {
  it("lists submitted applications for the admin queue", async () => {
    const { context, applicationId } = await submittedApplication();
    const submittedQueue = await listApplicationsByStatus(context, "SUBMITTED");
    expect(submittedQueue.map((application) => application.applicationId)).toContain(
      applicationId,
    );
    expect(await listApplicationsByStatus(context, "APPROVED")).toHaveLength(0);
  });
});

describe("transitionApplication", () => {
  it("walks the happy path to DELIVERED with emails at each step", async () => {
    const { context, applicationId } = await submittedApplication();
    await approveAllDocuments(context, applicationId);
    for (const nextStatus of [
      "DOCS_VERIFIED",
      "SENT_TO_IMMIGRATION",
      "APPROVED",
      "DELIVERED",
    ] as const) {
      await transitionApplication(
        context,
        "admin_1",
        "admin@example.com",
        applicationId,
        nextStatus,
        "asha@example.com",
      );
    }
    const detail = await getApplicationDetailForAdmin(context, applicationId);
    expect(detail.application.status).toBe("DELIVERED");
    const emailSubjects = context.email.sentEmails.map((sentEmail) => sentEmail.subject);
    expect(emailSubjects.filter((subject) => subject.includes("Update on your"))).toHaveLength(4);
  });

  it("refuses illegal jumps", async () => {
    const { context, applicationId } = await submittedApplication();
    await expect(
      transitionApplication(context, "admin_1", "admin@example.com", applicationId, "DELIVERED", "a@b.com"),
    ).rejects.toBeInstanceOf(IllegalStatusTransitionError);
  });

  it("refuses DOCS_VERIFIED while any document is unapproved", async () => {
    const { context, applicationId } = await submittedApplication();
    await expect(
      transitionApplication(context, "admin_1", "admin@example.com", applicationId, "DOCS_VERIFIED", "a@b.com"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("reviewDocument", () => {
  it("rejecting requires a reason and emails the user", async () => {
    const { context, applicationId } = await submittedApplication();
    await expect(
      reviewDocument(
        context,
        "admin_1",
        "admin@example.com",
        applicationId,
        "PHOTO",
        0,
        "REJECTED",
        "asha@example.com",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const rejectedDocument = await reviewDocument(
      context,
      "admin_1",
      "admin@example.com",
      applicationId,
      "PHOTO",
      0,
      "REJECTED",
      "asha@example.com",
      "Photo is blurry",
    );
    expect(rejectedDocument.reviewStatus).toBe("REJECTED");
    const lastEmail = context.email.sentEmails.at(-1)!;
    expect(lastEmail.subject).toContain("re-upload");
    expect(lastEmail.bodyText).toContain("Photo is blurry");
  });
});

describe("setPaymentStatus", () => {
  it("walks UNPAID -> REQUESTED -> PAID_OFFLINE and blocks skips", async () => {
    const { context, applicationId } = await submittedApplication();
    await expect(
      setPaymentStatus(context, "admin_1", "admin@example.com", applicationId, "PAID_OFFLINE", "a@b.com"),
    ).rejects.toMatchObject({ statusCode: 409 });

    const requested = await setPaymentStatus(
      context,
      "admin_1",
      "admin@example.com",
      applicationId,
      "REQUESTED",
      "asha@example.com",
    );
    expect(requested.paymentStatus).toBe("REQUESTED");
    const paymentEmail = context.email.sentEmails.at(-1)!;
    expect(paymentEmail.subject).toContain("Payment request");
    expect(paymentEmail.bodyText).toContain("INR 8000");

    const paid = await setPaymentStatus(
      context,
      "admin_1",
      "admin@example.com",
      applicationId,
      "PAID_OFFLINE",
      "asha@example.com",
    );
    expect(paid.paymentStatus).toBe("PAID_OFFLINE");
  });
});

describe("presignDocumentDownloadForAdmin", () => {
  it("returns a download URL for any application's document", async () => {
    const { context, applicationId } = await submittedApplication();
    const downloadUrl = await presignDocumentDownloadForAdmin(
      context,
      applicationId,
      "PHOTO",
      0,
    );
    expect(downloadUrl).toContain("download");
  });

  it("404s for a missing document slot", async () => {
    const { context, applicationId } = await submittedApplication();
    await expect(
      presignDocumentDownloadForAdmin(context, applicationId, "BANK_STATEMENT", 0),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("notes and activity", () => {
  it("appends timestamped internal notes", async () => {
    const { context, applicationId } = await submittedApplication();
    const withNote = await addInternalNote(
      context,
      "admin_1",
      applicationId,
      "Called client, docs on the way",
    );
    expect(withNote.internalNotes).toHaveLength(1);
    expect(withNote.internalNotes[0]).toContain("admin_1");
  });

  it("exposes the user's full activity trail and the recent feed", async () => {
    const { context, applicationId } = await submittedApplication();
    const userTrail = await listUserActivity(context, "user_1");
    const trailEventTypes = userTrail.map((activityEvent) => activityEvent.eventType);
    expect(trailEventTypes).toContain("APPLICATION_STARTED");
    expect(trailEventTypes).toContain("DOC_UPLOADED");
    expect(trailEventTypes).toContain("SUBMITTED");

    const recentFeed = await listRecentActivity(context, 2);
    expect(
      recentFeed.some((activityEvent) => activityEvent.applicationId === applicationId),
    ).toBe(true);
  });

  it("stamps user actor identity on SUBMITTED and admin actor on STATUS_CHANGED", async () => {
    const { context, applicationId } = await submittedApplication();
    const userTrail = await listUserActivity(context, "user_1");
    const submittedEvent = userTrail.find(
      (activityEvent) => activityEvent.eventType === "SUBMITTED",
    );
    expect(submittedEvent?.actorRole).toBe("user");
    expect(submittedEvent?.actorEmail).toBe("asha@example.com");
    expect(submittedEvent?.userId).toBe("user_1");

    await approveAllDocuments(context, applicationId);
    await transitionApplication(
      context,
      "admin_1",
      "admin@example.com",
      applicationId,
      "DOCS_VERIFIED",
      "asha@example.com",
    );
    const updatedTrail = await listUserActivity(context, "user_1");
    const statusChangedEvent = updatedTrail.find(
      (activityEvent) => activityEvent.eventType === "STATUS_CHANGED",
    );
    expect(statusChangedEvent?.actorRole).toBe("admin");
    expect(statusChangedEvent?.actorEmail).toBe("admin@example.com");
    expect(statusChangedEvent?.userId).toBe("user_1");
    expect(statusChangedEvent?.meta["fromStatus"]).toBe("SUBMITTED");
    expect(statusChangedEvent?.meta["toStatus"]).toBe("DOCS_VERIFIED");
  });
});
