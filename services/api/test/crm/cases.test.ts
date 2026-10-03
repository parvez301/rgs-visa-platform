import { crm } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";
import { readCaseOrThrow, writeCase } from "../../src/domain/crm/caseStore";
import type { SqlClient } from "../../src/lib/sql";
import { addApplicant, removeApplicant, updateApplicantDetails } from "../../src/domain/crm/applicantEdits";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { readRefClaim } from "../../src/domain/crm/refClaims";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import {
  changeApplicantCustody,
  changeApplicantOutcome,
  changeBillingStatus,
  changeCaseStatus,
  countCasesByField,
  createCase,
  getCase,
  updateCaseDetails,
  listCaseRefsByStatus,
  listCasesByPartner,
  listCasesByStatus,
} from "../../src/domain/crm/cases";

afterEach(closeSqlTestContexts);

async function seedPartner(context: SqlTestContext): Promise<string> {
  const partner = await createPartner(
    context,
    "rgs",
    { canonicalName: "Ozzy Travels" },
    "ops@rgs.test",
  );
  return partner.partnerId;
}

/** Cases point at travellers on file, so every case fixture needs one first. */
async function seedTraveller(context: SqlTestContext, fullName: string): Promise<string> {
  const traveller = await upsertTraveller(context, "rgs", { fullName });
  return traveller.travellerId;
}

async function seedCase(context: SqlTestContext, partnerId: string, caseRef = "31377") {
  const travellerId = await seedTraveller(context, `Traveller ${caseRef}`);
  return createCase(
    context,
    "rgs",
    {
      caseRef,
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      entryType: "SINGLE",
      processing: "NORMAL",
      receivedDate: "2026-01-02",
      applicants: [{ applicantRef: caseRef, travellerId }],
    },
    "ops@rgs.test",
  );
}

async function seedTwoApplicantCase(context: SqlTestContext, partnerId: string, caseRef = "31377") {
  const firstTravellerId = await seedTraveller(context, `Traveller ${caseRef}-1`);
  const secondTravellerId = await seedTraveller(context, `Traveller ${caseRef}-2`);
  return createCase(
    context,
    "rgs",
    {
      caseRef,
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      entryType: "SINGLE",
      processing: "NORMAL",
      receivedDate: "2026-01-02",
      applicants: [
        { applicantRef: `${caseRef}-1`, travellerId: firstTravellerId },
        { applicantRef: `${caseRef}-2`, travellerId: secondTravellerId },
      ],
    },
    "ops@rgs.test",
  );
}

async function seedThreeApplicantCase(
  context: SqlTestContext,
  partnerId: string,
  caseRef = "31377",
) {
  const applicantInputs = [];
  for (const applicantSuffix of [1, 2, 3]) {
    applicantInputs.push({
      applicantRef: `${caseRef}-${applicantSuffix}`,
      travellerId: await seedTraveller(context, `Traveller ${caseRef}-${applicantSuffix}`),
    });
  }
  return createCase(
    context,
    "rgs",
    {
      caseRef,
      caseType: "VISA",
      partnerId,
      destinationCountry: "BH",
      visaType: "EVISA_TOURIST",
      entryType: "SINGLE",
      processing: "NORMAL",
      receivedDate: "2026-01-02",
      applicants: applicantInputs,
    },
    "ops@rgs.test",
  );
}

