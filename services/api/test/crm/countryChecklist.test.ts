import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { getCountryChecklist, putCountryChecklist } from "../../src/domain/crm/countryChecklist";
import { META_SORT_KEY, countryChecklistPartitionKey } from "../../src/domain/crm/keys";

const TENANT_ID = "rgs";
const DESK_ACTOR = "desk@rgs.local";
const SUPERVISOR_ACTOR = "supervisor@rgs.local";

describe("putCountryChecklist / getCountryChecklist", () => {
  it("writes a checklist and reads it back with the writing actor and timestamp stamped on it", async () => {
    const context = buildTestContext();
    const writtenChecklist = await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "JP", requiredDocuments: ["Passport", "Photo", "Itinerary"] },
      DESK_ACTOR,
    );
    expect(writtenChecklist).toEqual({
      countryCode: "JP",
      requiredDocuments: ["Passport", "Photo", "Itinerary"],
      updatedAt: context.now().toISOString(),
      updatedBy: DESK_ACTOR,
    });

    const readBackChecklist = await getCountryChecklist(context, TENANT_ID, "JP");
    expect(readBackChecklist).toEqual(writtenChecklist);
  });

  it("keeps optional notes when given, and omits the field entirely when not", async () => {
    const context = buildTestContext();
    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "AE", requiredDocuments: ["Passport"], notes: "Embassy closed Fridays" },
      DESK_ACTOR,
    );
    const withNotes = await getCountryChecklist(context, TENANT_ID, "AE");
    expect(withNotes.notes).toBe("Embassy closed Fridays");

    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "SG", requiredDocuments: ["Passport"] },
      DESK_ACTOR,
    );
    const withoutNotes = await getCountryChecklist(context, TENANT_ID, "SG");
    expect(withoutNotes.notes).toBeUndefined();
    expect(Object.hasOwn(withoutNotes, "notes")).toBe(false);
  });

  it("throws a 404 when no checklist is on file for a country", async () => {
    const context = buildTestContext();
    await expect(getCountryChecklist(context, TENANT_ID, "ZZ")).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });
  });

  // Ruling: a country checklist is not a case, so it records no CrmEventType.
  // Attribution instead lives directly on the record -- this is the test that
  // pins it, per the controller notes.
  it("records who changed the checklist last, and when -- not who wrote it first", async () => {
    const context = buildTestContext();
    const firstWrite = await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "JP", requiredDocuments: ["Passport"] },
      DESK_ACTOR,
    );
    context.advanceClock(60_000);
    const secondWrite = await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "JP", requiredDocuments: ["Passport", "Bank Statement"] },
      SUPERVISOR_ACTOR,
    );

    expect(secondWrite.updatedBy).toBe(SUPERVISOR_ACTOR);
    expect(secondWrite.updatedAt).not.toBe(firstWrite.updatedAt);

    const readBackChecklist = await getCountryChecklist(context, TENANT_ID, "JP");
    expect(readBackChecklist.updatedBy).toBe(SUPERVISOR_ACTOR);
    expect(readBackChecklist.updatedAt).toBe(secondWrite.updatedAt);
  });

  it("answers 409 CORRUPT_RECORD rather than a raw ZodError for a checklist row that will not parse", async () => {
    const context = buildTestContext();
    // A hand-repaired row missing requiredDocuments entirely -- the shape a
    // half-written import would leave. A bare `.parse()` would throw a
    // ZodError here, which router.ts's ApiError-only mapping does not catch,
    // which would answer 500 the moment a route sits in front of this.
    await context.table.put({
      PK: countryChecklistPartitionKey(TENANT_ID, "FR"),
      SK: META_SORT_KEY,
      countryCode: "FR",
      updatedAt: context.now().toISOString(),
      updatedBy: DESK_ACTOR,
    });

    await expect(getCountryChecklist(context, TENANT_ID, "FR")).rejects.toMatchObject({
      statusCode: 409,
      code: "CORRUPT_RECORD",
    });
  });
});
