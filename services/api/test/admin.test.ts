import { afterEach, describe, expect, it } from "vitest";
import { IllegalStatusTransitionError } from "@rgs/shared";
import { submitApplication } from "../src/domain/applications";
import {
  addInternalNote,
  getApplicationById,
  getApplicationDetailForAdmin,
  listApplicationsByStatus,
  presignDocumentDownloadForAdmin,
  reviewDocument,
  setPaymentStatus,
  transitionApplication,
} from "../src/domain/admin";
import { listRecentActivity, listUserActivity } from "../src/domain/activity";
import { CorruptRecordError } from "../src/lib/errors";
import {
  buildSqlTestContext,
  closeSqlTestContexts,
  createSubmittableUaeDraft,
  type SqlTestContext,
} from "./helpers";

afterEach(closeSqlTestContexts);

async function submittedApplication(context?: SqlTestContext) {
  context ??= await buildSqlTestContext();
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
    expect(
      submittedQueue.applications.map((application) => application.applicationId),
    ).toContain(applicationId);
    expect(submittedQueue.unreadableApplicationIds).toEqual([]);
    expect((await listApplicationsByStatus(context, "APPROVED")).applications).toHaveLength(0);
  });

  // --- C3: router.ts maps only ApiError, so a raw ZodError from one stored
  // --- row answered 500 for the whole screen. This is the ops team's main
  // --- work queue; one hand-repaired row must not close it for everybody.
  it("skips a malformed application row instead of 500ing the whole queue", async () => {
    const { context, applicationId } = await submittedApplication();
    // A row that no longer satisfies the schema: an application needs at
    // least one traveller and this one has none.
    await context.sql.query(
      `insert into portal_applications (application_id, user_id, country_code, product_code,
         status, step_reached, travellers, amounts, payment_status, created_at, updated_at)
       values ($1, 'user_9', 'AE', 'tourist', 'SUBMITTED', 'travellers', '[]'::jsonb,
         '{"governmentFeeInr":1,"serviceFeeInr":1,"currency":"INR"}'::jsonb, 'UNPAID', now(), now())`,
      ["app_half_written"],
    );

    const submittedQueue = await listApplicationsByStatus(context, "SUBMITTED");
    expect(
      submittedQueue.applications.map((application) => application.applicationId),
    ).toEqual([applicationId]);
    // Named, not merely absent: an application missing from this queue is
    // otherwise indistinguishable from one that was never submitted.
    expect(submittedQueue.unreadableApplicationIds).toEqual(["app_half_written"]);
  });

  it("answers a typed 409 rather than a 500 when a single application will not parse", async () => {
    const context = await buildSqlTestContext();
    await context.sql.query(
      `insert into portal_applications (application_id, user_id, country_code, product_code,
         status, step_reached, travellers, amounts, payment_status, created_at, updated_at)
       values ($1, 'user_9', 'AE', 'tourist', 'SUBMITTED', 'travellers', '[]'::jsonb,
         '{"governmentFeeInr":1,"serviceFeeInr":1,"currency":"INR"}'::jsonb, 'UNPAID', now(), now())`,
      ["app_half_written"],
    );

    const read = getApplicationById(context, "app_half_written");
    await expect(read).rejects.toBeInstanceOf(CorruptRecordError);
    // 409, never 404: the row is on file and unreadable. A 404 would tell an
    // operator to re-create an application that already exists.
    await expect(read).rejects.toMatchObject({ statusCode: 409, code: "CORRUPT_RECORD" });
    await expect(read).rejects.toThrow("app_half_written");
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
    const trailEventTypes = userTrail.events.map((activityEvent) => activityEvent.eventType);
    expect(trailEventTypes).toContain("APPLICATION_STARTED");
    expect(trailEventTypes).toContain("DOC_UPLOADED");
    expect(trailEventTypes).toContain("SUBMITTED");

    const recentFeed = await listRecentActivity(context, 2);
    expect(
      recentFeed.events.some((activityEvent) => activityEvent.applicationId === applicationId),
    ).toBe(true);
    expect(recentFeed.unreadableEventIds).toEqual([]);
  });

  // --- C3, the activity half. A bad EVENT# row used to 500 the admin feed
  // --- for every admin until its day bucket aged out of the window, and one
  // --- user's trail forever, because listUserActivity has no window at all.
  it("skips an unparseable event instead of 500ing the feed and the user trail", async () => {
    const { context } = await submittedApplication();
    // `event_type` is not a known type: the shape a future code path or a
    // hand-repair leaves behind.
    await context.sql.query(
      `insert into activity_events (event_id, event_type, user_id, meta, created_at)
       values ('evt_half_written', 'NOT_A_TYPE', 'user_1', '{}'::jsonb, $1::timestamptz)`,
      [context.now().toISOString()],
    );

    const recentFeed = await listRecentActivity(context, 2);
    expect(recentFeed.events.length).toBeGreaterThan(0);
    expect(recentFeed.unreadableEventIds).toEqual(["evt_half_written"]);

    const userTrail = await listUserActivity(context, "user_1");
    expect(userTrail.events.length).toBeGreaterThan(0);
    expect(userTrail.unreadableEventIds).toEqual(["evt_half_written"]);
  });

  it("stamps user actor identity on SUBMITTED and admin actor on STATUS_CHANGED", async () => {
    const { context, applicationId } = await submittedApplication();
    const userTrail = await listUserActivity(context, "user_1");
    const submittedEvent = userTrail.events.find(
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
    const statusChangedEvent = updatedTrail.events.find(
      (activityEvent) => activityEvent.eventType === "STATUS_CHANGED",
    );
    expect(statusChangedEvent?.actorRole).toBe("admin");
    expect(statusChangedEvent?.actorEmail).toBe("admin@example.com");
    expect(statusChangedEvent?.userId).toBe("user_1");
    expect(statusChangedEvent?.meta["fromStatus"]).toBe("SUBMITTED");
    expect(statusChangedEvent?.meta["toStatus"]).toBe("DOCS_VERIFIED");
  });
});