describe("crm cases", () => {
  it("creates a case on all three axes at their starting values", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    expect(created.caseStatus).toBe("NEW");
    expect(created.billingStatus).toBe("UNBILLED");
    expect(created.applicants[0]!.custody).toBe("NOT_HELD");
    expect(created.applicants[0]!.outcome).toBe("PENDING");
    expect(created.totalInr).toBe(0);
  });

  it("stores an optional collection date and remarks, and still opens New and Unbilled", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const travellerId = await seedTraveller(context, "Asha Rao");
    const created = await createCase(
      context,
      "rgs",
      {
        caseRef: "RGS-1",
        caseType: "VISA",
        partnerId,
        destinationCountry: "AE",
        visaType: "TOURIST",
        entryType: "MULTIPLE",
        receivedDate: "2026-09-16",
        expectedCollectionDate: "2026-09-20",
        remarks: "Passport copy is faint",
        applicants: [{ applicantRef: "A1", travellerId }],
      },
      "ops@rgs.test",
    );
    expect(created.caseStatus).toBe("NEW");
    expect(created.billingStatus).toBe("UNBILLED");
    expect(created.entryType).toBe("MULTIPLE");
    expect(created.expectedCollectionDate).toBe("2026-09-20");
    expect(created.remarks).toBe("Passport copy is faint");
  });

  it("records a creation event", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const events = await listCaseEvents(context, "rgs", created.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[0]!.actorEmail).toBe("ops@rgs.test");
  });

  it("rejects a case whose partner does not exist", async () => {
    const context = await buildSqlTestContext();
    await expect(seedCase(context, "no_such_partner")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("creates a case for an admin whose token carries no email claim", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const travellerId = await seedTraveller(context, "Umesh Kumar Yadav");
    // router.ts defaults a missing `email` claim to "". Every other admin route
    // keeps working with that; case creation must too.
    const created = await createCase(
      context,
      "rgs",
      {
        caseRef: "31377",
        caseType: "VISA",
        partnerId,
        destinationCountry: "BH",
        visaType: "EVISA_TOURIST",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: "31377", travellerId }],
      },
      "",
    );
    expect(created.caseRef).toBe("31377");
    // No email to record, so the field is absent rather than stored empty.
    expect(created.createdByEmail).toBeUndefined();
  });

  it("records the caller's email on the case when the claim is present", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    expect(created.createdByEmail).toBe("ops@rgs.test");
  });

  it("rejects a case whose traveller does not exist", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await expect(
      createCase(
        context,
        "rgs",
        {
          caseRef: "31377",
          caseType: "VISA",
          partnerId,
          destinationCountry: "BH",
          visaType: "EVISA_TOURIST",
          receivedDate: "2026-01-02",
          applicants: [{ applicantRef: "31377", travellerId: "trv_totally_made_up" }],
        },
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a case when only the second applicant's traveller is unknown", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const knownTravellerId = await seedTraveller(context, "Umesh Kumar Yadav");
    await expect(
      createCase(
        context,
        "rgs",
        {
          caseRef: "31377",
          caseType: "VISA",
          partnerId,
          destinationCountry: "BH",
          visaType: "EVISA_TOURIST",
          receivedDate: "2026-01-02",
          applicants: [
            { applicantRef: "31377-1", travellerId: knownTravellerId },
            { applicantRef: "31377-2", travellerId: "trv_totally_made_up" },
          ],
        },
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a collection date earlier than the received date", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const travellerId = await seedTraveller(context, "Asha Rao");
    await expect(
      createCase(
        context,
        "rgs",
        {
          caseRef: "31998",
          caseType: "VISA",
          visaType: "TOURIST",
          partnerId,
          destinationCountry: "BH",
          receivedDate: "2026-01-10",
          expectedCollectionDate: "2026-01-09",
          applicants: [{ applicantRef: "31998", travellerId }],
        },
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Collection date cannot be before the received date",
    });
  });

  it("rejects a VISA case with no visa type", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    // A real traveller, so the 400 below is the missing visaType and nothing else.
    const travellerId = await seedTraveller(context, "Umesh Kumar Yadav");
    await expect(
      createCase(
        context,
        "rgs",
        {
          caseRef: "31999",
          caseType: "VISA",
          partnerId,
          destinationCountry: "BH",
          receivedDate: "2026-01-02",
          applicants: [{ applicantRef: "31999", travellerId }],
        },
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows a non-visa case with no visa type", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const travellerId = await seedTraveller(context, "Aman Kapoor");
    const attestation = await createCase(
      context,
      "rgs",
      {
        caseRef: "31888",
        caseType: "ATTESTATION",
        partnerId,
        destinationCountry: "AE",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: "31888", travellerId }],
      },
      "ops@rgs.test",
    );
    expect(attestation.caseType).toBe("ATTESTATION");
    expect(attestation.visaType).toBeUndefined();
  });

  it("moves the case status through a legal transition and logs it", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const moved = await changeCaseStatus(context, "rgs", created.caseId, "DOCS_UNDER_REVIEW", "ops@rgs.test");
    expect(moved.caseStatus).toBe("DOCS_UNDER_REVIEW");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusEvent!.meta["fromStatus"]).toBe("NEW");
    expect(statusEvent!.meta["toStatus"]).toBe("DOCS_UNDER_REVIEW");
  });

  it("refuses an illegal case-status transition with a 409", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await changeCaseStatus(context, "rgs", created.caseId, "WITHDRAWN", "ops@rgs.test");
    // WITHDRAWN is terminal — nothing may leave it.
    await expect(
      changeCaseStatus(context, "rgs", created.caseId, "DOCS_UNDER_REVIEW", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("moves custody on a single applicant without touching the case status", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    const updated = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "WITH_RGS",
      "ops@rgs.test",
    );
    expect(updated.applicants[0]!.custody).toBe("WITH_RGS");
    expect(updated.applicants[0]!.custodySince).toBe("2026-07-23T10:00:00.000Z");
    expect(updated.caseStatus).toBe("NEW");
  });

  it("refuses an illegal custody transition with a 409", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    // NOT_HELD may only go to WITH_RGS.
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "AT_EMBASSY", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a custody change for an applicant ref that does not exist", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await expect(
      changeApplicantCustody(
        context,
        "rgs",
        created.caseId,
        "no-such-applicant-ref",
        "WITH_RGS",
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("moves billing independently of the other two axes", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const billed = await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    expect(billed.billingStatus).toBe("BILL_SENT");
    expect(billed.caseStatus).toBe("NEW");
    expect(billed.applicants[0]!.custody).toBe("NOT_HELD");
  });

  it("lists cases by status, and the index follows the case when it moves", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const created = await seedCase(context, partnerId);
    expect((await listCasesByStatus(context, "rgs", "NEW")).cases).toHaveLength(1);

    await changeCaseStatus(context, "rgs", created.caseId, "DOCS_UNDER_REVIEW", "ops@rgs.test");
    // The GSI1 entry must move with the status, or the queue shows stale rows.
    expect((await listCasesByStatus(context, "rgs", "NEW")).cases).toHaveLength(0);
    expect((await listCasesByStatus(context, "rgs", "DOCS_UNDER_REVIEW")).cases).toHaveLength(1);
  });

  it("lists cases by partner", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    expect((await listCasesByPartner(context, "rgs", partnerId)).cases).toHaveLength(2);
  });

  it("keeps listing the healthy cases when one partition lost its applicants", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const healthyCase = await seedCase(context, partnerId, "31377");
    const corruptedCase = await seedCase(context, partnerId, "31378");
    // Half-written partition: META survived, the applicant items did not.
    await writeCase(context, { ...corruptedCase, applicants: [] });

    const { cases: listedCases } = await listCasesByStatus(context, "rgs", "NEW");
    expect(listedCases.map((listedCase) => listedCase.caseId)).toEqual([healthyCase.caseId]);
    expect(listedCases[0]!.caseRef).toBe("31377");
    expect(listedCases[0]!.applicants).toHaveLength(1);
  });

  it("reports the cases it had to skip in the result, not only in a log line", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const healthyCase = await seedCase(context, partnerId, "31377");
    const corruptedCase = await seedCase(context, partnerId, "31378");
    await writeCase(context, { ...corruptedCase, applicants: [] });

    // A console.warn nobody reads is not reporting: without the skipped ids in
    // the payload, a case disappearing from the queue looks like a case that
    // was never there.
    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.cases.map((listedCase) => listedCase.caseId)).toEqual([healthyCase.caseId]);
    expect(listed.unreadableCaseIds).toEqual([corruptedCase.caseId]);
  });

  it("reports nothing skipped when every case in the queue is healthy", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.unreadableCaseIds).toEqual([]);
  });

  it("reports the cases it had to skip on the by-partner listing too", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const corruptedCase = await seedCase(context, partnerId, "31378");
    await writeCase(context, { ...corruptedCase, applicants: [] });

    const listed = await listCasesByPartner(context, "rgs", partnerId);
    expect(listed.cases).toHaveLength(1);
    expect(listed.unreadableCaseIds).toEqual([corruptedCase.caseId]);
  });

  it("warns with the caseId of a case it had to skip", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const corruptedCase = await seedCase(context, partnerId, "31378");
    await writeCase(context, { ...corruptedCase, applicants: [] });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warnedText = "";
    try {
      await listCasesByStatus(context, "rgs", "NEW");
      // Read the calls before restoring: mockRestore also clears them.
      warnedText = warnSpy.mock.calls.map((warnArguments) => warnArguments.join(" ")).join("\n");
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnedText).toContain(corruptedCase.caseId);
  });

  it("still surfaces a corrupt case as a typed error on the single-case read", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const corruptedCase = await seedCase(context, partnerId, "31378");
    await writeCase(context, { ...corruptedCase, applicants: [] });

    await expect(getCase(context, "rgs", corruptedCase.caseId)).rejects.toMatchObject({
      statusCode: 409,
      code: "CORRUPT_RECORD",
    });
  });

  // The embassy returns one file of three for a corrected photo. Recording
  // SENT_BACK must not read as a decision: a DECIDED case can only go on to
  // CLOSED, so the file would become impossible to resubmit and would vanish
  // from the queue ops is actively working it from.
  it("keeps the case workable when the embassy sends one of three files back", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const created = await seedThreeApplicantCase(context, partnerId);
    await changeCaseStatus(context, "rgs", created.caseId, "SUBMITTED", "ops@rgs.test");
    for (const decidedApplicantRef of ["31377-1", "31377-2"]) {
      await changeApplicantOutcome(
        context,
        "rgs",
        created.caseId,
        decidedApplicantRef,
        "APPROVED",
        "ops@rgs.test",
      );
    }

    const afterTheReturn = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      "31377-3",
      "SENT_BACK",
      "ops@rgs.test",
    );
    expect(afterTheReturn.caseStatus).toBe("SUBMITTED");
    const submittedQueue = await listCasesByStatus(context, "rgs", "SUBMITTED");
    expect(submittedQueue.cases.map((queuedCase) => queuedCase.caseId)).toContain(created.caseId);

    // The corrected photo goes back to the embassy: the returned applicant
    // rejoins the queue as PENDING.
    const afterTheResubmission = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      "31377-3",
      "PENDING",
      "ops@rgs.test",
    );
    expect(afterTheResubmission.applicants[2]!.outcome).toBe("PENDING");
    expect(afterTheResubmission.caseStatus).toBe("SUBMITTED");

    // The case decides only once the resubmitted file is actually decided.
    const afterTheDecision = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      "31377-3",
      "APPROVED",
      "ops@rgs.test",
    );
    expect(afterTheDecision.caseStatus).toBe("DECIDED");
  });

  it("keeps one tenant's cases out of another's queries", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId);
    expect((await listCasesByStatus(context, "other-tenant", "NEW")).cases).toEqual([]);
  });

  it("throws a 404 reading a case that does not exist", async () => {
    const context = await buildSqlTestContext();
    await expect(getCase(context, "rgs", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("changes an applicant's outcome and logs the from/to values", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;

    const updated = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "APPROVED",
      "ops@rgs.test",
    );
    expect(updated.applicants[0]!.outcome).toBe("APPROVED");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const outcomeEvent = events.find((event) => event.eventType === "APPLICANT_OUTCOME_CHANGED");
    expect(outcomeEvent!.meta["applicantRef"]).toBe(applicantRef);
    expect(outcomeEvent!.meta["fromOutcome"]).toBe("PENDING");
    expect(outcomeEvent!.meta["toOutcome"]).toBe("APPROVED");
  });

  it("rejects an unknown applicant outcome with a 400", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    await expect(
      changeApplicantOutcome(
        context,
        "rgs",
        created.caseId,
        applicantRef,
        "CANCELLED" as unknown as crm.ApplicantOutcome,
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an outcome change for an applicant ref that does not exist", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await expect(
      changeApplicantOutcome(
        context,
        "rgs",
        created.caseId,
        "no-such-applicant-ref",
        "APPROVED",
        "ops@rgs.test",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to rewrite a decided outcome, an edge the spec never granted", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    await changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "APPROVED", "ops@rgs.test");

    // Spec §5 line 221 grants PENDING -> APPROVED | REJECTED | SENT_BACK only.
    // Correcting a mistyped decision is a spec change, not a table edit.
    await expect(
      changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "REJECTED", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });

    const reloaded = await getCase(context, "rgs", created.caseId);
    expect(reloaded.applicants[0]!.outcome).toBe("APPROVED");
    const events = await listCaseEvents(context, "rgs", created.caseId);
    expect(
      events.filter((event) => event.eventType === "APPLICANT_OUTCOME_CHANGED"),
    ).toHaveLength(1);
  });

  it("logs the from/to values when a returned file is resubmitted", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    await changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "SENT_BACK", "ops@rgs.test");

    // A later timestamp, so the two events sort deterministically in the log.
    context.advanceClock(60_000);
    const resubmitted = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "PENDING",
      "ops@rgs.test",
    );
    expect(resubmitted.applicants[0]!.outcome).toBe("PENDING");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const outcomeEvents = events.filter((event) => event.eventType === "APPLICANT_OUTCOME_CHANGED");
    expect(outcomeEvents).toHaveLength(2);
    expect(outcomeEvents[1]!.meta["fromOutcome"]).toBe("SENT_BACK");
    expect(outcomeEvents[1]!.meta["toOutcome"]).toBe("PENDING");
  });

  it("refuses to un-decide an applicant with a 409, leaving the recorded outcome intact", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    const decided = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "APPROVED",
      "ops@rgs.test",
    );
    expect(decided.caseStatus).toBe("VISA_GRANTED");

    await expect(
      changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "PENDING", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });

    // A DECIDED case must never hold a PENDING applicant: the derivation
    // short-circuits once DECIDED, so nothing else would put this right.
    const reloaded = await getCase(context, "rgs", created.caseId);
    expect(reloaded.applicants[0]!.outcome).toBe("APPROVED");
    expect(reloaded.caseStatus).toBe("VISA_GRANTED");
  });

  it("derives VISA_REFUSED for a single rejected applicant and logs the transition", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    const refused = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "REJECTED",
      "ops@rgs.test",
    );
    expect(refused.caseStatus).toBe("VISA_REFUSED");
    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusEvent!.meta["toStatus"]).toBe("VISA_REFUSED");
  });

  it("moves a desk-marked DECIDED individual case on to VISA_GRANTED when the applicant is approved", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await changeCaseStatus(context, "rgs", created.caseId, "DECIDED", "ops@rgs.test");
    const granted = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      created.applicants[0]!.applicantRef,
      "APPROVED",
      "ops@rgs.test",
    );
    expect(granted.caseStatus).toBe("VISA_GRANTED");
  });

  it("widens an individual VISA_GRANTED case to DECIDED once a second applicant is added and approved", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const granted = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      created.applicants[0]!.applicantRef,
      "APPROVED",
      "ops@rgs.test",
    );
    expect(granted.caseStatus).toBe("VISA_GRANTED");

    const secondTravellerId = await seedTraveller(context, "Second Traveller");
    const grown = await addApplicant(
      context,
      "rgs",
      created.caseId,
      { travellerId: secondTravellerId },
      "ops@rgs.test",
    );
    expect(grown.applicants).toHaveLength(2);
    const secondApplicantRef = grown.applicants[1]!.applicantRef;

    const decided = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      secondApplicantRef,
      "APPROVED",
      "ops@rgs.test",
    );

    expect(decided.caseStatus).toBe("DECIDED");
    expect((await getCase(context, "rgs", created.caseId)).caseStatus).toBe("DECIDED");
    const events = await listCaseEvents(context, "rgs", created.caseId);
    const wideningEvent = events.find(
      (event) => event.eventType === "CASE_STATUS_CHANGED" && event.meta["toStatus"] === "DECIDED",
    );
    expect(wideningEvent?.meta["fromStatus"]).toBe("VISA_GRANTED");
  });

  it("refuses a no-op outcome change with a 409", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    // PENDING -> PENDING, the same no-op the custody and billing gates refuse.
    await expect(
      changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "PENDING", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
    const events = await listCaseEvents(context, "rgs", created.caseId);
    expect(events.filter((event) => event.eventType === "APPLICANT_OUTCOME_CHANGED")).toHaveLength(0);
  });

  it("does not become DECIDED until every applicant is decided, then does", async () => {
    const context = await buildSqlTestContext();
    const created = await seedTwoApplicantCase(context, await seedPartner(context));
    const [firstApplicant, secondApplicant] = created.applicants;

    const afterFirstDecision = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      firstApplicant!.applicantRef,
      "APPROVED",
      "ops@rgs.test",
    );
    expect(afterFirstDecision.caseStatus).toBe("NEW");

    const afterSecondDecision = await changeApplicantOutcome(
      context,
      "rgs",
      created.caseId,
      secondApplicant!.applicantRef,
      "REJECTED",
      "ops@rgs.test",
    );
    expect(afterSecondDecision.caseStatus).toBe("DECIDED");
  });

  it("becomes CLOSED once every applicant is returned and billing is paid", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;

    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "WITH_RGS", "ops@rgs.test");
    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "RETURNED", "ops@rgs.test");
    await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    const paidCase = await changeBillingStatus(context, "rgs", created.caseId, "PAID", "ops@rgs.test");

    expect(paidCase.caseStatus).toBe("CLOSED");

    // Selected by eventType, not by the meta field under test, so the
    // assertions below can actually fail.
    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusChangedEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusChangedEvent!.meta["fromStatus"]).toBe("NEW");
    expect(statusChangedEvent!.meta["toStatus"]).toBe("CLOSED");
  });

  it("closes via the custody path when billing already reached PAID first", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;

    // Billing settles before the passport comes back — the reverse order from
    // the test above — so only the CLOSED check inside changeApplicantCustody
    // (not changeBillingStatus) can be what closes the case.
    await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    await changeBillingStatus(context, "rgs", created.caseId, "PAID", "ops@rgs.test");

    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "WITH_RGS", "ops@rgs.test");
    const returnedLast = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "RETURNED",
      "ops@rgs.test",
    );

    expect(returnedLast.caseStatus).toBe("CLOSED");

    // Selected by eventType, not by the meta field under test, so the
    // assertions below can actually fail.
    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusChangedEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusChangedEvent!.meta["fromStatus"]).toBe("NEW");
    expect(statusChangedEvent!.meta["toStatus"]).toBe("CLOSED");
  });

  it("does not close a case while billing is still unpaid", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;

    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "WITH_RGS", "ops@rgs.test");
    const returnedButUnpaid = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "RETURNED",
      "ops@rgs.test",
    );

    expect(returnedButUnpaid.billingStatus).toBe("UNBILLED");
    expect(returnedButUnpaid.caseStatus).not.toBe("CLOSED");
  });

  it("does not close a case when billing is UNKNOWN, even with every passport returned", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;

    // Simulate a migrated case whose billing was never re-classified — the
    // importer writes this status directly through caseStore, never through
    // changeBillingStatus (UNKNOWN is reserved for the migration).
    await writeCase(context, { ...created, billingStatus: "UNKNOWN" });

    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "WITH_RGS", "ops@rgs.test");
    const returnedWithUnknownBilling = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      applicantRef,
      "RETURNED",
      "ops@rgs.test",
    );

    expect(returnedWithUnknownBilling.billingStatus).toBe("UNKNOWN");
    expect(returnedWithUnknownBilling.caseStatus).not.toBe("CLOSED");
  });

  it("does not drag a terminal case back into CLOSED by a later derivation", async () => {
    const context = await buildSqlTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    await changeCaseStatus(context, "rgs", created.caseId, "WITHDRAWN", "ops@rgs.test");

    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "WITH_RGS", "ops@rgs.test");
    await changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "RETURNED", "ops@rgs.test");
    await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    const finalCase = await changeBillingStatus(context, "rgs", created.caseId, "PAID", "ops@rgs.test");

    expect(finalCase.caseStatus).toBe("WITHDRAWN");
  });
});

