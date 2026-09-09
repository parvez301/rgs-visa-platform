import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { writeCase } from "../../src/domain/crm/caseStore";
import { createPartner } from "../../src/domain/crm/partners";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import {
  changeApplicantCustody,
  changeApplicantOutcome,
  changeBillingStatus,
  changeCaseStatus,
  createCase,
  getCase,
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

async function seedCase(context: TestContext, partnerId: string, caseRef = "31377") {
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
      applicants: [{ applicantRef: caseRef, travellerId: "trv_1" }],
    },
    "ops@rgs.test",
  );
}

async function seedTwoApplicantCase(context: TestContext, partnerId: string, caseRef = "31377") {
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
        { applicantRef: `${caseRef}-1`, travellerId: "trv_1" },
        { applicantRef: `${caseRef}-2`, travellerId: "trv_2" },
      ],
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

  it("rejects a VISA case with no visa type", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
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
          applicants: [{ applicantRef: "31999", travellerId: "trv_1" }],
        },
        "ops@rgs.test",
      ),
    ).rejects.toThrow();
  });

  it("allows a non-visa case with no visa type", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    const attestation = await createCase(
      context,
      "rgs",
      {
        caseRef: "31888",
        caseType: "ATTESTATION",
        partnerId,
        destinationCountry: "AE",
        receivedDate: "2026-01-02",
        applicants: [{ applicantRef: "31888", travellerId: "trv_2" }],
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
    const updated = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      0,
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
    // NOT_HELD may only go to WITH_RGS.
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, 0, "AT_EMBASSY", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a custody change for an applicant index that does not exist", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await expect(
      changeApplicantCustody(context, "rgs", created.caseId, 7, "WITH_RGS", "ops@rgs.test"),
    ).rejects.toMatchObject({ statusCode: 400 });
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
    expect(await listCasesByStatus(context, "rgs", "NEW")).toHaveLength(1);

    await changeCaseStatus(context, "rgs", created.caseId, "IN_PROGRESS", "ops@rgs.test");
    // The GSI1 entry must move with the status, or the queue shows stale rows.
    expect(await listCasesByStatus(context, "rgs", "NEW")).toHaveLength(0);
    expect(await listCasesByStatus(context, "rgs", "IN_PROGRESS")).toHaveLength(1);
  });

  it("lists cases by partner", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId, "31377");
    await seedCase(context, partnerId, "31378");
    expect(await listCasesByPartner(context, "rgs", partnerId)).toHaveLength(2);
  });

  it("keeps one tenant's cases out of another's queries", async () => {
    const context = buildTestContext();
    const partnerId = await seedPartner(context);
    await seedCase(context, partnerId);
    expect(await listCasesByStatus(context, "other-tenant", "NEW")).toEqual([]);
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

    await changeApplicantCustody(context, "rgs", created.caseId, 0, "WITH_RGS", "ops@rgs.test");
    await changeApplicantCustody(context, "rgs", created.caseId, 0, "RETURNED", "ops@rgs.test");
    await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    const paidCase = await changeBillingStatus(context, "rgs", created.caseId, "PAID", "ops@rgs.test");

    expect(paidCase.caseStatus).toBe("CLOSED");

    const events = await listCaseEvents(context, "rgs", created.caseId);
    const closeEvent = events.find(
      (event) => event.eventType === "CASE_STATUS_CHANGED" && event.meta["toStatus"] === "CLOSED",
    );
    expect(closeEvent!.meta["fromStatus"]).toBe("NEW");
    expect(closeEvent!.meta["toStatus"]).toBe("CLOSED");
  });

  it("does not close a case while billing is still unpaid", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));

    await changeApplicantCustody(context, "rgs", created.caseId, 0, "WITH_RGS", "ops@rgs.test");
    const returnedButUnpaid = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      0,
      "RETURNED",
      "ops@rgs.test",
    );

    expect(returnedButUnpaid.billingStatus).toBe("UNBILLED");
    expect(returnedButUnpaid.caseStatus).not.toBe("CLOSED");
  });

  it("does not close a case when billing is UNKNOWN, even with every passport returned", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));

    // Simulate a migrated case whose billing was never re-classified — the
    // importer writes this status directly through caseStore, never through
    // changeBillingStatus (UNKNOWN is reserved for the migration).
    await writeCase(context, { ...created, billingStatus: "UNKNOWN" });

    await changeApplicantCustody(context, "rgs", created.caseId, 0, "WITH_RGS", "ops@rgs.test");
    const returnedWithUnknownBilling = await changeApplicantCustody(
      context,
      "rgs",
      created.caseId,
      0,
      "RETURNED",
      "ops@rgs.test",
    );

    expect(returnedWithUnknownBilling.billingStatus).toBe("UNKNOWN");
    expect(returnedWithUnknownBilling.caseStatus).not.toBe("CLOSED");
  });

  it("does not drag a terminal case back into CLOSED by a later derivation", async () => {
    const context = buildTestContext();
    const created = await seedCase(context, await seedPartner(context));
    await changeCaseStatus(context, "rgs", created.caseId, "WITHDRAWN", "ops@rgs.test");

    await changeApplicantCustody(context, "rgs", created.caseId, 0, "WITH_RGS", "ops@rgs.test");
    await changeApplicantCustody(context, "rgs", created.caseId, 0, "RETURNED", "ops@rgs.test");
    await changeBillingStatus(context, "rgs", created.caseId, "BILL_SENT", "ops@rgs.test");
    const finalCase = await changeBillingStatus(context, "rgs", created.caseId, "PAID", "ops@rgs.test");

    expect(finalCase.caseStatus).toBe("WITHDRAWN");
  });
});
