import { afterEach, describe, expect, it } from "vitest";
import { createCase, changeApplicantCustody } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { getTravellerOrThrow, upsertTraveller } from "../../src/domain/crm/travellers";
import { listCaseEvents } from "../../src/domain/crm/crmEvents";
import { addApplicant, removeApplicant, updateApplicantDetails } from "../../src/domain/crm/applicantEdits";
import { claimNewRefs, readRefClaim } from "../../src/domain/crm/refClaims";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";

afterEach(closeSqlTestContexts);

const TENANT_ID = "rgs";
const ACTOR = "desk@rgs.local";

async function seedFamilyCase(context: SqlTestContext) {
  const partner = await createPartner(context, TENANT_ID, { canonicalName: "Family Tours", partnerType: "AGENCY" }, ACTOR);
  const firstTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "ANIL SHARMA", passportNumber: "P1111111" });
  const secondTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "SITA SHARMA" });
  const crmCase = await createCase(
    context,
    TENANT_ID,
    {
      caseRef: "FAM-1",
      caseType: "VISA",
      visaType: "TOURIST",
      partnerId: partner.partnerId,
      destinationCountry: "JP",
      receivedDate: "2026-09-01",
      applicants: [
        { applicantRef: "A1", travellerId: firstTraveller.travellerId, passportNumber: "P1111111", refNo: "FAM-1-A" },
        { applicantRef: "A2", travellerId: secondTraveller.travellerId },
      ],
    },
    ACTOR,
  );
  return { crmCase, firstTraveller, secondTraveller };
}

