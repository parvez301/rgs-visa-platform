import { PGlite } from "@electric-sql/pglite";
import type { crm } from "@rgs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { readCase, writeCase } from "../../src/domain/crm/caseStore";
import { readCasePostgres, writeCasePostgres } from "../../src/domain/crm/caseStorePostgres";
import { casePartitionKey } from "../../src/domain/crm/keys";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { CorruptRecordError } from "../../src/lib/errors";
import type { SqlClient } from "../../src/lib/sql";
import { buildTestContext } from "../helpers";

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

function buildCase(overrides: Partial<crm.CrmCase> = {}): crm.CrmCase {
  return {
    tenantId: "rgs",
    caseId: "case_1",
    caseRef: "31377",
    caseType: "VISA",
    partnerId: "partner_1",
    destinationCountry: "BH",
    visaType: "EVISA_TOURIST",
    entryType: "SINGLE",
    processing: "NORMAL",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-02",
    lineItems: [],
    totalInr: 0,
    documentChecklist: [],
    watchdogOverrides: {},
    mutedRules: [],
    applicants: [
      { applicantRef: "31377", travellerId: "trv_1", custody: "NOT_HELD", outcome: "PENDING" },
      { applicantRef: "31378", travellerId: "trv_2", custody: "NOT_HELD", outcome: "PENDING" },
    ],
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    ...overrides,
  } as crm.CrmCase;
}

function applicant(ref: string, overrides: Partial<crm.CaseApplicant> = {}): crm.CaseApplicant {
  return {
    applicantRef: ref,
    travellerId: `trv_${ref}`,
    custody: "NOT_HELD",
    outcome: "PENDING",
    ...overrides,
  };
}

async function seedTraveller(
  sql: SqlClient,
  travellerId: string,
  fullName: string,
  passportNumber: string | null,
): Promise<void> {
  await sql.query(
    `insert into crm_travellers (tenant_id, traveller_id, full_name, normalized_name, passport_number, created_at)
     values ('rgs', $1, $2, $3, $4, '2026-01-01T00:00:00.000Z')`,
    [travellerId, fullName, fullName.toLowerCase(), passportNumber],
  );
}

