import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import type { SqlClient } from "../../src/lib/sql";
import { pgliteAsSqlClient } from "../pgliteSqlClient";
import { buildCaseExportRows } from "../../src/domain/crm/caseExport";
import { createCase } from "../../src/domain/crm/cases";
import { createPartner } from "../../src/domain/crm/partners";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { buildTestContext } from "../helpers";

describe("buildCaseExportRows", () => {
  it("returns one row per applicant in the order asked, with partner and traveller names, and lists missing ids", async () => {
    const context = buildTestContext();
    const partner = await createPartner(context, "rgs", { canonicalName: "Export Tours", partnerType: "AGENCY" }, "desk@rgs.local");
    const firstTraveller = await upsertTraveller(context, "rgs", { fullName: "MEERA IYER", passportNumber: "M1234567" });
    const secondTraveller = await upsertTraveller(context, "rgs", { fullName: "RAJ IYER" });
    const familyCase = await createCase(
      context,
      "rgs",
      {
        caseRef: "EXP-1",
        caseType: "VISA",
        visaType: "TOURIST",
        partnerId: partner.partnerId,
        destinationCountry: "JP",
        receivedDate: "2026-09-01",
        remarks: "priority",
        groupName: "Iyer Family",
        clientEmail: "meera@example.com",
        applicants: [
          { applicantRef: "A1", travellerId: firstTraveller.travellerId, passportNumber: "M1234567", refNo: "EXP-1-A" },
          { applicantRef: "A2", travellerId: secondTraveller.travellerId },
        ],
      },
      "desk@rgs.local",
    );

    const exportResult = await buildCaseExportRows(context, "rgs", [familyCase.caseId, "case_missing"]);

    expect(exportResult.missingCaseIds).toEqual(["case_missing"]);
    expect(exportResult.rows).toHaveLength(2);
    expect(exportResult.rows[0]).toMatchObject({
      caseRef: "EXP-1",
      groupName: "Iyer Family",
      partnerName: "Export Tours",
      destinationCountry: "JP",
      caseStatus: "NEW",
      remarks: "priority",
      clientEmail: "meera@example.com",
      applicantRefNo: "EXP-1-A",
      applicantName: "MEERA IYER",
      passportNumber: "M1234567",
      custody: "NOT_HELD",
      outcome: "PENDING",
    });
    expect(exportResult.rows[1]).toMatchObject({ applicantRefNo: "A2", applicantName: "RAJ IYER" });
  });

  it("reads serially and batches travellers under CRM_STORE=postgres (one pooled connection)", async () => {
    const database = pgliteAsSqlClient(new PGlite());
    await applyMigrations(database);
    let inFlight = 0;
    let maxInFlight = 0;
    let travellerQueries = 0;
    const observed: SqlClient = {
      async query(text, values) {
        if (text.includes("from crm_travellers") && text.includes("any($2")) travellerQueries += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await database.query(text, values);
        } finally {
          inFlight -= 1;
        }
      },
      transaction: (work) => database.transaction(work),
      end: () => database.end(),
    };
    const context = { ...buildTestContext(), crmStore: "postgres" as const, sql: observed };
    const partner = await createPartner(context, "rgs", { canonicalName: "Export Tours" }, "desk@rgs.local");
    const caseIds: string[] = [];
    for (let caseNumber = 0; caseNumber < 6; caseNumber += 1) {
      const first = await upsertTraveller(context, "rgs", { fullName: `FIRST ${caseNumber}` });
      const second = await upsertTraveller(context, "rgs", { fullName: `SECOND ${caseNumber}` });
      const created = await createCase(
        context,
        "rgs",
        {
          caseRef: `EXP-PG-${caseNumber}`,
          caseType: "VISA",
          visaType: "TOURIST",
          partnerId: partner.partnerId,
          destinationCountry: "JP",
          receivedDate: "2026-09-01",
          applicants: [
            { applicantRef: "A1", travellerId: first.travellerId },
            { applicantRef: "A2", travellerId: second.travellerId },
          ],
        },
        "desk@rgs.local",
      );
      caseIds.push(created.caseId);
    }
    maxInFlight = 0;
    travellerQueries = 0;

    const exportResult = await buildCaseExportRows(context, "rgs", caseIds);

    expect(exportResult.missingCaseIds).toEqual([]);
    expect(exportResult.rows).toHaveLength(12);
    expect(exportResult.rows[0]).toMatchObject({ applicantName: "FIRST 0" });
    expect(exportResult.rows[1]).toMatchObject({ applicantName: "SECOND 0" });
    expect(maxInFlight).toBe(1);
    // One batched traveller lookup per case, not one per applicant.
    expect(travellerQueries).toBe(6);
  });
});

