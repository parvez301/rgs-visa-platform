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

/** PGlite boot + migrations + seeding is slow under a loaded full-suite run. */
const PGLITE_TEST_TIMEOUT_MS = 60_000;

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

  async function seedPostgresExport(caseCount: number) {
    const database = pgliteAsSqlClient(new PGlite());
    await applyMigrations(database);
    let inFlight = 0;
    let maxInFlight = 0;
    const statements: string[] = [];
    const observed: SqlClient = {
      async query(text, values) {
        statements.push(text);
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
    for (let caseNumber = 0; caseNumber < caseCount; caseNumber += 1) {
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
    return { context, database, caseIds, statements, peakInFlight: () => maxInFlight, resetPeak: () => (maxInFlight = 0) };
  }

  it("loads the whole export set in a constant number of queries under CRM_STORE=postgres", async () => {
    const small = await seedPostgresExport(3);
    const large = await seedPostgresExport(8);
    const queriesFor = async (seed: Awaited<ReturnType<typeof seedPostgresExport>>) => {
      seed.statements.length = 0;
      seed.resetPeak();
      const result = await buildCaseExportRows(seed.context, "rgs", seed.caseIds);
      return { result, queryCount: seed.statements.length };
    };

    const smallRun = await queriesFor(small);
    const largeRun = await queriesFor(large);

    expect(largeRun.result.missingCaseIds).toEqual([]);
    expect(largeRun.result.rows).toHaveLength(16);
    expect(largeRun.result.rows[0]).toMatchObject({ applicantName: "FIRST 0", partnerName: "Export Tours" });
    expect(largeRun.result.rows[1]).toMatchObject({ applicantName: "SECOND 0" });
    expect(largeRun.result.rows[15]).toMatchObject({ applicantName: "SECOND 7" });
    // partner list + cases + applicants + travellers, whatever the case count.
    expect(smallRun.queryCount).toBe(4);
    expect(largeRun.queryCount).toBe(4);
    expect(large.peakInFlight()).toBe(1);
    expect(large.statements.filter((text) => text.includes("from crm_travellers"))).toHaveLength(1);
  }, PGLITE_TEST_TIMEOUT_MS);

  it("names missing and unreadable ids without sinking the batch, and ignores other tenants (postgres)", async () => {
    const seed = await seedPostgresExport(2);
    const [corruptId, goodId] = seed.caseIds as [string, string];
    // A case row with no applicants cannot parse: CorruptRecordError territory.
    await seed.database.query(`delete from crm_applicants where tenant_id = 'rgs' and case_id = $1`, [corruptId]);

    const exportResult = await buildCaseExportRows(seed.context, "rgs", [corruptId, goodId, "case_gone"]);
    expect(exportResult.missingCaseIds).toEqual([corruptId, "case_gone"]);
    expect(exportResult.rows.map((row) => row.caseRef)).toEqual(["EXP-PG-1", "EXP-PG-1"]);

    const otherTenant = await buildCaseExportRows(seed.context, "other", [goodId]);
    expect(otherTenant.rows).toEqual([]);
    expect(otherTenant.missingCaseIds).toEqual([goodId]);
  }, PGLITE_TEST_TIMEOUT_MS);

  it("repeats rows for a repeated id, in request order (postgres)", async () => {
    const seed = await seedPostgresExport(2);
    const [firstId, secondId] = seed.caseIds as [string, string];

    const exportResult = await buildCaseExportRows(seed.context, "rgs", [secondId, firstId, secondId]);

    expect(exportResult.rows.map((row) => row.caseRef)).toEqual([
      "EXP-PG-1", "EXP-PG-1", "EXP-PG-0", "EXP-PG-0", "EXP-PG-1", "EXP-PG-1",
    ]);
  }, PGLITE_TEST_TIMEOUT_MS);
});