describe("listCaseRefsByStatus", () => {
  it("reads every stored ref off the case rows, without reassembling a case", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");

    const listed = await listCaseRefsByStatus(context, "rgs", "NEW", 1000);
    expect(listed.storedCaseRefs.map((stored) => stored.caseRef).sort()).toEqual(["31377", "31378"]);
    expect(listed.unreadableCaseIds).toEqual([]);
  });

  it("still reports the ref of a case that will not reassemble", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    const corruptedCase = await seedCase(context, partnerId, "31378");
    // META with no applicant items — what a non-transactional writeCase leaves
    // when it times out between its two puts. `listCasesByStatus` drops this
    // case entirely, which is how its ref came to look never-imported.
    await writeCase(context, { ...corruptedCase, applicants: [] });

    expect((await listCasesByStatus(context, "rgs", "NEW")).cases).toHaveLength(0);
    const listed = await listCaseRefsByStatus(context, "rgs", "NEW", 1000);
    expect(listed.storedCaseRefs).toEqual([{ caseRef: "31378", caseId: corruptedCase.caseId }]);
  });

});

describe("countCasesByField", () => {
  it("counts cases by caseStatus without reassembling any of them", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    const thirdCase = await seedCase(context, partnerId, "31379");
    await changeCaseStatus(context, "rgs", thirdCase.caseId, "DOCS_UNDER_REVIEW", "ops@rgs.test");

    const counted = await countCasesByField(context, "rgs", "caseStatus");
    expect(counted.counts).toEqual({ NEW: 2, DOCS_UNDER_REVIEW: 1 });
    expect(counted.total).toBe(3);
    expect(counted.uncountedCaseIds).toEqual([]);
  });

  it("counts by destinationCountry, billingStatus and partnerId too", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377"); // seedCase's destinationCountry is BH

    expect((await countCasesByField(context, "rgs", "destinationCountry")).counts).toEqual({ BH: 1 });
    expect((await countCasesByField(context, "rgs", "billingStatus")).counts).toEqual({ UNBILLED: 1 });
    expect((await countCasesByField(context, "rgs", "partnerId")).counts).toEqual({ [partnerId]: 1 });
  });

  it("names a case whose counted field is empty, instead of dropping it or counting it as 'undefined'", async () => {
    const context = await buildSqlTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const blank = await seedCase(context, partnerId, "31378");
    await context.sql.query("update crm_cases set destination_country = '' where case_id = $1", [
      blank.caseId,
    ]);

    const counted = await countCasesByField(context, "rgs", "destinationCountry");
    expect(counted).toEqual({ counts: { BH: 1 }, total: 1, uncountedCaseIds: [blank.caseId] });
  });
});

