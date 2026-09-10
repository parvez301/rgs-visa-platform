import { describe, expect, it } from "vitest";
import { createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { buildTestContext, type TestContext } from "../helpers";

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedOneCase(context: TestContext) {
  const partner = await createPartner(
    context,
    TENANT_ID,
    { canonicalName: "Ozzy Travels", partnerType: "AGENCY" },
    ACTOR,
  );
  const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "ASHA RAO" });
  return createCase(
    context,
    TENANT_ID,
    {
      caseRef: "90001",
      caseType: "VISA",
      visaType: "EVISA_TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
    },
    ACTOR,
  );
}

describe("updateCaseDetails", () => {
  it("changes only the six permitted fields", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      {
        visaType: "TOURIST",
        entryType: "MULTIPLE",
        processing: "EXPRESS",
        submissionDate: "2026-09-05",
        appointmentDate: "2026-09-10",
        expectedCollectionDate: "2026-09-20",
      },
      ACTOR,
    );

    expect(updated.visaType).toBe("TOURIST");
    expect(updated.entryType).toBe("MULTIPLE");
    expect(updated.processing).toBe("EXPRESS");
    expect(updated.submissionDate).toBe("2026-09-05");
    expect(updated.appointmentDate).toBe("2026-09-10");
    expect(updated.expectedCollectionDate).toBe("2026-09-20");

    // Untouched: caseRef, partnerId, destinationCountry, applicants and every
    // other field this route does not name stay exactly as seeded.
    expect(updated.caseRef).toBe(seeded.caseRef);
    expect(updated.partnerId).toBe(seeded.partnerId);
    expect(updated.destinationCountry).toBe(seeded.destinationCountry);
    expect(updated.applicants).toEqual(seeded.applicants);
    expect(updated.caseStatus).toBe(seeded.caseStatus);
    expect(updated.billingStatus).toBe(seeded.billingStatus);
  });

  it("records a CASE_UPDATED event naming exactly which fields moved", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    // Both fields start unset on a freshly seeded case, so "moved" and
    // "present in the input" agree here -- that distinction is what the two
    // tests below this one exist to pull apart.
    await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { appointmentDate: "2026-10-01", expectedCollectionDate: "2026-10-15" },
      ACTOR,
    );

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvent = events.find((event) => event.eventType === "CASE_UPDATED");
    expect(updateEvent).toBeDefined();
    // The full string, not a substring check: meta.changedFields = "" would
    // pass a toContain("appointmentDate") assertion, which proves nothing.
    expect(updateEvent?.meta["changedFields"]).toBe("appointmentDate,expectedCollectionDate");
    expect(updateEvent?.actorEmail).toBe(ACTOR);
  });

  it("names only the field that actually moved when one supplied value already matches storage", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "2026-10-01" }, ACTOR);

    // Two events minted in the same frozen millisecond sort by their random
    // id suffix, not by insertion order -- advance the clock so the second
    // event's SK genuinely sorts after the first and events[1] is reliably it.
    context.advanceClock(60_000);

    // Re-supplying the SAME appointmentDate alongside a genuinely new
    // expectedCollectionDate: present-in-input semantics would have named
    // both; moved-fields semantics names only the one that changed.
    await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { appointmentDate: "2026-10-01", expectedCollectionDate: "2026-10-15" },
      ACTOR,
    );

    const events = (await listCaseEvents(context, TENANT_ID, seeded.caseId)).filter(
      (event) => event.eventType === "CASE_UPDATED",
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.meta["changedFields"]).toBe("expectedCollectionDate");
  });

  it("is a no-op -- no write, no event -- when nothing actually changes", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);

    const resultOnEmptyInput = await updateCaseDetails(context, TENANT_ID, seeded.caseId, {}, ACTOR);
    expect(resultOnEmptyInput).toEqual(seeded);

    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "2026-10-01" }, ACTOR);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "2026-10-01" }, ACTOR);

    const updateEvents = (await listCaseEvents(context, TENANT_ID, seeded.caseId)).filter(
      (event) => event.eventType === "CASE_UPDATED",
    );
    // Exactly one real event: the appointmentDate move. Neither the empty
    // input nor the unchanged re-supply recorded anything -- under the old
    // present-in-input semantics both of those would have added their own
    // CASE_UPDATED event too, giving three instead of one.
    expect(updateEvents).toHaveLength(1);
  });

  // The one that matters: caseStatus and billingStatus each have their own
  // state machine and their own mutator (changeCaseStatus, changeBillingStatus).
  // `as never` is how the test defeats the compile-time guard the input type
  // already gives this route, to prove the RUNTIME behaviour holds too.
  it("ignores an attempt to move a state-machine axis through the details route", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { appointmentDate: "2026-10-01", caseStatus: "DECIDED", billingStatus: "PAID" } as never,
      ACTOR,
    );
    expect(updated.appointmentDate).toBe("2026-10-01");
    expect(updated.caseStatus).toBe(seeded.caseStatus);
    expect(updated.billingStatus).toBe(seeded.billingStatus);
  });

  it("rejects a malformed date instead of a bare 500", async () => {
    const context = buildTestContext();
    const seeded = await seedOneCase(context);
    // toMatchObject({ statusCode }), not a bare rejects.toThrow(): an
    // unwrapped ZodError throws too, so a bare toThrow() cannot tell the 400
    // this guard exists to produce apart from the 500 it exists to prevent.
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "not-a-date" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on a caseId that does not exist", async () => {
    const context = buildTestContext();
    await expect(
      updateCaseDetails(context, TENANT_ID, "case_missing", { appointmentDate: "2026-10-01" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