describe("caseStorePostgres", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
  });

  it("returns undefined for a case that does not exist", async () => {
    expect(await readCasePostgres(sql, "rgs", "nope")).toBeUndefined();
  });

  it("round-trips a minimal case", async () => {
    const original = buildCase();
    await writeCasePostgres(sql, original);
    expect(await readCasePostgres(sql, "rgs", "case_1")).toEqual(original);
  });

  it("round-trips every optional case and applicant field", async () => {
    const original = buildCase({
      validity: "30 days",
      groupName: "Sharma Family",
      clientEmail: "client@example.com",
      remarks: "Rush",
      submissionDate: "2026-01-03",
      appointmentDate: "2026-02-01",
      appointmentReminderSentFor: "2026-01-31",
      expectedCollectionDate: "2026-02-10",
      courierDate: "2026-02-11",
      lineItems: [
        { code: "VISA_FEE", label: "Visa fee", amountInr: 2500, quantity: 2, kind: "GOVT_FEE" },
      ],
      totalInr: 5000,
      documentChecklist: [{ label: "Passport copy", state: "RECEIVED" }],
      watchdogOverrides: { case_quiet: 9 },
      mutedRules: ["billing_overdue"],
      snoozedUntil: "2026-03-01T00:00:00.000Z",
      sourceSheet: "March",
      sourceRow: 42,
      legacyRaw: { COL_A: "x", COL_B: "y" },
      createdByEmail: "desk@rgs.test",
      applicants: [
        applicant("A1", {
          refNo: "R-1",
          passportNumber: "P1234567",
          custody: "WITH_RGS",
          custodySince: "2026-01-04T08:30:00.000Z",
          outcome: "APPROVED",
          courierMode: "DTDC",
          trackingNumber: "TRK1",
          visaResultKey: "results/a1.pdf",
        }),
        applicant("A2"),
      ],
    } as Partial<crm.CrmCase>);
    await writeCasePostgres(sql, original);
    expect(await readCasePostgres(sql, "rgs", "case_1")).toEqual(original);
  });

  it("overwrites an existing case in place", async () => {
    await writeCasePostgres(sql, buildCase({ remarks: "first" }));
    await writeCasePostgres(
      sql,
      buildCase({ remarks: "second", caseStatus: "SUBMITTED", updatedAt: "2026-01-05T00:00:00.000Z" }),
    );
    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread).toMatchObject({
      remarks: "second",
      caseStatus: "SUBMITTED",
      updatedAt: "2026-01-05T00:00:00.000Z",
    });
    const rows = await sql.query(`select 1 from crm_cases`);
    expect(rows.rows).toHaveLength(1);
  });

  it("clears an optional field that is dropped on a later write", async () => {
    await writeCasePostgres(sql, buildCase({ remarks: "temp", appointmentDate: "2026-02-01" }));
    await writeCasePostgres(sql, buildCase());
    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread).not.toHaveProperty("remarks");
    expect(reread).not.toHaveProperty("appointmentDate");
  });

  it("deletes ghost applicants when the case shrinks", async () => {
    await writeCasePostgres(
      sql,
      buildCase({ applicants: [applicant("A1"), applicant("A2"), applicant("A3")] }),
    );
    await writeCasePostgres(sql, buildCase({ applicants: [applicant("A1")] }));

    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread?.applicants.map((entry) => entry.applicantRef)).toEqual(["A1"]);
    const rows = await sql.query(`select applicant_index from crm_applicants order by 1`);
    expect(rows.rows).toEqual([{ applicant_index: 0 }]);
  });

  it("handles an applicant removed from the middle without a ref collision", async () => {
    await writeCasePostgres(
      sql,
      buildCase({ applicants: [applicant("A1"), applicant("A2"), applicant("A3")] }),
    );
    await writeCasePostgres(sql, buildCase({ applicants: [applicant("A1"), applicant("A3")] }));
    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread?.applicants.map((entry) => entry.applicantRef)).toEqual(["A1", "A3"]);
  });

  it("preserves applicant order", async () => {
    await writeCasePostgres(
      sql,
      buildCase({ applicants: [applicant("Z"), applicant("M"), applicant("A")] }),
    );
    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread?.applicants.map((entry) => entry.applicantRef)).toEqual(["Z", "M", "A"]);
  });

  it("recomputes applicantSummary from the applicants on every write", async () => {
    await writeCasePostgres(
      sql,
      buildCase({
        applicants: [applicant("A1", { custody: "WITH_RGS" }), applicant("A2")],
      }),
    );
    const first = await sql.query<{ applicant_summary: unknown }>(
      `select applicant_summary from crm_cases`,
    );
    expect(first.rows[0]?.applicant_summary).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, NOT_HELD: 1 },
      outcome: { PENDING: 2 },
    });

    await writeCasePostgres(sql, buildCase({ applicants: [applicant("A1", { outcome: "APPROVED" })] }));
    const second = await sql.query<{ applicant_summary: unknown }>(
      `select applicant_summary from crm_cases`,
    );
    expect(second.rows[0]?.applicant_summary).toEqual({
      count: 1,
      custody: { NOT_HELD: 1 },
      outcome: { APPROVED: 1 },
    });
  });

  it("builds searchText from crm_travellers, applicant passports and the group name", async () => {
    await seedTraveller(sql, "trv_A1", "Asha Sharma", "P111");
    await writeCasePostgres(
      sql,
      buildCase({
        groupName: "Sharma Family",
        applicants: [applicant("A1"), applicant("A2", { passportNumber: "P222" })],
      }),
    );
    const row = await sql.query<{ search_text: string | null }>(`select search_text from crm_cases`);
    expect(row.rows[0]?.search_text).toBe("asha sharma p111 p222 sharma family");
  });

  it("clears a stale searchText when nothing searchable remains", async () => {
    await writeCasePostgres(
      sql,
      buildCase({ applicants: [applicant("A1", { passportNumber: "P111" })] }),
    );
    await writeCasePostgres(sql, buildCase({ applicants: [applicant("A1")] }));
    const row = await sql.query<{ search_text: string | null }>(`select search_text from crm_cases`);
    expect(row.rows[0]?.search_text).toBeNull();
  });

  it("uses a supplied searchTextResolver instead of crm_travellers", async () => {
    await writeCasePostgres(sql, buildCase(), {
      searchTextResolver: async () => "from resolver",
    });
    const row = await sql.query<{ search_text: string | null }>(`select search_text from crm_cases`);
    expect(row.rows[0]?.search_text).toBe("from resolver");
  });

  it("rolls back the whole write when an applicant insert fails", async () => {
    await writeCasePostgres(sql, buildCase({ remarks: "original" }));
    // Duplicate applicantRef violates unique (tenant_id, case_id, applicant_ref).
    await expect(
      writeCasePostgres(
        sql,
        buildCase({ remarks: "broken", applicants: [applicant("DUP"), applicant("DUP")] }),
      ),
    ).rejects.toThrow();

    const reread = await readCasePostgres(sql, "rgs", "case_1");
    expect(reread?.remarks).toBe("original");
    expect(reread?.applicants.map((entry) => entry.applicantRef)).toEqual(["31377", "31378"]);
  });

  it("scopes reads by tenant", async () => {
    await writeCasePostgres(sql, buildCase());
    expect(await readCasePostgres(sql, "other", "case_1")).toBeUndefined();
  });

  it("reads a Phase A row with NULL created_at, falling back to updated_at", async () => {
    await sql.query(
      `insert into crm_cases (
         tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
         case_status, billing_status, received_date, total_inr, updated_at
       ) values ('rgs','legacy_1','L1','partner_1','AE','OTHER','NEW','UNKNOWN','2026-03-04',0,'2026-03-05T06:07:08.009Z')`,
    );
    await sql.query(
      `insert into crm_applicants (tenant_id, case_id, applicant_index, applicant_ref, traveller_id)
       values ('rgs','legacy_1',0,'L1','trv_L1')`,
    );
    const reread = await readCasePostgres(sql, "rgs", "legacy_1");
    expect(reread).toMatchObject({
      caseId: "legacy_1",
      createdAt: "2026-03-05T06:07:08.009Z",
      updatedAt: "2026-03-05T06:07:08.009Z",
      lineItems: [],
      watchdogOverrides: {},
    });
  });

  it("reports a case row with no applicants as a corrupt record", async () => {
    await sql.query(
      `insert into crm_cases (
         tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
         case_status, billing_status, received_date, total_inr, updated_at
       ) values ('rgs','orphan','O1','partner_1','AE','OTHER','NEW','UNKNOWN','2026-03-04',0,'2026-03-05T00:00:00.000Z')`,
    );
    await expect(readCasePostgres(sql, "rgs", "orphan")).rejects.toBeInstanceOf(CorruptRecordError);
  });
});

