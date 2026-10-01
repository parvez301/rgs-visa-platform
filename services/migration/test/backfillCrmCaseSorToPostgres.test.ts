import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { readCase, writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { listCaseEvents, recordCrmEvent } from "@rgs/api/src/domain/crm/crmEvents";
import {
  META_SORT_KEY,
  applicantSortKey,
  casePartitionKey,
  caseStatusGsi1Pk,
  partnerListGsi1Pk,
  partnerPartitionKey,
  refClaimPartitionKey,
  travellerPartitionKey,
} from "@rgs/api/src/domain/crm/keys";
import { getPartnerOrThrow, listPartners } from "@rgs/api/src/domain/crm/partners";
import { claimNewRefs, readRefClaim } from "@rgs/api/src/domain/crm/refClaims";
import { getTravellerOrThrow, upsertTraveller } from "@rgs/api/src/domain/crm/travellers";
import type { AppContext } from "@rgs/api/src/lib/context";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { backfillCrmCaseSorToPostgres } from "../src/backfillCrmCaseSorToPostgres";

function pgliteAsSqlClient(database: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const result = await database.query(text, [...values]);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? 0 };
    },
    async end() {
      await database.close();
    },
  };
}

let clockTick = 0;

function buildDynamoContext(): AppContext & { table: InMemoryTableClient } {
  return {
    table: new InMemoryTableClient(),
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    // Advances per call so every recorded event gets a distinct timestamp.
    now: () => new Date(Date.UTC(2026, 8, 11, 10, 0, 0, 0) + (clockTick += 1) * 1000),
  };
}

/** The same Dynamo-seeded table, read through the Postgres store a cutover would use. */
function postgresViewOf(context: AppContext, sql: SqlClient): AppContext {
  return { ...context, crmStore: "postgres", sql };
}

async function seedPartner(context: AppContext, overrides: Record<string, unknown> = {}): Promise<void> {
  await context.table.put({
    PK: partnerPartitionKey("rgs", "partner_1"),
    SK: META_SORT_KEY,
    GSI1PK: partnerListGsi1Pk("rgs"),
    GSI1SK: "acme travel",
    ...crm.PartnerSchema.parse({
      tenantId: "rgs",
      partnerId: "partner_1",
      canonicalName: "Acme Travel",
      partnerType: "AGENCY",
      aliases: ["Acme"],
      contactEmail: "ops@acme.example",
      contactPhone: "+971500000000",
      notes: "Pays on 30 days",
      createdAt: "2026-03-01T08:00:00.000Z",
      createdByEmail: "owner@rgs.example",
      ...overrides,
    }),
  });
}

/** A case with two applicants, REFs on the case and on one applicant, and one event. */
async function seedTwoApplicantCase(context: AppContext, caseId = "case_1"): Promise<crm.CrmCase> {
  const asha = await upsertTraveller(context, "rgs", {
    fullName: "Asha Rao",
    passportNumber: "M1234567",
    dateOfBirth: "1990-05-01",
    phone: "+919800000000",
  });
  const vikram = await upsertTraveller(context, "rgs", { fullName: "Vikram Rao" });
  const crmCase = crm.CrmCaseSchema.parse({
    tenantId: "rgs",
    caseId,
    caseRef: `RGS-${caseId}`,
    caseType: "VISA",
    visaType: "TOURIST",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "NEW",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-04",
    appointmentDate: "2026-04-01",
    courierDate: "2026-04-10",
    groupName: "Rao family",
    remarks: "Family trip",
    clientEmail: "client@example.com",
    snoozedUntil: "2026-03-20T09:00:00.000Z",
    applicants: [
      {
        applicantRef: "A1",
        refNo: `NO-${caseId}-1`,
        travellerId: asha.travellerId,
        passportNumber: "M1234567",
        custody: "WITH_RGS",
        custodySince: "2026-03-04T11:00:00.000Z",
        outcome: "PENDING",
      },
      {
        applicantRef: "A2",
        travellerId: vikram.travellerId,
        custody: "NOT_HELD",
        outcome: "PENDING",
        courierMode: "DTDC",
        trackingNumber: "TRK-1",
      },
    ],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-05T10:00:00.000Z",
    createdByEmail: "staff@rgs.example",
  });
  await claimNewRefs(context, "rgs", caseId, undefined, crmCase);
  await writeCase(context, crmCase);
  await recordCrmEvent(context, "rgs", caseId, "CASE_CREATED", "staff@rgs.example", { source: "test" });
  return crmCase;
}

