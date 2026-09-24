import { crm } from "@rgs/shared";
import { describe, expect, it, vi } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { writeCase } from "../../src/domain/crm/caseStore";
import {
  casePartitionKey,
  caseStatusGsi1Pk,
  travellerPartitionKey,
} from "../../src/domain/crm/keys";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import type { PagedQueryOptions, QueryOptions, QueryPage, TableItem } from "../../src/lib/db";
import {
  changeApplicantCustody,
  changeApplicantOutcome,
  changeBillingStatus,
  changeCaseStatus,
  countCasesByField,
  createCase,
  getCase,
  listCaseRefsByStatus,
  listCasesByPartner,
  listCasesByStatus,
} from "../../src/domain/crm/cases";

async function seedPartner(context: TestContext): Promise<string> {
  const partner = await createPartner(
    context,
    "rgs",
    { canonicalName: "Ozzy Travels" },
    "ops@rgs.test",
  );
  return partner.partnerId;
}

/** Cases point at travellers on file, so every case fixture needs one first. */
async function seedTraveller(context: TestContext, fullName: string): Promise<string> {
  const traveller = await upsertTraveller(context, "rgs", { fullName });
  return traveller.travellerId;
}

async function seedCase(context: TestContext, partnerId: string, caseRef = "31377") {
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

async function seedTwoApplicantCase(context: TestContext, partnerId: string, caseRef = "31377") {
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
  context: TestContext,
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    expect(created.caseStatus).toBe("NEW");
    expect(created.billingStatus).toBe("UNBILLED");
    expect(created.applicants[0]!.custody).toBe("NOT_HELD");
    expect(created.applicants[0]!.outcome).toBe("PENDING");
    expect(created.totalInr).toBe(0);
  });

  it("stores an optional collection date and remarks, and still opens New and Unbilled", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const events = await listCaseEvents(context, "rgs", created.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("CASE_CREATED");
    expect(events[0]!.actorEmail).toBe("ops@rgs.test");
  });

  it("rejects a case whose partner does not exist", async () => {
    const context = buildTestContext();
    await expect(seedCase(context, "no_such_partner")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("creates a case for an admin whose token carries no email claim", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    expect(created.createdByEmail).toBe("ops@rgs.test");
  });

  it("rejects a case whose traveller does not exist", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const moved = await changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test");
    expect(moved.caseStatus).toBe("IN_PROGRESS");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const statusEvent = events.find((event) => event.eventType === "CASE_STATUS_CHANGED");
    expect(statusEvent!.meta["fromStatus"]).toBe("NEW");
    expect(statusEvent!.meta["toStatus"]).toBe("IN_PROGRESS");
  });

  it("refuses an illegal case-status transition with a 409", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await changeCaseStatus(context, "rgs", created.caseId, "WITHDRAWN", "ops@rgs.test");
    // WITHDRAWN is terminal — nothing may leave it.
    await expect(
      changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("moves custody on a single applicant without touching the case status", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const applicantRef = created.applicants[0]!.applicantRef;
    // NOT_HELD may only go to WITH_RGS.
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, applicantRef, "AT_EMBASSY", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a custody change for an applicant ref that does not exist", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    const billed = await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    expect(billed.billingStatus).toBe("BILL_SENT");
    expect(billed.caseStatus).toBe("NEW");
    expect(billed.applicants[0]!.custody).toBe("NOT_HELD");
  });

  it("lists cases by status, and the index follows the case when it moves", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const created = await seedCase(context, partnerId);
    expect((await listCasesByStatus(context, "rgs", "NEW")).cases).toHaveLength(1);

    await changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test");
    // The GSI1 entry must move with the status, or the queue shows stale rows.
    expect((await listCasesByStatus(context, "rgs", "NEW")).cases).toHaveLength(0);
    expect((await listCasesByStatus(context, "rgs", "IN_PROGRESS")).cases).toHaveLength(1);
  });

  it("lists cases by partner", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    expect((await listCasesByPartner(context, "rgs", partnerId)).cases).toHaveLength(2);
  });

  it("keeps listing the healthy cases when one partition lost its applicants", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.unreadableCaseIds).toEqual([]);
  });

  it("reports the cases it had to skip on the by-partner listing too", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    const corruptedCase = await seedCase(context, partnerId, "31378");
    await writeCase(context, { ...corruptedCase, applicants: [] });

    const listed = await listCasesByPartner(context, "rgs", partnerId);
    expect(listed.cases).toHaveLength(1);
    expect(listed.unreadableCaseIds).toEqual([corruptedCase.caseId]);
  });

  it("reports a META item that lost its own caseId, instead of dropping it in silence", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const healthyCase = await seedCase(context, partnerId, "31377");
    // A META item indexed under the NEW queue whose body has no caseId of its
    // own. Naming it String(item.caseId) yields the literal id "undefined",
    // which reads back as no case at all — the row was dropped before the
    // reporting path ever saw it. The partition key still identifies it.
    await context.table.put({
      PK: casePartitionKey("rgs", "case_ghost"),
      SK: "META",
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: "rgs",
      caseRef: "31379",
    });

    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.cases.map((listedCase) => listedCase.caseId)).toEqual([healthyCase.caseId]);
    expect(listed.unreadableCaseIds).toEqual(["case_ghost"]);
  });

  it("reports a status-index entry whose case partition holds nothing", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    // The indexed item names a caseId that lives in no partition — readCase
    // returns undefined for it, which used to fall through the `if (loadedCase)`
    // check and out of the loop without a word.
    await context.table.put({
      PK: casePartitionKey("rgs", "case_stale_index"),
      SK: "META",
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: "rgs",
      caseId: "case_that_was_deleted",
      caseRef: "31380",
    });

    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.cases).toHaveLength(1);
    expect(listed.unreadableCaseIds).toEqual(["case_that_was_deleted"]);
  });

  // The one shape where nothing names a case: the body has no caseId AND the
  // partition key is not a case partition either, so the caseId fallback has
  // nothing to recover. A row hand-repaired into the wrong partition looks
  // exactly like this. The previous test for it used a real case partition key,
  // which the fallback resolves — it went down the corrupt-record path instead
  // and left this guard unexercised.
  const HAND_REPAIRED_META_PARTITION_KEY = travellerPartitionKey("rgs", "t_hand_repaired");

  async function putUnidentifiableMetaItem(context: TestContext): Promise<void> {
    await context.table.put({
      PK: HAND_REPAIRED_META_PARTITION_KEY,
      SK: "META",
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: "rgs",
      caseRef: "31381",
    });
  }

  it("reports a META item that neither its body nor its key names a case for", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const healthyCase = await seedCase(context, partnerId, "31377");
    await putUnidentifiableMetaItem(context);

    const listed = await listCasesByStatus(context, "rgs", "NEW");
    expect(listed.cases.map((listedCase) => listedCase.caseId)).toEqual([healthyCase.caseId]);
    // The storage key is the only handle an operator has on a row like this.
    expect(listed.unreadableCaseIds).toEqual([HAND_REPAIRED_META_PARTITION_KEY]);
  });

  it("warns about a META item it could not even name", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await putUnidentifiableMetaItem(context);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warnedText = "";
    try {
      await listCasesByStatus(context, "rgs", "NEW");
      warnedText = warnSpy.mock.calls.map((warnArguments) => warnArguments.join(" ")).join("\n");
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnedText).toContain(HAND_REPAIRED_META_PARTITION_KEY);
  });

  it("warns with the caseId of a case it had to skip", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId);
    expect((await listCasesByStatus(context, "other-tenant", "NEW")).cases).toEqual([]);
  });

  it("throws a 404 reading a case that does not exist", async () => {
    const context = buildTestContext();
    await expect(getCase(context, "rgs", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("changes an applicant's outcome and logs the from/to values", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    expect(decided.caseStatus).toBe("DECIDED");

    await expect(
      changeApplicantOutcome(context, "rgs", created.caseId, applicantRef, "PENDING", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });

    // A DECIDED case must never hold a PENDING applicant: the derivation
    // short-circuits once DECIDED, so nothing else would put this right.
    const reloaded = await getCase(context, "rgs", created.caseId);
    expect(reloaded.applicants[0]!.outcome).toBe("APPROVED");
    expect(reloaded.caseStatus).toBe("DECIDED");
  });

  it("refuses a no-op outcome change with a 409", async () => {
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
    const context = buildTestContext();
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
  it("reads every stored ref straight off the index, without reassembling a case", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");

    // No `readCase` at all: one query per status partition, and the ref comes
    // off the META item the query already returned. Reassembling instead costs
    // two strongly-consistent round-trips per case (14,312 on the real
    // workbook) to collect an attribute already in hand.
    let baseTableReadCount = 0;
    const countingContext = {
      ...context,
      table: {
        ...context.table,
        get: (partitionKey: string, sortKey: string) => {
          baseTableReadCount += 1;
          return context.table.get(partitionKey, sortKey);
        },
        query: (partitionKey: string, options?: QueryOptions) => {
          baseTableReadCount += 1;
          return context.table.query(partitionKey, options);
        },
        put: (item: TableItem) => context.table.put(item),
        delete: (partitionKey: string, sortKey: string) => context.table.delete(partitionKey, sortKey),
        queryGsi: (indexName: "GSI1" | "GSI2" | "GSI3", partitionKey: string, options?: QueryOptions) =>
          context.table.queryGsi(indexName, partitionKey, options),
        queryGsiPage: (
          indexName: "GSI1" | "GSI2" | "GSI3",
          partitionKey: string,
          options: PagedQueryOptions,
        ): Promise<QueryPage> => context.table.queryGsiPage(indexName, partitionKey, options),
      },
    };

    const listed = await listCaseRefsByStatus(countingContext, "rgs", "NEW", 1000);
    expect(listed.storedCaseRefs.map((stored) => stored.caseRef).sort()).toEqual(["31377", "31378"]);
    expect(listed.unreadableCaseIds).toEqual([]);
    expect(baseTableReadCount).toBe(0);
  });

  it("still reports the ref of a case that will not reassemble", async () => {
    const context = buildTestContext();
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

  it("names a META item that records no ref rather than dropping it", async () => {
    const context = buildTestContext();
    await context.table.put({
      PK: casePartitionKey("rgs", "case_no_ref"),
      SK: "META",
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: "rgs",
    });

    const listed = await listCaseRefsByStatus(context, "rgs", "NEW", 1000);
    expect(listed.storedCaseRefs).toEqual([]);
    expect(listed.unreadableCaseIds).toEqual(["case_no_ref"]);
  });
});

describe("countCasesByField", () => {
  it("counts cases by caseStatus without reassembling any of them", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    const thirdCase = await seedCase(context, partnerId, "31379");
    await changeCaseStatus(context, "rgs", thirdCase.caseId, "IN_PROGRESS", "ops@rgs.test");

    const counted = await countCasesByField(context, "rgs", "caseStatus");
    expect(counted.counts).toEqual({ NEW: 2, IN_PROGRESS: 1 });
    expect(counted.total).toBe(3);
    expect(counted.uncountedCaseIds).toEqual([]);
  });

  it("counts by destinationCountry, billingStatus and partnerId too", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377"); // seedCase's destinationCountry is BH

    expect((await countCasesByField(context, "rgs", "destinationCountry")).counts).toEqual({ BH: 1 });
    expect((await countCasesByField(context, "rgs", "billingStatus")).counts).toEqual({ UNBILLED: 1 });
    expect((await countCasesByField(context, "rgs", "partnerId")).counts).toEqual({ [partnerId]: 1 });
  });

  it("names a case whose META item carries no value for the counted field, instead of dropping it or counting it as 'undefined'", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    // Same corruption shape as "names a META item that records no ref rather
    // than dropping it" above: indexed under NEW, but the body carries no
    // caseStatus for countCasesByField to read off it.
    await context.table.put({
      PK: casePartitionKey("rgs", "case_no_status"),
      SK: "META",
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-01-02T10:00:00.000Z",
      tenantId: "rgs",
      caseId: "case_no_status",
    });

    const counted = await countCasesByField(context, "rgs", "caseStatus");
    expect(counted.counts).toEqual({ NEW: 1 });
    expect(counted.total).toBe(1);
    expect(counted.uncountedCaseIds).toEqual(["case_no_status"]);
  });

  it("counts every case in the tenant with zero base-table (partition) reads", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");

    // Same wrapping pattern as listCaseRefsByStatus's cost test above: `get`
    // and `query` are the base-table, strongly-consistent operations readCase
    // uses to reassemble a case out of its META item and applicant items.
    // countCasesByField must never call either -- everything it needs is
    // already on the META items the GSI1 query per status hands back.
    let baseTableReadCount = 0;
    const countingContext = {
      ...context,
      table: {
        ...context.table,
        get: (partitionKey: string, sortKey: string) => {
          baseTableReadCount += 1;
          return context.table.get(partitionKey, sortKey);
        },
        query: (partitionKey: string, options?: QueryOptions) => {
          baseTableReadCount += 1;
          return context.table.query(partitionKey, options);
        },
        put: (item: TableItem) => context.table.put(item),
        delete: (partitionKey: string, sortKey: string) => context.table.delete(partitionKey, sortKey),
        queryGsi: (indexName: "GSI1" | "GSI2" | "GSI3", partitionKey: string, options?: QueryOptions) =>
          context.table.queryGsi(indexName, partitionKey, options),
        queryGsiPage: (
          indexName: "GSI1" | "GSI2" | "GSI3",
          partitionKey: string,
          options: PagedQueryOptions,
        ): Promise<QueryPage> => context.table.queryGsiPage(indexName, partitionKey, options),
      },
    };

    const counted = await countCasesByField(countingContext, "rgs", "caseStatus");
    expect(counted.total).toBe(2);
    expect(baseTableReadCount).toBe(0);
  });
});
