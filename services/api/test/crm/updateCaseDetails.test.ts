import { afterEach, describe, expect, it } from "vitest";
import { createCase, updateCaseDetails } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";

afterEach(closeTestContexts);

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
    const context = await buildTestContext();
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

  it("stores remarks and names them when they change", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { remarks: "Collect from VFS after 4pm" },
      ACTOR,
    );

    expect(updated.remarks).toBe("Collect from VFS after 4pm");
    expect(updated.billingStatus).toBe(seeded.billingStatus);
    expect(updated.caseStatus).toBe(seeded.caseStatus);

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvent = events.find((event) => event.eventType === "CASE_UPDATED");
    expect(updateEvent?.meta["changedFields"]).toBe("remarks");
  });

  it("records a CASE_UPDATED event naming exactly which fields moved", async () => {
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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
    const context = await buildTestContext();
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
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    // toMatchObject({ statusCode }), not a bare rejects.toThrow(): an
    // unwrapped ZodError throws too, so a bare toThrow() cannot tell the 400
    // this guard exists to produce apart from the 500 it exists to prevent.
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { appointmentDate: "not-a-date" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on a caseId that does not exist", async () => {
    const context = await buildTestContext();
    await expect(
      updateCaseDetails(context, TENANT_ID, "case_missing", { appointmentDate: "2026-10-01" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a collection date earlier than the case's received date", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);

    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { expectedCollectionDate: "2026-08-31" }, ACTOR),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Collection date cannot be before the received date",
    });
  });

  it("sets and then clears groupName and clientEmail", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);

    const withFields = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { groupName: "Rao Family", clientEmail: "asha@example.com" },
      ACTOR,
    );
    expect(withFields.groupName).toBe("Rao Family");
    expect(withFields.clientEmail).toBe("asha@example.com");

    const cleared = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      { groupName: null, clientEmail: null },
      ACTOR,
    );
    expect(cleared).not.toHaveProperty("groupName");
    expect(cleared).not.toHaveProperty("clientEmail");

    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvents = events.filter((event) => event.eventType === "CASE_UPDATED");
    expect(updateEvents.map((event) => event.meta["changedFields"])).toEqual([
      "groupName,clientEmail",
      "groupName,clientEmail",
    ]);
  });

  it("treats clearing an already-absent clientEmail as no change", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);

    const unchanged = await updateCaseDetails(context, TENANT_ID, seeded.caseId, { clientEmail: null }, ACTOR);

    expect(unchanged.updatedAt).toBe(seeded.updatedAt);
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    expect(events.some((event) => event.eventType === "CASE_UPDATED")).toBe(false);
  });

  it("rejects a malformed clientEmail with a 400 naming the field", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);

    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { clientEmail: "not an address" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("clientEmail") });
  });
});

describe("updateCaseDetails — every stage, every field", () => {
  it("changes REF, partner, country, received date and type, and records them", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    const otherPartner = await createPartner(context, TENANT_ID, { canonicalName: "Blue Sky", partnerType: "AGENCY" }, ACTOR);

    const updated = await updateCaseDetails(
      context,
      TENANT_ID,
      seeded.caseId,
      {
        caseRef: "90001-B",
        partnerId: otherPartner.partnerId,
        destinationCountry: "FR",
        receivedDate: "2026-08-30",
        caseType: "ATTESTATION",
      },
      ACTOR,
    );

    expect(updated).toMatchObject({
      caseRef: "90001-B",
      partnerId: otherPartner.partnerId,
      destinationCountry: "FR",
      receivedDate: "2026-08-30",
      caseType: "ATTESTATION",
    });
    // Leaving VISA drops the visa type without a second request.
    expect(updated.visaType).toBeUndefined();
    const events = await listCaseEvents(context, TENANT_ID, seeded.caseId);
    const updateEvent = events.find((event) => event.eventType === "CASE_UPDATED");
    expect(String(updateEvent?.meta["changedFields"]).split(",").sort()).toEqual(
      ["caseRef", "caseType", "destinationCountry", "partnerId", "receivedDate", "visaType"].sort(),
    );
  });

  it("clears an optional field when sent null", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { remarks: "call first", processing: "EXPRESS" }, ACTOR);

    const cleared = await updateCaseDetails(context, TENANT_ID, seeded.caseId, { remarks: null, processing: null }, ACTOR);
    expect(cleared.remarks).toBeUndefined();
    expect(cleared.processing).toBeUndefined();
  });

  it("frees the old REF after a rename, and refuses a REF another case holds", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseRef: "RENAMED-1" }, ACTOR);

    // 90001 is free again: a new case may take it.
    const traveller = await upsertTraveller(context, TENANT_ID, { fullName: "NEW PERSON" });
    const newCase = await createCase(
      context,
      TENANT_ID,
      {
        caseRef: "90001",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: seeded.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-02",
        applicants: [{ applicantRef: "A1", travellerId: traveller.travellerId }],
      },
      ACTOR,
    );
    await expect(
      updateCaseDetails(context, TENANT_ID, newCase.caseId, { caseRef: "renamed-1" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("checks the collection date against the NEW received date", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { expectedCollectionDate: "2026-09-10" }, ACTOR);

    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { receivedDate: "2026-09-15" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404s on an unknown partner and 400s on VISA without a visa type", async () => {
    const context = await buildTestContext();
    const seeded = await seedOneCase(context);
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { partnerId: "ptn_missing" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
    await updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseType: "ATTESTATION" }, ACTOR);
    await expect(
      updateCaseDetails(context, TENANT_ID, seeded.caseId, { caseType: "VISA" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