/** A raw case that bypasses the writer, so its fields can be made invalid on purpose. */
async function putRawCase(
  context: AppContext,
  caseId: string,
  overrides: Record<string, unknown> = {},
  options: { withApplicant?: boolean } = {},
): Promise<void> {
  await context.table.put({
    PK: casePartitionKey("rgs", caseId),
    SK: META_SORT_KEY,
    GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
    GSI1SK: "2026-03-05T10:00:00.000Z",
    tenantId: "rgs",
    caseId,
    caseRef: `RGS-${caseId}`,
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "NEW",
    billingStatus: "UNKNOWN",
    receivedDate: "2026-03-05",
    totalInr: 0,
    createdAt: "2026-03-05T10:00:00.000Z",
    updatedAt: "2026-03-05T10:00:00.000Z",
    ...overrides,
  });
  if (options.withApplicant === false) return;
  await context.table.put({
    PK: casePartitionKey("rgs", caseId),
    SK: applicantSortKey(0),
    applicantRef: "A1",
    travellerId: "trv_raw",
    custody: "NOT_HELD",
    outcome: "PENDING",
  });
}

async function countRows(sql: SqlClient, tableName: string): Promise<number> {
  const result = await sql.query<{ count: string }>(`select count(*)::text as count from ${tableName}`);
  return Number(result.rows[0]?.count);
}