describe("updateApplicantDetails", () => {
  it("renames the traveller, changes passport and REF NO, and records one event", async () => {
    const context = await buildSqlTestContext();
    const { crmCase, firstTraveller } = await seedFamilyCase(context);

    const updatedCase = await updateApplicantDetails(
      context,
      TENANT_ID,
      crmCase.caseId,
      "A1",
      { fullName: "ANIL K SHARMA", passportNumber: "P2222222", refNo: "FAM-1-X" },
      ACTOR,
    );

    expect(updatedCase.applicants[0]).toMatchObject({ passportNumber: "P2222222", refNo: "FAM-1-X" });
    const traveller = await getTravellerOrThrow(context, TENANT_ID, firstTraveller.travellerId);
    expect(traveller).toMatchObject({ fullName: "ANIL K SHARMA", passportNumber: "P2222222" });
    expect(await readRefClaim(context, TENANT_ID, "FAM-1-A")).toBeUndefined();
    expect((await readRefClaim(context, TENANT_ID, "FAM-1-X"))?.caseId).toBe(crmCase.caseId);
    const events = await listCaseEvents(context, TENANT_ID, crmCase.caseId);
    const applicantEvent = events.find((event) => event.eventType === "APPLICANT_UPDATED");
    expect(applicantEvent?.meta).toMatchObject({ applicantRef: "A1", changedFields: "fullName,passportNumber,refNo" });
  });

  it("clears a REF NO with null", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    const updatedCase = await updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A1", { refNo: null }, ACTOR);
    expect(updatedCase.applicants[0]?.refNo).toBeUndefined();
  });

  it("refuses a passport on file for a different traveller", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A2", { passportNumber: "P1111111" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a REF NO another applicant on the same case already has", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A2", { refNo: "fam-1-a" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("releases a landed-but-unacked claim when the case write then fails", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    // The earlier attempt's putIfAbsent landed; its response never came back.
    await claimNewRefs(context, TENANT_ID, crmCase.caseId, undefined, { caseRef: "ORPHAN-1", applicants: [] });
    // The case write is one transaction; losing it is what must release the claim.
    const failingContext: SqlTestContext = {
      ...context,
      sql: {
        ...context.sql,
        transaction: async () => {
          throw new Error("write lost");
        },
      },
    };

    await expect(
      updateApplicantDetails(failingContext, TENANT_ID, crmCase.caseId, "A2", { refNo: "ORPHAN-1" }, ACTOR),
    ).rejects.toThrow("write lost");
    expect(await readRefClaim(context, TENANT_ID, "ORPHAN-1")).toBeUndefined();
  });

  it("leaves the traveller untouched when the case change is refused (duplicate REF NO)", async () => {
    const context = await buildSqlTestContext();
    const { crmCase, secondTraveller } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(
        context,
        TENANT_ID,
        crmCase.caseId,
        "A2",
        { fullName: "SITA RENAMED", passportNumber: "P3333333", refNo: "fam-1-a" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const traveller = await getTravellerOrThrow(context, TENANT_ID, secondTraveller.travellerId);
    expect(traveller.fullName).toBe("SITA SHARMA");
    expect(traveller.passportNumber).toBeUndefined();
  });

  it("leaves the traveller untouched when another case holds the REF (409)", async () => {
    const context = await buildSqlTestContext();
    const { crmCase, secondTraveller } = await seedFamilyCase(context);
    await claimNewRefs(context, TENANT_ID, "case_other", undefined, { caseRef: "TAKEN-9", applicants: [] });
    await expect(
      updateApplicantDetails(
        context,
        TENANT_ID,
        crmCase.caseId,
        "A2",
        { fullName: "SITA RENAMED", passportNumber: "P3333333", refNo: "TAKEN-9" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const traveller = await getTravellerOrThrow(context, TENANT_ID, secondTraveller.travellerId);
    expect(traveller.fullName).toBe("SITA SHARMA");
    expect(traveller.passportNumber).toBeUndefined();
  });

  it("stamps the Ledger search haystack with the NEW name and passport (traveller is written after the case)", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await updateApplicantDetails(
      context,
      TENANT_ID,
      crmCase.caseId,
      "A2",
      { fullName: "SITA RENAMED", passportNumber: "P3333333" },
      ACTOR,
    );
    const stored = await context.sql.query<{ search_text: string | null }>(
      `select search_text from crm_cases where tenant_id = $1 and case_id = $2`,
      [TENANT_ID, crmCase.caseId],
    );
    expect(String(stored.rows[0]?.search_text)).toMatch(/SITA RENAMED/i);
    expect(String(stored.rows[0]?.search_text)).toMatch(/P3333333/i);
  });

  it("404s on an unknown applicant", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await expect(
      updateApplicantDetails(context, TENANT_ID, crmCase.caseId, "A9", { refNo: "Z" }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("addApplicant / removeApplicant", () => {
  it("adds a person under the next free applicantRef", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    const newTraveller = await upsertTraveller(context, TENANT_ID, { fullName: "RIYA SHARMA" });

    const updatedCase = await addApplicant(
      context,
      TENANT_ID,
      crmCase.caseId,
      { travellerId: newTraveller.travellerId, refNo: "FAM-1-C" },
      ACTOR,
    );
    expect(updatedCase.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A1", "A2", "A3"]);
    expect(updatedCase.applicants[2]).toMatchObject({ custody: "NOT_HELD", outcome: "PENDING", refNo: "FAM-1-C" });
  });

  it("removes a person, frees their REF NO, and refuses the last one", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);

    const afterRemoval = await removeApplicant(context, TENANT_ID, crmCase.caseId, "A1", ACTOR);
    expect(afterRemoval.applicants.map((applicant) => applicant.applicantRef)).toEqual(["A2"]);
    expect(await readRefClaim(context, TENANT_ID, "FAM-1-A")).toBeUndefined();
    await expect(removeApplicant(context, TENANT_ID, crmCase.caseId, "A2", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses to remove a person whose passport we are holding", async () => {
    const context = await buildSqlTestContext();
    const { crmCase } = await seedFamilyCase(context);
    await changeApplicantCustody(context, TENANT_ID, crmCase.caseId, "A2", "WITH_RGS", ACTOR);
    await expect(removeApplicant(context, TENANT_ID, crmCase.caseId, "A2", ACTOR)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
