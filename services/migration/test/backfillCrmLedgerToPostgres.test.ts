import { PGlite } from "@electric-sql/pglite";
import { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@rgs/api/src/db/migrate";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import {
  META_SORT_KEY,
  casePartitionKey,
  caseStatusGsi1Pk,
  partnerListGsi1Pk,
  partnerPartitionKey,
} from "@rgs/api/src/domain/crm/keys";
import { upsertTraveller } from "@rgs/api/src/domain/crm/travellers";
import type { AppContext } from "@rgs/api/src/lib/context";
import { InMemoryTableClient } from "@rgs/api/src/lib/db";
import type { SqlClient } from "@rgs/api/src/lib/sql";
import { backfillCrmLedgerToPostgres } from "../src/backfillCrmLedgerToPostgres";
import { pgliteAsSqlClient } from "@rgs/api/test/pgliteSqlClient";

function buildContext(): AppContext & { table: InMemoryTableClient } {
  return {
    table: new InMemoryTableClient(),
    documents: undefined as never,
    email: undefined as never,
    adminNotificationAddress: "info@raysglobalservices.com",
    now: () => new Date("2026-09-11T10:00:00.000Z"),
  };
}

async function seedCase(context: AppContext, caseId: string): Promise<void> {
  const asha = await upsertTraveller(context, "rgs", {
    fullName: "Asha Rao",
    passportNumber: "M1234567",
  });
  await writeCase(
    context,
    crm.CrmCaseSchema.parse({
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
      groupName: "Rao family",
      applicants: [
        {
          applicantRef: "A1",
          travellerId: asha.travellerId,
          custody: "WITH_RGS",
          outcome: "PENDING",
        },
      ],
      createdAt: "2026-03-04T10:00:00.000Z",
      updatedAt: "2026-03-04T10:00:00.000Z",
    }),
  );
}

async function seedPartner(context: AppContext): Promise<void> {
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
      contactEmail: "ops@acme.example",
      createdAt: "2026-03-01T08:00:00.000Z",
    }),
  });
}