describe("backfillCrmCaseSorToPostgres", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
  });

  it("applies the migrations itself, including 003, before copying anything", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);

    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const migrations = await sql.query<{ filename: string }>(
      `select filename from schema_migrations order by filename`,
    );
    expect(migrations.rows.map((row) => row.filename)).toContain("003_crm_partners_sor.sql");
  });

  it("round-trips a case with two applicants, its event, travellers, partner and REF claims", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    const dynamoCase = await seedTwoApplicantCase(context);
    const dynamoEvents = await listCaseEvents(context, "rgs", "case_1");
    expect(dynamoEvents).toHaveLength(1);

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result).toEqual({
      partnersUpserted: 1,
      travellersUpserted: 2,
      casesUpserted: 1,
      eventsInserted: 1,
      refClaimsUpserted: 2,
      unreadablePartnerIds: [],
      unreadableCaseIds: [],
      unreadableTravellerIds: [],
      unreadableEventIds: [],
      casesMissingRefClaims: [],
    });

    const postgres = postgresViewOf(context, sql);
    // The domain object a Postgres read returns is what Dynamo returned.
    const fromDynamo = await readCase(context, "rgs", "case_1");
    const fromPostgres = await readCase(postgres, "rgs", "case_1");
    expect(fromPostgres).toEqual(fromDynamo);
    expect(fromPostgres?.applicants).toHaveLength(2);
    expect(fromPostgres?.caseRef).toBe(dynamoCase.caseRef);

    expect(await listCaseEvents(postgres, "rgs", "case_1")).toEqual(dynamoEvents);

    for (const applicant of dynamoCase.applicants) {
      expect(await getTravellerOrThrow(postgres, "rgs", applicant.travellerId)).toEqual(
        await getTravellerOrThrow(context, "rgs", applicant.travellerId),
      );
    }

    expect(await getPartnerOrThrow(postgres, "rgs", "partner_1")).toEqual(
      await getPartnerOrThrow(context, "rgs", "partner_1"),
    );

    for (const refValue of ["RGS-case_1", "NO-case_1-1"]) {
      const refKey = refValue.toUpperCase();
      expect(await readRefClaim(postgres, "rgs", refKey)).toEqual(
        await readRefClaim(context, "rgs", refKey),
      );
    }

    // searchText and applicantSummary are the writer's, derived from the copied travellers.
    const searchRow = await sql.query<{ search_text: string; applicant_summary: { count: number } }>(
      `select search_text, applicant_summary from crm_cases where case_id = 'case_1'`,
    );
    expect(searchRow.rows[0]?.search_text).toContain("asha rao");
    expect(searchRow.rows[0]?.search_text).toContain("vikram rao");
    expect(searchRow.rows[0]?.applicant_summary).toMatchObject({ count: 2 });
  });

  it("is idempotent: a second run changes no row counts and duplicates no event", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context);

    const firstRun = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });
    const countsAfterFirstRun = {
      cases: await countRows(sql, "crm_cases"),
      applicants: await countRows(sql, "crm_applicants"),
      events: await countRows(sql, "crm_events"),
      travellers: await countRows(sql, "crm_travellers"),
      partners: await countRows(sql, "crm_partners"),
      refClaims: await countRows(sql, "crm_ref_claims"),
    };
    const secondRun = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(countsAfterFirstRun).toEqual({
      cases: 1,
      applicants: 2,
      events: 1,
      travellers: 2,
      partners: 1,
      refClaims: 2,
    });
    expect({
      cases: await countRows(sql, "crm_cases"),
      applicants: await countRows(sql, "crm_applicants"),
      events: await countRows(sql, "crm_events"),
      travellers: await countRows(sql, "crm_travellers"),
      partners: await countRows(sql, "crm_partners"),
      refClaims: await countRows(sql, "crm_ref_claims"),
    }).toEqual(countsAfterFirstRun);
    expect(secondRun).toMatchObject({ casesUpserted: 1, unreadableCaseIds: [] });
    // The event was already there, so the re-run inserted none.
    expect(firstRun.eventsInserted).toBe(1);
    expect(secondRun.eventsInserted).toBe(0);
  });

  it("re-run restores a drifted case row and its applicants", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context);
    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    await sql.query(`update crm_cases set case_ref = 'STALE'`);
    await sql.query(`delete from crm_applicants where applicant_ref = 'A2'`);
    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(await readCase(postgresViewOf(context, sql), "rgs", "case_1")).toEqual(
      await readCase(context, "rgs", "case_1"),
    );
  });

  it("never deletes or rewrites an event recorded in Postgres after the first run", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context);
    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });
    const postgres = postgresViewOf(context, sql);
    await recordCrmEvent(postgres, "rgs", "case_1", "CASE_UPDATED", "staff@rgs.example", { after: "cutover" });

    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const events = await listCaseEvents(postgres, "rgs", "case_1");
    expect(events.map((event) => event.eventType)).toEqual(["CASE_CREATED", "CASE_UPDATED"]);
  });

  it("fills the full partner record over a Phase A ledger-only partner row", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context);
    await applyMigrations(sql);
    // What the Phase A (ledger-only) backfill wrote before migration 003 columns were filled.
    await sql.query(
      `insert into crm_partners (tenant_id, partner_id, canonical_name, contact_email, updated_at)
       values ('rgs', 'partner_1', 'Acme Travel', 'old@acme.example', now())`,
    );
    const postgres = postgresViewOf(context, sql);
    await expect(getPartnerOrThrow(postgres, "rgs", "partner_1")).rejects.toThrow();

    await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const partner = await getPartnerOrThrow(postgres, "rgs", "partner_1");
    expect(partner).toMatchObject({
      partnerType: "AGENCY",
      aliases: ["Acme"],
      contactEmail: "ops@acme.example",
      contactPhone: "+971500000000",
      notes: "Pays on 30 days",
      createdByEmail: "owner@rgs.example",
    });
    expect((await listPartners(postgres, "rgs")).unreadablePartnerIds).toEqual([]);
  });

  it("names an unreadable case (META with no applicants) and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context, "case_good");
    await putRawCase(context, "case_bare", {}, { withApplicant: false });

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableCaseIds).toEqual(["case_bare"]);
    expect(result.casesUpserted).toBe(1);
    const rows = await sql.query<{ case_id: string }>(`select case_id from crm_cases`);
    expect(rows.rows).toEqual([{ case_id: "case_good" }]);
    warn.mockRestore();
  });

  it("names an unreadable partner and does not insert it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await context.table.put({
      PK: partnerPartitionKey("rgs", "partner_bad"),
      SK: META_SORT_KEY,
      GSI1PK: partnerListGsi1Pk("rgs"),
      GSI1SK: "bad",
      tenantId: "rgs",
      partnerId: "partner_bad",
    });

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadablePartnerIds).toEqual(["partner_bad"]);
    expect(result.partnersUpserted).toBe(1);
    const rows = await sql.query<{ partner_id: string }>(`select partner_id from crm_partners`);
    expect(rows.rows).toEqual([{ partner_id: "partner_1" }]);
    warn.mockRestore();
  });

  describe("cases Postgres would reject", () => {
    it.each([
      ["receivedDate", { receivedDate: "2026-02-30" }],
      ["courierDate", { courierDate: "2026-04-31" }],
      ["totalInr", { totalInr: 2_147_483_648 }],
    ])("names a case with an impossible %s, leaves no partial rows, and keeps going", async (_field, overrides) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const context = buildDynamoContext();
      await seedPartner(context);
      await putRawCase(context, "case_bad", overrides);
      await seedTwoApplicantCase(context, "case_good");

      const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

      expect(result.unreadableCaseIds).toEqual(["case_bad"]);
      expect(result.casesUpserted).toBe(1);
      const cases = await sql.query<{ case_id: string }>(`select case_id from crm_cases`);
      expect(cases.rows).toEqual([{ case_id: "case_good" }]);
      const orphanApplicants = await sql.query(`select 1 from crm_applicants where case_id = 'case_bad'`);
      expect(orphanApplicants.rows).toEqual([]);
      warn.mockRestore();
    });
  });

  it("names a traveller that is missing in Dynamo but still copies the case", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await putRawCase(context, "case_orphan"); // applicant points at trv_raw, which does not exist

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableTravellerIds).toEqual(["trv_raw"]);
    expect(result.casesUpserted).toBe(1);
    warn.mockRestore();
  });

  it("names a traveller item that will not parse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await putRawCase(context, "case_x");
    await context.table.put({
      PK: travellerPartitionKey("rgs", "trv_raw"),
      SK: META_SORT_KEY,
      travellerId: "trv_raw",
      tenantId: "rgs",
    });

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableTravellerIds).toEqual(["trv_raw"]);
    expect(await countRows(sql, "crm_travellers")).toBe(0);
    warn.mockRestore();
  });

  it("names a case whose traveller shares a passport with a different traveller, and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context, "case_good");
    // Legacy duplicate: Dynamo never enforced passport uniqueness, only the app-level check.
    const duplicateHolder = crm.CrmTravellerSchema.parse({
      tenantId: "rgs",
      travellerId: "trv_dupe",
      fullName: "Asha R",
      normalizedName: "ASHA R",
      passportNumber: "M1234567",
      createdAt: "2026-03-09T00:00:00.000Z",
    });
    await context.table.put({
      PK: travellerPartitionKey("rgs", "trv_dupe"),
      SK: META_SORT_KEY,
      ...duplicateHolder,
    });
    // Later GSI1SK than case_good, so the good case is copied first and keeps the passport.
    await putRawCase(context, "case_dupe", { GSI1SK: "2026-03-09T10:00:00.000Z" }, { withApplicant: false });
    await context.table.put({
      PK: casePartitionKey("rgs", "case_dupe"),
      SK: applicantSortKey(0),
      applicantRef: "A1",
      travellerId: "trv_dupe",
      passportNumber: "M1234567",
      custody: "NOT_HELD",
      outcome: "PENDING",
    });

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableCaseIds).toEqual(["case_dupe"]);
    expect(result.casesUpserted).toBe(1);
    const rows = await sql.query<{ case_id: string }>(`select case_id from crm_cases`);
    expect(rows.rows).toEqual([{ case_id: "case_good" }]);
    warn.mockRestore();
  });

  it("copies a REF claim held by another case as it is, and names cases with no claim", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context, "case_1");
    // case_legacy was written before REF uniqueness: no claim of its own.
    await putRawCase(context, "case_legacy");
    await context.table.put({
      PK: refClaimPartitionKey("rgs", "RGS-CASE_LEGACY"),
      SK: META_SORT_KEY,
      tenantId: "rgs",
      refKey: "RGS-CASE_LEGACY",
      refValue: "RGS-case_legacy",
      caseId: "case_other",
      claimedAt: "2026-02-01T00:00:00.000Z",
    });
    await putRawCase(context, "case_noclaim");

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const legacyClaim = await readRefClaim(postgresViewOf(context, sql), "rgs", "RGS-CASE_LEGACY");
    expect(legacyClaim?.caseId).toBe("case_other");
    expect(result.casesMissingRefClaims).toEqual(["case_noclaim"]);
    expect(result.casesUpserted).toBe(3);
    warn.mockRestore();
  });

  it("names an event item it cannot read and copies the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context);
    await context.table.put({
      PK: casePartitionKey("rgs", "case_1"),
      SK: "EVENT#2026-03-06T00:00:00.000Z#crmevt_broken",
      eventId: "crmevt_broken",
      caseId: "case_1",
    });

    const result = await backfillCrmCaseSorToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableEventIds).toEqual(["crmevt_broken"]);
    expect(result.eventsInserted).toBe(1);
    expect(await countRows(sql, "crm_events")).toBe(1);
    warn.mockRestore();
  });

  it("reports progress once per copied case", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context, "case_1");
    await seedTwoApplicantCase(context, "case_2");
    const progress: number[] = [];

    await backfillCrmCaseSorToPostgres({
      table: context.table,
      sql,
      tenantId: "rgs",
      onProgress: (casesUpserted) => progress.push(casesUpserted),
    });

    expect(progress).toEqual([1, 2]);
  });

  it("copies cases one at a time (the shared connection runs one transaction at once)", async () => {
    const context = buildDynamoContext();
    await seedPartner(context);
    await seedTwoApplicantCase(context, "case_1");
    await seedTwoApplicantCase(context, "case_2");
    let openTransactions = 0;
    let maxConcurrentTransactions = 0;
    const observingSql: SqlClient = {
      async query(text, values) {
        if (text === "BEGIN") {
          openTransactions += 1;
          maxConcurrentTransactions = Math.max(maxConcurrentTransactions, openTransactions);
        }
        if (text === "COMMIT" || text === "ROLLBACK") openTransactions -= 1;
        return sql.query(text, values);
      },
      end: () => sql.end(),
    };

    await backfillCrmCaseSorToPostgres({ table: context.table, sql: observingSql, tenantId: "rgs" });

    expect(maxConcurrentTransactions).toBe(1);
  });
});