describe("createCase family group fields", () => {
  it("stores groupName, clientEmail and each applicant's refNo", async () => {
    const context = await buildSqlTestContext();
    const partner = await createPartner(context, "rgs", { canonicalName: "Skyline Travels" }, "ops@rgs.test");
    const first = await upsertTraveller(context, "rgs", { fullName: "Rahul Sharma" });
    const second = await upsertTraveller(context, "rgs", { fullName: "Priya Sharma" });

    const created = await createCase(
      context,
      "rgs",
      {
        caseRef: "RGS-2026-0912",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "FR",
        receivedDate: "2026-09-20",
        groupName: "Sharma Family",
        clientEmail: "priya@example.com",
        applicants: [
          { applicantRef: "A1", travellerId: first.travellerId, refNo: "RGS-2026-0912" },
          { applicantRef: "A2", travellerId: second.travellerId, refNo: "RGS-2026-0913" },
        ],
      },
      "ops@rgs.test",
    );

    expect(created.groupName).toBe("Sharma Family");
    expect(created.clientEmail).toBe("priya@example.com");
    expect(created.applicants.map((applicant) => applicant.refNo)).toEqual(["RGS-2026-0912", "RGS-2026-0913"]);

    const reloaded = await getCase(context, "rgs", created.caseId);
    expect(reloaded).toEqual(created);
  });
});

