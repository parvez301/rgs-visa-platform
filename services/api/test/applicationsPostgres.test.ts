import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addInternalNote,
  getApplicationById,
  listApplicationsByStatus,
  reviewDocument,
  setPaymentStatus,
  transitionApplication,
} from "../src/domain/admin";
import {
  createDraft,
  getOwnedApplication,
  listMyApplications,
  patchDraft,
  submitApplication,
} from "../src/domain/applications";
import {
  getApplicationPostgres,
  listApplicationsByStatusPostgres,
  upsertApplicationPostgres,
} from "../src/domain/applicationsPostgres";
import type { AppContext } from "../src/lib/context";
import { ApiError, CorruptRecordError } from "../src/lib/errors";
import type { SqlClient } from "../src/lib/sql";
import {
  buildTestContext,
  closeTestContexts,
  completeEssentials,
  completeTraveller,
  createSubmittableUaeDraft,
  type TestContext,
} from "./helpers";

const USER_EMAIL = "user_1@example.com";

describe("portal applications", () => {
  let sql: SqlClient;
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
  });

  afterEach(closeTestContexts);

  it("creates a draft in Postgres", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    expect(await getApplicationPostgres(sql, draft.applicationId)).toEqual(draft);
  });

  it("lists my applications from Postgres, newest first, scoped to the user", async () => {
    const first = await createDraft(context, "user_1", "AE", USER_EMAIL);
    context.advanceClock(1000);
    const second = await createDraft(context, "user_1", "AE", USER_EMAIL);
    await createDraft(context, "user_2", "AE", "user_2@example.com");
    const listing = await listMyApplications(context, "user_1");
    expect(listing.applications.map((a) => a.applicationId)).toEqual([
      second.applicationId,
      first.applicationId,
    ]);
    expect(listing.unreadableApplicationIds).toEqual([]);
  });

  it("patches a draft and round-trips travellers and essentials", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    context.advanceClock(5000);
    const patched = await patchDraft(
      context,
      "user_1",
      draft.applicationId,
      { travellers: [completeTraveller], essentials: completeEssentials, stepReached: "docs" },
      USER_EMAIL,
    );
    const reloaded = await getOwnedApplication(context, "user_1", draft.applicationId);
    expect(reloaded).toEqual(patched);
    expect(reloaded.travellers[0]!.fullName).toBe("Asha Verma");
    expect(reloaded.essentials).toEqual(completeEssentials);
    expect(reloaded.updatedAt > draft.updatedAt).toBe(true);
    expect(reloaded.createdAt).toBe(draft.createdAt);
  });

  it("answers 404 for another user's application", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    await expect(getOwnedApplication(context, "user_2", draft.applicationId)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    await expect(
      patchDraft(context, "user_2", draft.applicationId, { stepReached: "docs" }, "x@example.com"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("submits, changes status in Postgres, and the admin queue sees it", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    expect((await listApplicationsByStatus(context, "DRAFT")).applications).toHaveLength(1);
    expect((await listApplicationsByStatus(context, "SUBMITTED")).applications).toHaveLength(0);

    const submitted = await submitApplication(context, "user_1", applicationId, USER_EMAIL);
    expect(submitted.status).toBe("SUBMITTED");

    const queue = await listApplicationsByStatus(context, "SUBMITTED");
    expect(queue.applications.map((a) => a.applicationId)).toEqual([applicationId]);
    expect(queue.unreadableApplicationIds).toEqual([]);
    expect((await listApplicationsByStatus(context, "DRAFT")).applications).toHaveLength(0);
    expect((await getApplicationById(context, applicationId)).status).toBe("SUBMITTED");
    await expect(getApplicationById(context, "app_missing")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("admin status, payment and note mutations persist to Postgres", async () => {
    const applicationId = await createSubmittableUaeDraft(context);
    await submitApplication(context, "user_1", applicationId, USER_EMAIL);
    await setPaymentStatus(context, "admin_1", "a@example.com", applicationId, "REQUESTED", USER_EMAIL);
    await addInternalNote(context, "admin_1", applicationId, "called client");
    const reloaded = await getApplicationPostgres(sql, applicationId);
    expect(reloaded?.paymentStatus).toBe("REQUESTED");
    expect(reloaded?.internalNotes).toHaveLength(1);
    // Documents approved so the transition guard passes.
    for (const docType of ["PASSPORT_BIO", "PHOTO"] as const) {
      await reviewDocument(
        context, "admin_1", "a@example.com", applicationId, docType, 0, "APPROVED", USER_EMAIL,
      );
    }
    await transitionApplication(context, "admin_1", "a@example.com", applicationId, "DOCS_VERIFIED", USER_EMAIL);
    expect((await listApplicationsByStatus(context, "DOCS_VERIFIED")).applications).toHaveLength(1);
    expect((await listApplicationsByStatus(context, "SUBMITTED")).applications).toHaveLength(0);
  });

  it("admin list sorts newest updated_at first and honours the limit", async () => {
    const older = await createDraft(context, "user_1", "AE", USER_EMAIL);
    context.advanceClock(1000);
    const newer = await createDraft(context, "user_2", "AE", "user_2@example.com");
    const queue = await listApplicationsByStatus(context, "DRAFT");
    expect(queue.applications.map((a) => a.applicationId)).toEqual([
      newer.applicationId,
      older.applicationId,
    ]);
    const limited = await listApplicationsByStatus(context, "DRAFT", 1);
    expect(limited.applications.map((a) => a.applicationId)).toEqual([newer.applicationId]);
  });

  it("skips and names a corrupt row instead of failing the listing", async () => {
    const good = await createDraft(context, "user_1", "AE", USER_EMAIL);
    await sql.query(
      `insert into portal_applications (application_id, user_id, country_code, product_code,
         status, step_reached, travellers, amounts, payment_status, created_at, updated_at)
       values ('app_bad', 'user_1', 'AE', 'tourist', 'DRAFT', 'travellers', '[]'::jsonb,
         '{"governmentFeeInr":1,"serviceFeeInr":1,"currency":"INR"}'::jsonb, 'UNPAID', now(), now())`,
    );
    const mine = await listMyApplications(context, "user_1");
    expect(mine.applications.map((a) => a.applicationId)).toEqual([good.applicationId]);
    expect(mine.unreadableApplicationIds).toEqual(["app_bad"]);
    const queue = await listApplicationsByStatusPostgres(sql, "DRAFT");
    expect(queue.unreadableApplicationIds).toEqual(["app_bad"]);
    await expect(getApplicationPostgres(sql, "app_bad")).rejects.toBeInstanceOf(CorruptRecordError);
  });

  it("upsert replaces an existing row and keeps optional fields absent", async () => {
    const draft = await createDraft(context, "user_1", "AE", USER_EMAIL);
    await upsertApplicationPostgres(sql, { ...draft, visaResultKey: "results/a.pdf" });
    expect((await getApplicationPostgres(sql, draft.applicationId))?.visaResultKey).toBe(
      "results/a.pdf",
    );
    await upsertApplicationPostgres(sql, draft);
    const reloaded = await getApplicationPostgres(sql, draft.applicationId);
    expect(reloaded).toEqual(draft);
    expect("visaResultKey" in reloaded!).toBe(false);
    expect("essentials" in reloaded!).toBe(false);
  });
});
