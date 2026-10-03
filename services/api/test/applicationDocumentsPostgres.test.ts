import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  presignDocumentDownloadForAdmin,
  reviewDocument,
  transitionApplication,
} from "../src/domain/admin";
import {
  getApplicationDocumentPostgres,
  listApplicationDocumentsPostgres,
  upsertApplicationDocumentPostgres,
} from "../src/domain/applicationDocumentsPostgres";
import {
  createDraft,
  listApplicationDocuments,
  patchDraft,
  submitApplication,
} from "../src/domain/applications";
import { presignOwnedDocumentDownload, recordDocumentUpload } from "../src/domain/documents";
import type { AppContext } from "../src/lib/context";
import type { SqlClient } from "../src/lib/sql";
import {
  buildSqlTestContext,
  closeSqlTestContexts,
  completeEssentials,
  completeTraveller,
  createSubmittableUaeDraft,
  type SqlTestContext,
} from "./helpers";

const USER_EMAIL = "user_1@example.com";
const ADMIN_EMAIL = "admin@example.com";

describe("application documents", () => {
  let sql: SqlClient;
  let context: SqlTestContext;

  beforeEach(async () => {
    context = await buildSqlTestContext();
    sql = context.sql;
  });

  afterEach(closeSqlTestContexts);

  it("records an upload in Postgres, lists it", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    const recorded = await recordDocumentUpload(
      context,
      "user_1",
      draft.applicationId,
      "PASSPORT_BIO",
      0,
      `applications/${draft.applicationId}/traveller-0/PASSPORT_BIO.jpg`,
      USER_EMAIL,
    );
    expect(await listApplicationDocuments(context, draft.applicationId)).toEqual([recorded]);
    expect(await getApplicationDocumentPostgres(sql, draft.applicationId, "PASSPORT_BIO", 0)).toEqual(
      recorded,
    );
  });

  it("re-upload replaces the row and resets review state", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    const key = `applications/${draft.applicationId}/traveller-0/PHOTO.jpg`;
    await recordDocumentUpload(context, "user_1", draft.applicationId, "PHOTO", 0, key, USER_EMAIL);
    await reviewDocument(
      context, "admin_1", ADMIN_EMAIL, draft.applicationId, "PHOTO", 0, "REJECTED", USER_EMAIL, "blurry",
    );
    const rejected = await listApplicationDocuments(context, draft.applicationId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reviewStatus: "REJECTED", rejectReason: "blurry" });

    await recordDocumentUpload(context, "user_1", draft.applicationId, "PHOTO", 0, key, USER_EMAIL);
    const documents = await listApplicationDocuments(context, draft.applicationId);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.reviewStatus).toBe("PENDING");
    expect("rejectReason" in documents[0]!).toBe(false);
  });

  it("submit gate sees PG documents: missing blocks, uploaded passes", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    await patchDraft(
      context,
      "user_1",
      draft.applicationId,
      { travellers: [completeTraveller], essentials: completeEssentials, stepReached: "review" },
      USER_EMAIL,
    );
    await expect(
      submitApplication(context, "user_1", draft.applicationId, USER_EMAIL),
    ).rejects.toThrow(/Missing documents — traveller 1: PASSPORT_BIO, traveller 1: PHOTO/);

    await recordDocumentUpload(
      context, "user_1", draft.applicationId, "PASSPORT_BIO", 0,
      `applications/${draft.applicationId}/traveller-0/PASSPORT_BIO.jpg`, USER_EMAIL,
    );
    await expect(
      submitApplication(context, "user_1", draft.applicationId, USER_EMAIL),
    ).rejects.toThrow(/Missing documents — traveller 1: PHOTO$/);

    await recordDocumentUpload(
      context, "user_1", draft.applicationId, "PHOTO", 0,
      `applications/${draft.applicationId}/traveller-0/PHOTO.jpg`, USER_EMAIL,
    );
    const submitted = await submitApplication(context, "user_1", draft.applicationId, USER_EMAIL);
    expect(submitted.status).toBe("SUBMITTED");
  });

  it("admin review persists to Postgres and gates DOCS_VERIFIED", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    await submitApplication(context, "user_1", applicationId, USER_EMAIL);

    await expect(
      transitionApplication(context, "admin_1", ADMIN_EMAIL, applicationId, "DOCS_VERIFIED", USER_EMAIL),
    ).rejects.toMatchObject({ statusCode: 409 });

    const approved = await reviewDocument(
      context, "admin_1", ADMIN_EMAIL, applicationId, "PASSPORT_BIO", 0, "APPROVED", USER_EMAIL,
    );
    expect(approved.reviewStatus).toBe("APPROVED");
    expect(
      (await getApplicationDocumentPostgres(sql, applicationId, "PASSPORT_BIO", 0))?.reviewStatus,
    ).toBe("APPROVED");
    await expect(
      transitionApplication(context, "admin_1", ADMIN_EMAIL, applicationId, "DOCS_VERIFIED", USER_EMAIL),
    ).rejects.toMatchObject({ statusCode: 409 });

    await reviewDocument(
      context, "admin_1", ADMIN_EMAIL, applicationId, "PHOTO", 0, "APPROVED", USER_EMAIL,
    );
    const verified = await transitionApplication(
      context, "admin_1", ADMIN_EMAIL, applicationId, "DOCS_VERIFIED", USER_EMAIL,
    );
    expect(verified.status).toBe("DOCS_VERIFIED");
  });

  it("review requires a reason to reject and 404s on a missing document", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    await expect(
      reviewDocument(context, "admin_1", ADMIN_EMAIL, applicationId, "PHOTO", 0, "REJECTED", USER_EMAIL),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      reviewDocument(context, "admin_1", ADMIN_EMAIL, applicationId, "PHOTO", 1, "APPROVED", USER_EMAIL),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("presigns downloads from the Postgres s3 key (user and admin)", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    const key = `applications/${applicationId}/traveller-0/PHOTO.jpg`;
    const userUrl = await presignOwnedDocumentDownload(context, "user_1", applicationId, "PHOTO", 0);
    const adminUrl = await presignDocumentDownloadForAdmin(context, applicationId, "PHOTO", 0);
    expect(userUrl).toContain(key);
    expect(adminUrl).toContain(key);
    await expect(
      presignOwnedDocumentDownload(context, "user_1", applicationId, "PHOTO", 3),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lists in traveller/doc order scoped to one application", async () => {
    const first = await createSubmittableUaeDraft(context, "user_1");
    await createSubmittableUaeDraft(context, "user_2");
    const listing = await listApplicationDocumentsPostgres(sql, first);
    expect(listing.unreadableDocumentIds).toEqual([]);
    expect(listing.documents.map((d) => d.docType)).toEqual(["PASSPORT_BIO", "PHOTO"]);
    expect(listing.documents.every((d) => d.applicationId === first)).toBe(true);
  });

  it("skips and names a corrupt row; DOCS_VERIFIED refuses while one exists", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    await submitApplication(context, "user_1", applicationId, USER_EMAIL);
    for (const docType of ["PASSPORT_BIO", "PHOTO"] as const) {
      await reviewDocument(
        context, "admin_1", ADMIN_EMAIL, applicationId, docType, 0, "APPROVED", USER_EMAIL,
      );
    }
    await sql.query(
      `insert into portal_application_documents
         (application_id, traveller_index, doc_type, s3_key, review_status, uploaded_at)
       values ($1, 0, 'NOT_A_DOC', 'k', 'APPROVED', now())`,
      [applicationId],
    );
    const listing = await listApplicationDocumentsPostgres(sql, applicationId);
    expect(listing.documents).toHaveLength(2);
    expect(listing.unreadableDocumentIds).toHaveLength(1);
    await expect(
      transitionApplication(context, "admin_1", ADMIN_EMAIL, applicationId, "DOCS_VERIFIED", USER_EMAIL),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("upsert keeps optional rejectReason absent when unset", async () => {
    const document = {
      applicationId: "app_x",
      docType: "PHOTO" as const,
      travellerIndex: 0,
      s3Key: "applications/app_x/traveller-0/PHOTO.png",
      reviewStatus: "PENDING" as const,
      uploadedAt: "2026-10-02T10:00:00.000Z",
    };
    await upsertApplicationDocumentPostgres(sql, document);
    expect(await getApplicationDocumentPostgres(sql, "app_x", "PHOTO", 0)).toEqual(document);
  });
});
