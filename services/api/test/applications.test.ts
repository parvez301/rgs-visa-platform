import { describe, expect, it } from "vitest";
import {
  createDraft,
  listMyApplications,
  patchDraft,
  submitApplication,
} from "../src/domain/applications";
import { ApiError } from "../src/lib/errors";
import {
  buildTestContext,
  completeEssentials,
  completeTraveller,
  createSubmittableUaeDraft,
} from "./helpers";

describe("createDraft", () => {
  it("prices the draft from the country catalog and logs activity", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    expect(draft.status).toBe("DRAFT");
    expect(draft.amounts).toEqual({
      governmentFeeInr: 6500,
      serviceFeeInr: 1500,
      currency: "INR",
    });
    const dayEvents = await context.table.query("EVENT#2026-07-23");
    expect(dayEvents.map((eventItem) => eventItem["eventType"])).toContain(
      "APPLICATION_STARTED",
    );
  });

  it("rejects unknown countries", async () => {
    const context = buildTestContext();
    await expect(createDraft(context, "user_1", "XX")).rejects.toThrow(
      "No visa product configured for country XX",
    );
  });

  it("rejects info-only / inactive countries with a helpful message", async () => {
    const context = buildTestContext();
    await expect(createDraft(context, "user_1", "TH")).rejects.toThrow(
      /aren't available online yet/,
    );
  });
});

describe("patchDraft", () => {
  it("updates travellers and logs step completion once per step change", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    const patched = await patchDraft(context, "user_1", draft.applicationId, {
      travellers: [completeTraveller],
      stepReached: "docs",
    });
    expect(patched.travellers[0]!.fullName).toBe("Asha Verma");
    expect(patched.stepReached).toBe("docs");
  });

  it("refuses edits to another user's application", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    await expect(
      patchDraft(context, "user_2", draft.applicationId, { stepReached: "docs" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses edits after submission", async () => {
    const context = buildTestContext();
    const applicationId = await createSubmittableUaeDraft(context);
    await submitApplication(context, "user_1", applicationId, "asha@example.com");
    await expect(
      patchDraft(context, "user_1", applicationId, { stepReached: "docs" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("submitApplication", () => {
  it("submits a complete draft: status, activity, receipt email", async () => {
    const context = buildTestContext();
    const applicationId = await createSubmittableUaeDraft(context);
    const submitted = await submitApplication(
      context,
      "user_1",
      applicationId,
      "asha@example.com",
    );
    expect(submitted.status).toBe("SUBMITTED");
    expect(context.email.sentEmails).toHaveLength(1);
    expect(context.email.sentEmails[0]!.toAddress).toBe("asha@example.com");
    expect(context.email.sentEmails[0]!.subject).toContain("Application received");
  });

  it("blocks submission without essentials", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    await patchDraft(context, "user_1", draft.applicationId, {
      travellers: [completeTraveller],
    });
    await expect(
      submitApplication(context, "user_1", draft.applicationId, "asha@example.com"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("blocks submission with placeholder traveller details", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    await patchDraft(context, "user_1", draft.applicationId, {
      essentials: completeEssentials,
    });
    await expect(
      submitApplication(context, "user_1", draft.applicationId, "asha@example.com"),
    ).rejects.toThrow(/complete passport details/);
  });

  it("blocks submission listing each missing document", async () => {
    const context = buildTestContext();
    const draft = await createDraft(context, "user_1", "AE");
    await patchDraft(context, "user_1", draft.applicationId, {
      travellers: [completeTraveller],
      essentials: completeEssentials,
    });
    try {
      await submitApplication(context, "user_1", draft.applicationId, "asha@example.com");
      expect.unreachable("should have thrown");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.message).toContain("PASSPORT_BIO");
      expect(apiError.message).toContain("PHOTO");
    }
  });
});

describe("listMyApplications", () => {
  it("returns only the caller's applications", async () => {
    const context = buildTestContext();
    await createDraft(context, "user_1", "AE");
    context.advanceClock(1000);
    await createDraft(context, "user_1", "TZ");
    context.advanceClock(1000);
    await createDraft(context, "user_2", "ZM");
    const userOneApplications = await listMyApplications(context, "user_1");
    expect(userOneApplications).toHaveLength(2);
    expect(
      userOneApplications.every((application) => application.userId === "user_1"),
    ).toBe(true);
  });
});