describe("createCase reference uniqueness", () => {
  async function seedPartnerAndTraveller(context: SqlTestContext) {
    const partner = await createPartner(context, "rgs", { canonicalName: "Unique Travels", partnerType: "AGENCY" }, "desk@rgs.local");
    const traveller = await upsertTraveller(context, "rgs", { fullName: "RAVI KUMAR" });
    return { partnerId: partner.partnerId, travellerId: traveller.travellerId };
  }

  function caseInput(ids: { partnerId: string; travellerId: string }, caseRef: string, refNo?: string) {
    return {
      caseRef,
      caseType: "VISA" as const,
      visaType: "TOURIST" as const,
      partnerId: ids.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: ids.travellerId, ...(refNo === undefined ? {} : { refNo }) }],
    };
  }

  it("refuses a second case with the same REF, ignoring case and spaces", async () => {
    const context = await buildSqlTestContext();
    const ids = await seedPartnerAndTraveller(context);
    await createCase(context, "rgs", caseInput(ids, "rgs-100"), "desk@rgs.local");

    await expect(createCase(context, "rgs", caseInput(ids, " RGS-100"), "desk@rgs.local")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses a REF NO that is another case's REF", async () => {
    const context = await buildSqlTestContext();
    const ids = await seedPartnerAndTraveller(context);
    await createCase(context, "rgs", caseInput(ids, "50001"), "desk@rgs.local");

    await expect(createCase(context, "rgs", caseInput(ids, "50002", "50001"), "desk@rgs.local")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("lets exactly one of two racing creates win the same REF", async () => {
    const context = await buildSqlTestContext();
    const ids = await seedPartnerAndTraveller(context);
    const outcomes = await Promise.allSettled([
      createCase(context, "rgs", caseInput(ids, "RACE-1"), "desk@rgs.local"),
      createCase(context, "rgs", caseInput(ids, "RACE-1"), "desk@rgs.local"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("releases its claims when the case write fails, so the REF is not burned", async () => {
    const context = await buildSqlTestContext();
    const ids = await seedPartnerAndTraveller(context);
    // Fail only the case write (one transaction). The REF claims are separate
    // inserts, so they still land -- exactly the state the rollback must undo.
    const failingContext: SqlTestContext = {
      ...context,
      sql: {
        ...context.sql,
        transaction: async () => {
          throw new Error("database down");
        },
      },
    };

    await expect(
      createCase(failingContext, "rgs", caseInput(ids, "BURN-1", "BURN-1-P"), "desk@rgs.local"),
    ).rejects.toThrow("database down");
    expect(await readRefClaim(context, "rgs", "BURN-1")).toBeUndefined();
    expect(await readRefClaim(context, "rgs", "BURN-1-P")).toBeUndefined();
  });
});

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

describe("CRM case mutators on Postgres", () => {
  let sql: SqlClient;
  let context: SqlTestContext;

  beforeEach(async () => {
    context = await buildSqlTestContext();
    sql = context.sql;
  });

  async function seedPartnerId(): Promise<string> {
    const partner = await createPartner(context, TENANT_ID, { canonicalName: "Ozzy Travels" }, ACTOR);
    return partner.partnerId;
  }

  async function seedTravellerId(fullName: string): Promise<string> {
    return (await upsertTraveller(context, TENANT_ID, { fullName })).travellerId;
  }

  async function seedCase(
    partnerId: string,
    caseRef: string,
    applicantRefs: readonly string[] = [caseRef],
    overrides: { groupName?: string } = {},
  ): Promise<crm.CrmCase> {
    const applicants = [];
    for (const applicantRef of applicantRefs) {
      applicants.push({ applicantRef, travellerId: await seedTravellerId(`Traveller ${applicantRef}`) });
    }
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef,
        caseType: "VISA",
        partnerId,
        destinationCountry: "BH",
        visaType: "EVISA_TOURIST",
        entryType: "SINGLE",
        processing: "NORMAL",
        receivedDate: "2026-01-02",
        applicants,
        ...overrides,
      },
      ACTOR,
    );
    // Events sort by createdAt then eventId (random), so give CASE_CREATED a
    // tick of its own and every later event a later one.
    context.advanceClock(1_000);
    return created;
  }

  async function scalar<T>(text: string, values: unknown[] = []): Promise<T> {
    const result = await sql.query<{ value: T }>(text, values);
    return result.rows[0]!.value;
  }

  it("createCase writes case, applicants and event to Postgres", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377", ["31377-1", "31377-2"]);

    expect(created.caseStatus).toBe("NEW");
    expect(created.applicants.map((applicant) => applicant.applicantRef)).toEqual(["31377-1", "31377-2"]);

    expect(await scalar<number>("select count(*)::int as value from crm_cases")).toBe(1);
    expect(await scalar<number>("select count(*)::int as value from crm_applicants")).toBe(2);

    const reread = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(reread).toEqual(created);

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED"]);
    expect(await scalar<number>("select count(*)::int as value from crm_events")).toBe(1);

    // The REF claim is held in crm_ref_claims.
    expect(await readRefClaim(context, TENANT_ID, "31377")).toBeDefined();
  });

  it("createCase stamps the Ledger search haystack from crm_travellers into the Postgres row", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "40001");
    const searchText = await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [
      created.caseId,
    ]);
    expect(searchText).toContain("traveller 40001");
  });

  it("createCase for an unknown partner fails before anything is written to Postgres", async () => {
    const travellerId = await seedTravellerId("Nobody");
    await expect(
      createCase(
        context,
        TENANT_ID,
        {
          caseRef: "50001",
          caseType: "VISA",
          partnerId: "partner_missing",
          destinationCountry: "BH",
          visaType: "EVISA_TOURIST",
          receivedDate: "2026-01-02",
          applicants: [{ applicantRef: "50001", travellerId }],
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await scalar<number>("select count(*)::int as value from crm_cases")).toBe(0);
    expect(await scalar<number>("select count(*)::int as value from crm_events")).toBe(0);
  });

  it("changeCaseStatus moves the Postgres row, records the event and mails the client", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");

    const moved = await changeCaseStatus(context, TENANT_ID, created.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(moved.caseStatus).toBe("DOCS_UNDER_REVIEW");
    expect(moved.updatedAt > created.updatedAt).toBe(true);
    expect(await scalar<string>("select case_status as value from crm_cases where case_id = $1", [created.caseId])).toBe(
      "DOCS_UNDER_REVIEW",
    );
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).caseStatus).toBe("DOCS_UNDER_REVIEW");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED", "CASE_STATUS_CHANGED"]);
    expect(events[1]?.meta).toEqual({ fromStatus: "NEW", toStatus: "DOCS_UNDER_REVIEW" });
  });

  it("changeCaseStatus refuses an illegal move and leaves the Postgres row alone", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");

    await expect(changeCaseStatus(context, TENANT_ID, created.caseId, "DECIDED", ACTOR)).resolves.toBeDefined();
    // DECIDED -> NEW is not a legal edge.
    await expect(changeCaseStatus(context, TENANT_ID, created.caseId, "NEW", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).caseStatus).toBe("DECIDED");
    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.filter((event) => event.eventType === "CASE_STATUS_CHANGED")).toHaveLength(1);
  });

  it("changeCaseStatus on a case that does not exist is a 404", async () => {
    await expect(changeCaseStatus(context, TENANT_ID, "case_missing", "DOCS_UNDER_REVIEW", ACTOR)).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });

  it("updateCaseDetails edits, clears and re-keys fields in Postgres", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    context.advanceClock(1_000);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      created.caseId,
      {
        caseRef: "31377B",
        destinationCountry: "JP",
        appointmentDate: "2026-02-01",
        remarks: "Rush",
        groupName: "Smith family",
      },
      ACTOR,
    );
    expect(updated.caseRef).toBe("31377B");
    expect(updated.destinationCountry).toBe("JP");

    const row = (
      await sql.query<{ case_ref: string; destination_country: string; appointment_date: string; remarks: string }>(
        `select case_ref, destination_country, to_char(appointment_date, 'YYYY-MM-DD') as appointment_date, remarks
           from crm_cases where case_id = $1`,
        [created.caseId],
      )
    ).rows[0];
    expect(row).toEqual({
      case_ref: "31377B",
      destination_country: "JP",
      appointment_date: "2026-02-01",
      remarks: "Rush",
    });
    // Group name is part of the search haystack too.
    expect(
      await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [created.caseId]),
    ).toContain("smith family");

    // The REF moved: new one claimed, old one released (in crm_ref_claims).
    expect(await readRefClaim(context, TENANT_ID, "31377B")).toBeDefined();
    expect(await readRefClaim(context, TENANT_ID, "31377")).toBeUndefined();

    // null clears the column rather than leaving the old value behind.
    context.advanceClock(1_000);
    const cleared = await updateCaseDetails(context, TENANT_ID, created.caseId, { remarks: null }, ACTOR);
    expect(cleared.remarks).toBeUndefined();
    expect(await scalar<string | null>("select remarks as value from crm_cases where case_id = $1", [created.caseId])).toBeNull();

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED", "CASE_UPDATED", "CASE_UPDATED"]);
    expect(events[1]?.meta["changedFields"]).toBe(
      "caseRef,destinationCountry,appointmentDate,remarks,groupName",
    );
  });

  it("updateCaseDetails with no real change writes nothing new", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    context.advanceClock(1_000);

    const result = await updateCaseDetails(context, TENANT_ID, created.caseId, { destinationCountry: "BH" }, ACTOR);

    expect(result.updatedAt).toBe(created.updatedAt);
    expect((await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType)).toEqual([
      "CASE_CREATED",
    ]);
  });

  it("updateCaseDetails collision on a taken REF leaves the Postgres row unchanged", async () => {
    const partnerId = await seedPartnerId();
    const first = await seedCase(partnerId, "11111");
    await seedCase(partnerId, "22222");

    await expect(updateCaseDetails(context, TENANT_ID, first.caseId, { caseRef: "22222" }, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, first.caseId)).caseRef).toBe("11111");
  });

  it("changeBillingStatus persists in Postgres, and PAID plus every passport back closes the case", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const applicantRef = created.applicants[0]!.applicantRef;

    // Events sort by createdAt then eventId, so each step gets its own tick.
    context.advanceClock(1_000);
    const billed = await changeBillingStatus(context, TENANT_ID, created.caseId, "BILL_SENT", ACTOR);
    expect(billed.billingStatus).toBe("BILL_SENT");
    expect(
      await scalar<string>("select billing_status as value from crm_cases where case_id = $1", [created.caseId]),
    ).toBe("BILL_SENT");

    context.advanceClock(1_000);
    await changeApplicantCustody(context, TENANT_ID, created.caseId, applicantRef, "WITH_RGS", ACTOR);
    context.advanceClock(1_000);
    await changeApplicantCustody(context, TENANT_ID, created.caseId, applicantRef, "RETURNED", ACTOR);
    context.advanceClock(1_000);
    const paid = await changeBillingStatus(context, TENANT_ID, created.caseId, "PAID", ACTOR);

    expect(paid.billingStatus).toBe("PAID");
    expect(paid.caseStatus).toBe("CLOSED");
    const stored = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(stored.caseStatus).toBe("CLOSED");
    expect(stored.applicants[0]?.custody).toBe("RETURNED");
    expect(stored.applicants[0]?.custodySince).toBeDefined();

    const eventTypes = (await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType);
    expect(eventTypes.slice(0, 4)).toEqual(["CASE_CREATED", "BILLING_CHANGED", "CUSTODY_CHANGED", "CUSTODY_CHANGED"]);
    // The PAID write and the CLOSED it derives share one clock tick, so their
    // relative order is eventId order (random),.
    expect(eventTypes.slice(4).sort()).toEqual(["BILLING_CHANGED", "CASE_STATUS_CHANGED"]);
  });

  it("changeBillingStatus refuses a move the machine does not allow", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    await expect(changeBillingStatus(context, TENANT_ID, created.caseId, "PAID", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).billingStatus).toBe("UNBILLED");
  });

  it("changeApplicantOutcome derives DECIDED from applicant outcomes in Postgres", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    // DECIDED is derived from SUBMITTED onwards.
    await changeCaseStatus(context, TENANT_ID, created.caseId, "SUBMITTED", ACTOR);

    const decided = await changeApplicantOutcome(
      context,
      TENANT_ID,
      created.caseId,
      created.applicants[0]!.applicantRef,
      "APPROVED",
      ACTOR,
    );

    expect(decided.applicants[0]?.outcome).toBe("APPROVED");
    const stored = await readCaseOrThrow(context, TENANT_ID, created.caseId);
    expect(stored.applicants[0]?.outcome).toBe("APPROVED");
    expect(stored.caseStatus).toBe(decided.caseStatus);
  });

  it("addApplicant appends a Postgres applicant row and refreshes the search haystack", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const newTravellerId = await seedTravellerId("Priya Nair");

    const updated = await addApplicant(
      context,
      TENANT_ID,
      created.caseId,
      { travellerId: newTravellerId, passportNumber: "z9999999", refNo: "R-77" },
      ACTOR,
    );

    expect(updated.applicants).toHaveLength(2);
    const added = updated.applicants[1]!;
    expect(added).toMatchObject({ travellerId: newTravellerId, passportNumber: "Z9999999", refNo: "R-77" });
    expect(await scalar<number>("select count(*)::int as value from crm_applicants where case_id = $1", [created.caseId])).toBe(2);
    expect(
      await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [created.caseId]),
    ).toContain("priya nair");
    expect(await readRefClaim(context, TENANT_ID, "R-77")).toBeDefined();

    const summary = await scalar<{ count: number }>(
      "select applicant_summary as value from crm_cases where case_id = $1",
      [created.caseId],
    );
    expect(summary.count).toBe(2);
  });

  it("updateApplicantDetails rewrites the applicant row, the traveller and the search haystack", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377");
    const applicantRef = created.applicants[0]!.applicantRef;

    const updated = await updateApplicantDetails(
      context,
      TENANT_ID,
      created.caseId,
      applicantRef,
      { fullName: "Asha Verma", passportNumber: "n1234567", refNo: "R-1" },
      ACTOR,
    );

    expect(updated.applicants[0]).toMatchObject({ passportNumber: "N1234567", refNo: "R-1" });
    const row = (
      await sql.query<{ passport_number: string; ref_no: string }>(
        "select passport_number, ref_no from crm_applicants where case_id = $1 and applicant_ref = $2",
        [created.caseId, applicantRef],
      )
    ).rows[0];
    expect(row).toEqual({ passport_number: "N1234567", ref_no: "R-1" });
    // The second writeCase picked up the renamed traveller (crm_travellers) after the edit.
    const searchText = await scalar<string | null>("select search_text as value from crm_cases where case_id = $1", [
      created.caseId,
    ]);
    expect(searchText).toContain("asha verma");
    expect(searchText).toContain("n1234567");
    expect(searchText).not.toContain("traveller 31377");

    const events = await listCaseEvents(context, TENANT_ID, created.caseId);
    expect(events.at(-1)).toMatchObject({ eventType: "APPLICANT_UPDATED" });
  });

  it("removeApplicant drops the Postgres applicant row and compacts indexes, and refuses the last one", async () => {
    const partnerId = await seedPartnerId();
    const created = await seedCase(partnerId, "31377", ["A1", "A2", "A3"]);

    const updated = await removeApplicant(context, TENANT_ID, created.caseId, "A2", ACTOR);

    expect(updated.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A1", "A3"]);
    const rows = await sql.query<{ applicant_index: number; applicant_ref: string }>(
      "select applicant_index, applicant_ref from crm_applicants where case_id = $1 order by applicant_index",
      [created.caseId],
    );
    expect(rows.rows).toEqual([
      { applicant_index: 0, applicant_ref: "A1" },
      { applicant_index: 1, applicant_ref: "A3" },
    ]);

    context.advanceClock(1_000);
    await removeApplicant(context, TENANT_ID, created.caseId, "A3", ACTOR);
    await expect(removeApplicant(context, TENANT_ID, created.caseId, "A1", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await readCaseOrThrow(context, TENANT_ID, created.caseId)).applicants).toHaveLength(1);

    const eventTypes = (await listCaseEvents(context, TENANT_ID, created.caseId)).map((event) => event.eventType);
    expect(eventTypes).toEqual(["CASE_CREATED", "APPLICANT_REMOVED", "APPLICANT_REMOVED"]);
  });
});


