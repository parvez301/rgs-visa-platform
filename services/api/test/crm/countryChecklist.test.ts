import { describe, expect, it } from "vitest";
import { buildTestContext } from "../helpers";
import { findCountryChecklist, putCountryChecklist } from "../../src/domain/crm/countryChecklist";
import { META_SORT_KEY, countryChecklistPartitionKey } from "../../src/domain/crm/keys";

const TENANT_ID = "rgs";
const DESK_ACTOR = "desk@rgs.local";
const SUPERVISOR_ACTOR = "supervisor@rgs.local";

// These rows are legacy: nothing live reads them, and the only remaining
// caller is the migration that folds them into CountryProduct. The reads are
// pinned anyway, because a checklist the migration cannot reassemble decides
// whether a country's products are converted or left alone.
describe("putCountryChecklist / findCountryChecklist", () => {
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

    const readBackChecklist = await findCountryChecklist(context, TENANT_ID, "JP");
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
    const withNotes = await findCountryChecklist(context, TENANT_ID, "AE");
    expect(withNotes?.notes).toBe("Embassy closed Fridays");

    await putCountryChecklist(
      context,
      TENANT_ID,
      { countryCode: "SG", requiredDocuments: ["Passport"] },
      DESK_ACTOR,
    );
    const withoutNotes = await findCountryChecklist(context, TENANT_ID, "SG");
    expect(withoutNotes?.notes).toBeUndefined();
    expect(Object.hasOwn(withoutNotes!, "notes")).toBe(false);
  });

  it("answers undefined, not an error, when no checklist is on file for a country", async () => {
    const context = buildTestContext();
    await expect(findCountryChecklist(context, TENANT_ID, "ZZ")).resolves.toBeUndefined();
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

    const readBackChecklist = await findCountryChecklist(context, TENANT_ID, "JP");
    expect(readBackChecklist?.updatedBy).toBe(SUPERVISOR_ACTOR);
    expect(readBackChecklist?.updatedAt).toBe(secondWrite.updatedAt);
  });

  it("throws CORRUPT_RECORD rather than a raw ZodError for a checklist row that will not parse", async () => {
    const context = buildTestContext();
    // A hand-repaired row missing requiredDocuments entirely -- the shape a
    // half-written import would leave. A bare `.parse()` would throw a
    // ZodError, which the migration's CorruptRecordError branch would not
    // catch, so it would abort the run instead of skipping the country.
    await context.table.put({
      PK: countryChecklistPartitionKey(TENANT_ID, "FR"),
      SK: META_SORT_KEY,
      countryCode: "FR",
      updatedAt: context.now().toISOString(),
      updatedBy: DESK_ACTOR,
    });

    await expect(findCountryChecklist(context, TENANT_ID, "FR")).rejects.toMatchObject({
      statusCode: 409,
      code: "CORRUPT_RECORD",
    });
  });

  it("rejects a malformed countryCode with 400, not a 500, and writes nothing", async () => {
    const context = buildTestContext();
    // A three-character code fails the schema's .length(2) constraint.
    // The partition key is derived from this code, so a malformed code would
    // write under a key that fails on every future read. The caller must see
    // a 400 so it knows to retry with valid input, not a 500.
    const malformedInput = {
      countryCode: "XYZ",
      requiredDocuments: ["Passport"],
    };

    await expect(putCountryChecklist(context, TENANT_ID, malformedInput, DESK_ACTOR))
      .rejects.toMatchObject({
        statusCode: 400,
        code: "BAD_REQUEST",
      });

    await expect(findCountryChecklist(context, TENANT_ID, "XYZ")).resolves.toBeUndefined();
  });
});