describe("caseStore dispatch on CRM_STORE=postgres", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
  });

  it("writes and reads through Postgres and leaves Dynamo untouched", async () => {
    const context = { ...buildTestContext(), crmStore: "postgres" as const, sql };
    const original = buildCase();
    await writeCase(context, original);

    expect(await readCase(context, "rgs", "case_1")).toEqual(original);
    const cases = await sql.query(`select 1 from crm_cases`);
    expect(cases.rows).toHaveLength(1);
    expect(await context.table.query(casePartitionKey("rgs", "case_1"))).toEqual([]);
  });

  it("takes searchText names from Dynamo travellers while travellers are not yet in Postgres", async () => {
    const baseContext = buildTestContext();
    const context = { ...baseContext, crmStore: "postgres" as const, sql };
    const traveller = await upsertTraveller(context, "rgs", { fullName: "Asha Sharma" });
    await writeCase(
      context,
      buildCase({ applicants: [applicant("A1", { travellerId: traveller.travellerId })] }),
    );
    const row = await sql.query<{ search_text: string | null }>(`select search_text from crm_cases`);
    expect(row.rows[0]?.search_text).toBe("asha sharma");
  });

  it("refuses to run without a SQL client rather than falling back to Dynamo", async () => {
    const context = { ...buildTestContext(), crmStore: "postgres" as const };
    await expect(writeCase(context, buildCase())).rejects.toThrow(/context\.sql/);
    await expect(readCase(context, "rgs", "case_1")).rejects.toThrow(/context\.sql/);
  });
});