describe("CRM case lists / counts / refs on Postgres", () => {
  let sql: SqlClient;
  let context: SqlTestContext;

  beforeEach(async () => {
    context = await buildSqlTestContext();
    sql = context.sql;
  });

  async function seedPartnerId(name: string): Promise<string> {
    return (await createPartner(context, TENANT_ID, { canonicalName: name }, ACTOR)).partnerId;
  }

  async function seedCase(
    partnerId: string,
    caseRef: string,
    overrides: { destinationCountry?: string; receivedDate?: string } = {},
  ): Promise<crm.CrmCase> {
    const travellerId = (await upsertTraveller(context, TENANT_ID, { fullName: `Traveller ${caseRef}` })).travellerId;
    const created = await createCase(
      context,
      TENANT_ID,
      {
        caseRef,
        caseType: "VISA",
        partnerId,
        destinationCountry: overrides.destinationCountry ?? "BH",
        visaType: "EVISA_TOURIST",
        entryType: "SINGLE",
        processing: "NORMAL",
        receivedDate: overrides.receivedDate ?? "2026-01-02",
        applicants: [{ applicantRef: caseRef, travellerId }],
      },
      ACTOR,
    );
    context.advanceClock(1_000);
    return created;
  }

  it("listCasesByStatus returns the Postgres cases, newest update first", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    const first = await seedCase(partnerId, "10001");
    const second = await seedCase(partnerId, "10002");
    const moved = await seedCase(partnerId, "10003");
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    const listing = await listCasesByStatus(context, TENANT_ID, "NEW");

    expect(listing.unreadableCaseIds).toEqual([]);
    expect(listing.cases.map((c) => c.caseId)).toEqual([second.caseId, first.caseId]);
    expect(listing.cases[0]).toEqual(second);
    const other = await listCasesByStatus(context, TENANT_ID, "DOCS_UNDER_REVIEW");
    expect(other.cases.map((c) => c.caseId)).toEqual([moved.caseId]);
  });

  it("listCasesByStatus honours the limit and names an unreadable (applicant-less) row", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    const a = await seedCase(partnerId, "10001");
    const b = await seedCase(partnerId, "10002");
    const broken = await seedCase(partnerId, "10003");
    await sql.query("delete from crm_applicants where case_id = $1", [broken.caseId]);

    const limited = await listCasesByStatus(context, TENANT_ID, "NEW", 2);
    expect(limited.cases.length + limited.unreadableCaseIds.length).toBe(2);

    const all = await listCasesByStatus(context, TENANT_ID, "NEW", 50);
    expect(all.unreadableCaseIds).toEqual([broken.caseId]);
    expect(all.cases.map((c) => c.caseId)).toEqual([b.caseId, a.caseId]);
  });

  it("listCasesByStatus is tenant scoped", async () => {
    const partnerId = await seedPartnerId("Ozzy Travels");
    await seedCase(partnerId, "10001");
    expect((await listCasesByStatus(context, "other-tenant", "NEW")).cases).toEqual([]);
  });

  it("listCasesByPartner returns that partner's cases, latest received first", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const other = await seedPartnerId("Other Travels");
    const older = await seedCase(ozzy, "10001", { receivedDate: "2026-01-02" });
    const newer = await seedCase(ozzy, "10002", { receivedDate: "2026-03-05" });
    await seedCase(other, "20001");

    const listing = await listCasesByPartner(context, TENANT_ID, ozzy);
    expect(listing.cases.map((c) => c.caseId)).toEqual([newer.caseId, older.caseId]);

    const limited = await listCasesByPartner(context, TENANT_ID, ozzy, 1);
    expect(limited.cases.map((c) => c.caseId)).toEqual([newer.caseId]);
  });

  it("countCasesByField groups by every supported field and totals match", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const other = await seedPartnerId("Other Travels");
    await seedCase(ozzy, "10001", { destinationCountry: "BH" });
    await seedCase(ozzy, "10002", { destinationCountry: "JP" });
    const moved = await seedCase(other, "20001", { destinationCountry: "BH" });
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    expect(await countCasesByField(context, TENANT_ID, "caseStatus")).toEqual({
      counts: { NEW: 2, DOCS_UNDER_REVIEW: 1 },
      total: 3,
      uncountedCaseIds: [],
    });
    expect((await countCasesByField(context, TENANT_ID, "destinationCountry")).counts).toEqual({ BH: 2, JP: 1 });
    expect((await countCasesByField(context, TENANT_ID, "billingStatus")).counts).toEqual({ UNBILLED: 3 });
    expect((await countCasesByField(context, TENANT_ID, "partnerId")).counts).toEqual({ [ozzy]: 2, [other]: 1 });
    expect((await countCasesByField(context, "other-tenant", "caseStatus")).total).toBe(0);
  });

  it("countCasesByField names a case whose counted field is empty instead of counting it", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    await seedCase(ozzy, "10001");
    const blank = await seedCase(ozzy, "10002");
    await sql.query("update crm_cases set destination_country = '' where case_id = $1", [blank.caseId]);

    const counted = await countCasesByField(context, TENANT_ID, "destinationCountry");
    expect(counted).toEqual({ counts: { BH: 1 }, total: 1, uncountedCaseIds: [blank.caseId] });
  });

  it("listCaseRefsByStatus returns refs without reassembling cases, including applicant-less rows", async () => {
    const ozzy = await seedPartnerId("Ozzy Travels");
    const a = await seedCase(ozzy, "10001");
    const b = await seedCase(ozzy, "10002");
    // A half-written case (no applicants) still has a ref the importer must know about.
    await sql.query("delete from crm_applicants where case_id = $1", [b.caseId]);
    const moved = await seedCase(ozzy, "10003");
    await changeCaseStatus(context, TENANT_ID, moved.caseId, "DOCS_UNDER_REVIEW", ACTOR);

    const listed = await listCaseRefsByStatus(context, TENANT_ID, "NEW");
    expect(listed.unreadableCaseIds).toEqual([]);
    expect(listed.storedCaseRefs).toEqual([
      { caseRef: "10002", caseId: b.caseId },
      { caseRef: "10001", caseId: a.caseId },
    ]);

    const limited = await listCaseRefsByStatus(context, TENANT_ID, "NEW", 1);
    expect(limited.storedCaseRefs).toEqual([{ caseRef: "10002", caseId: b.caseId }]);
  });
});