describe("backfillCrmLedgerToPostgres", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
  });

  it("upserts a projected META row and a second run does not duplicate it", async () => {
    const context = buildContext();
    await seedCase(context, "case_1");
    await seedPartner(context);

    const firstRun = await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });
    const secondRun = await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(firstRun).toMatchObject({ partnersUpserted: 1, casesUpserted: 1, unreadableCaseIds: [] });
    expect(secondRun).toMatchObject({ partnersUpserted: 1, casesUpserted: 1, unreadableCaseIds: [] });
    const caseCount = await sql.query<{ count: string }>(`select count(*)::text as count from crm_cases`);
    const partnerCount = await sql.query<{ count: string }>(`select count(*)::text as count from crm_partners`);
    expect(caseCount.rows[0]?.count).toBe("1");
    expect(partnerCount.rows[0]?.count).toBe("1");
  });

  it("projects every ledger column into the row", async () => {
    const context = buildContext();
    await seedCase(context, "case_1");
    await seedPartner(context);

    await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const caseRows = await sql.query<Record<string, unknown>>(
      `select tenant_id, case_id, case_ref, partner_id, destination_country, case_type, visa_type,
              group_name, case_status, billing_status, to_char(received_date, 'YYYY-MM-DD') as received_date,
              to_char(appointment_date, 'YYYY-MM-DD') as appointment_date, expected_collection_date,
              total_inr, applicant_summary, search_text
         from crm_cases`,
    );
    expect(caseRows.rows[0]).toMatchObject({
      tenant_id: "rgs",
      case_id: "case_1",
      case_ref: "RGS-case_1",
      partner_id: "partner_1",
      destination_country: "AE",
      case_type: "VISA",
      visa_type: "TOURIST",
      group_name: "Rao family",
      case_status: "NEW",
      billing_status: "UNKNOWN",
      received_date: "2026-03-04",
      appointment_date: "2026-04-01",
      expected_collection_date: null,
      total_inr: 0,
      search_text: "asha rao m1234567 rao family",
    });
    expect(caseRows.rows[0]?.["applicant_summary"]).toMatchObject({ count: 1 });

    const partnerRows = await sql.query<Record<string, unknown>>(
      `select tenant_id, partner_id, canonical_name, contact_email from crm_partners`,
    );
    expect(partnerRows.rows[0]).toEqual({
      tenant_id: "rgs",
      partner_id: "partner_1",
      canonical_name: "Acme Travel",
      contact_email: "ops@acme.example",
    });

    // The full Partner record lands too, so CRM_STORE=postgres can read it.
    const fullPartnerRows = await sql.query<Record<string, unknown>>(
      `select canonical_key, partner_type, aliases, contact_phone, notes, created_at from crm_partners`,
    );
    expect(fullPartnerRows.rows[0]).toMatchObject({
      canonical_key: "ACME TRAVEL",
      partner_type: "AGENCY",
      aliases: [],
      contact_phone: null,
      notes: null,
    });
    expect(new Date(String(fullPartnerRows.rows[0]?.["created_at"])).toISOString()).toBe(
      "2026-03-01T08:00:00.000Z",
    );
  });

  it("overwrites a stale row on re-run", async () => {
    const context = buildContext();
    await seedCase(context, "case_1");
    await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });

    await sql.query(`update crm_cases set case_ref = 'STALE'`);
    await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });

    const rows = await sql.query<{ case_ref: string }>(`select case_ref from crm_cases`);
    expect(rows.rows).toEqual([{ case_ref: "RGS-case_1" }]);
  });

  it("names a corrupt META (missing caseRef) in unreadableCaseIds and does not insert it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = buildContext();
    await seedCase(context, "case_1");
    await context.table.put({
      PK: casePartitionKey("rgs", "case_bad"),
      SK: META_SORT_KEY,
      GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
      GSI1SK: "2026-03-05T10:00:00.000Z",
      caseId: "case_bad",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseType: "VISA",
      caseStatus: "NEW",
      billingStatus: "UNKNOWN",
      receivedDate: "2026-03-05",
      totalInr: 0,
      updatedAt: "2026-03-05T10:00:00.000Z",
    });

    const result = await backfillCrmLedgerToPostgres({ table: context.table, sql, tenantId: "rgs" });

    expect(result.unreadableCaseIds).toEqual(["case_bad"]);
    expect(result.casesUpserted).toBe(1);
    const rows = await sql.query<{ case_id: string }>(`select case_id from crm_cases`);
    expect(rows.rows).toEqual([{ case_id: "case_1" }]);
    warn.mockRestore();
  });

  describe("rows that parse but Postgres would reject", () => {
    async function putRawCase(
      context: AppContext,
      caseId: string,
      overrides: Record<string, unknown>,
    ): Promise<void> {
      await context.table.put({
        PK: casePartitionKey("rgs", caseId),
        SK: META_SORT_KEY,
        GSI1PK: caseStatusGsi1Pk("rgs", "NEW"),
        GSI1SK: "2026-03-05T10:00:00.000Z",
        caseId,
        caseRef: `RGS-${caseId}`,
        partnerId: "partner_1",
        destinationCountry: "AE",
        caseType: "VISA",
        caseStatus: "NEW",
        billingStatus: "UNKNOWN",
        receivedDate: "2026-03-05",
        totalInr: 0,
        updatedAt: "2026-03-05T10:00:00.000Z",
        ...overrides,
      });
    }

    it.each([
      ["receivedDate", { receivedDate: "2026-02-30" }],
      ["appointmentDate", { appointmentDate: "2026-13-01" }],
      ["expectedCollectionDate", { expectedCollectionDate: "2026-04-31" }],
      ["totalInr", { totalInr: 2_147_483_648 }],
    ])("names a case with an impossible %s and keeps going", async (_field, overrides) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const context = buildContext();
      await putRawCase(context, "case_bad", overrides);
      await seedCase(context, "case_good");

      const result = await backfillCrmLedgerToPostgres({
        table: context.table,
        sql,
        tenantId: "rgs",
      });

      expect(result.unreadableCaseIds).toEqual(["case_bad"]);
      expect(result.casesUpserted).toBe(1);
      const rows = await sql.query<{ case_id: string }>(`select case_id from crm_cases`);
      expect(rows.rows).toEqual([{ case_id: "case_good" }]);
      warn.mockRestore();
    });

    it("still writes a case at the integer ceiling", async () => {
      const context = buildContext();
      await putRawCase(context, "case_max", { totalInr: 2_147_483_647 });

      const result = await backfillCrmLedgerToPostgres({
        table: context.table,
        sql,
        tenantId: "rgs",
      });

      expect(result).toMatchObject({ casesUpserted: 1, unreadableCaseIds: [] });
    });
  });
});
