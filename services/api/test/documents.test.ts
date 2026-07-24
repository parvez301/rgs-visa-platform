import { describe, expect, it } from "vitest";
import { createDraft } from "../src/domain/applications";
import {
  presignDocumentUpload,
  presignOwnedDocumentDownload,
  recordDocumentUpload,
} from "../src/domain/documents";
import { buildTestContext } from "./helpers";

describe("presignDocumentUpload", () => {
  it("issues a scoped upload URL for a checklist document", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    const presignResult = await presignDocumentUpload(
      context,
      "user_1",
      draft.applicationId,
      "PASSPORT_BIO",
      0,
      "image/jpeg",
    );
    expect(presignResult.objectKey).toBe(
      `applications/${draft.applicationId}/traveller-0/PASSPORT_BIO.jpg`,
    );
    expect(context.documents.uploadCalls).toHaveLength(1);
  });

  it("rejects documents not on the country checklist", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    await expect(
      presignDocumentUpload(
        context,
        "user_1",
        draft.applicationId,
        "BANK_STATEMENT",
        0,
        "image/jpeg",
      ),
    ).rejects.toThrow(/not part of the AE document checklist/);
  });

  it("rejects out-of-range traveller index and bad content types", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    await expect(
      presignDocumentUpload(context, "user_1", draft.applicationId, "PHOTO", 5, "image/jpeg"),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      presignDocumentUpload(
        context,
        "user_1",
        draft.applicationId,
        "PHOTO",
        0,
        "application/zip",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses presigning for someone else's application", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    await expect(
      presignDocumentUpload(
        context,
        "intruder",
        draft.applicationId,
        "PHOTO",
        0,
        "image/jpeg",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("recordDocumentUpload", () => {
  it("stores a PENDING document and logs activity", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    const recordedDocument = await recordDocumentUpload(
      context,
      "user_1",
      draft.applicationId,
      "PHOTO",
      0,
      `applications/${draft.applicationId}/traveller-0/PHOTO.png`,
    );
    expect(recordedDocument.reviewStatus).toBe("PENDING");
  });

  it("rejects object keys outside the presigned location", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    await expect(
      recordDocumentUpload(
        context,
        "user_1",
        draft.applicationId,
        "PHOTO",
        0,
        "applications/some-other-app/traveller-0/PHOTO.png",
      ),
    ).rejects.toThrow(/does not match the presigned location/);
  });
});

describe("presignOwnedDocumentDownload", () => {
  it("returns a download URL for the owner and 404 for others", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE", "user_1@example.com");
    await recordDocumentUpload(
      context,
      "user_1",
      draft.applicationId,
      "PHOTO",
      0,
      `applications/${draft.applicationId}/traveller-0/PHOTO.png`,
    );
    const downloadUrl = await presignOwnedDocumentDownload(
      context,
      "user_1",
      draft.applicationId,
      "PHOTO",
      0,
    );
    expect(downloadUrl).toContain("download");
    await expect(
      presignOwnedDocumentDownload(context, "intruder", draft.applicationId, "PHOTO", 0),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
