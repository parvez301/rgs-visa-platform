import type { crm } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCase, readCaseOrThrow, writeCase } from "../../src/domain/crm/caseStore";
import { readCasePostgres, writeCasePostgres } from "../../src/domain/crm/caseStorePostgres";
import { changeApplicantCustody } from "../../src/domain/crm/cases";
import { upsertTraveller } from "../../src/domain/crm/travellers";
import { CorruptRecordError } from "../../src/lib/errors";
import type { SqlClient } from "../../src/lib/sql";
import { buildSqlTestContext, closeSqlTestContexts, type SqlTestContext } from "../helpers";

afterEach(closeSqlTestContexts);

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

describe("caseStore", () => {
  let context: SqlTestContext;
  let sql: SqlClient;

  beforeEach(async () => {
    context = await buildSqlTestContext();
    sql = context.sql;
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

  describe("impossible calendar dates", () => {
    it.each([
      ["receivedDate", { receivedDate: "2026-02-30" }],
      ["submissionDate", { submissionDate: "2026-04-31" }],
      ["appointmentDate", { appointmentDate: "2026-13-01" }],
      ["appointmentReminderSentFor", { appointmentReminderSentFor: "2026-02-30" }],
      ["expectedCollectionDate", { expectedCollectionDate: "2026-02-30" }],
      ["courierDate", { courierDate: "2026-06-31" }],
    ])("refuses %s with a 400 naming the case and field, and writes nothing", async (fieldName, overrides) => {
      const attempt = writeCasePostgres(sql, buildCase(overrides as Partial<crm.CrmCase>));
      await expect(attempt).rejects.toMatchObject({ statusCode: 400, code: "BAD_REQUEST" });
      await expect(attempt).rejects.toThrow(new RegExp(`case_1.*${fieldName}`));
      expect((await sql.query(`select 1 from crm_cases`)).rows).toEqual([]);
      expect((await sql.query(`select 1 from crm_applicants`)).rows).toEqual([]);
    });

    it("still accepts a real leap day", async () => {
      await writeCasePostgres(sql, buildCase({ receivedDate: "2028-02-29" }));
      expect(await readCasePostgres(sql, "rgs", "case_1")).toMatchObject({ receivedDate: "2028-02-29" });
    });
  });

  describe("transactions", () => {
    it("rolls back the case row when an applicant insert fails", async () => {
      await writeCasePostgres(sql, buildCase({ remarks: "before" }));
      // Duplicate applicantRef violates (case_id, applicant_ref) on the second insert.
      const broken = buildCase({
        remarks: "after",
        applicants: [applicant("A1"), applicant("A1")],
      });
      await expect(writeCasePostgres(sql, broken)).rejects.toMatchObject({ code: "23505" });
      expect(await readCasePostgres(sql, "rgs", "case_1")).toMatchObject({ remarks: "before" });
      const applicants = await sql.query(`select 1 from crm_applicants where case_id = 'case_1'`);
      expect(applicants.rows).toHaveLength(2);
    });

    it("does not interleave concurrent writers of different cases", async () => {
      await Promise.all(
        Array.from({ length: 6 }, (_unused, caseNumber) =>
          writeCasePostgres(
            sql,
            buildCase({
              caseId: `case_c${caseNumber}`,
              caseRef: `C${caseNumber}`,
              applicants: [applicant(`C${caseNumber}A`), applicant(`C${caseNumber}B`)],
            }),
          ),
        ),
      );
      const counts = await sql.query<{ case_id: string; n: string }>(
        `select case_id, count(*)::text as n from crm_applicants group by case_id order by case_id`,
      );
      expect(counts.rows).toHaveLength(6);
      expect(counts.rows.every((row) => row.n === "2")).toBe(true);
    });

    it("runs a case write as exactly one transaction on the client", async () => {
      let transactions = 0;
      const counting: SqlClient = {
        query: (text, values) => sql.query(text, values),
        transaction: (work) => {
          transactions += 1;
          return sql.transaction(work);
        },
        end: () => sql.end(),
      };
      await writeCasePostgres(counting, buildCase());
      expect(transactions).toBe(1);
    });
  });

  it("reassembles the domain shape through writeCase / readCase", async () => {
    const original = buildCase();
    await writeCase(context, original);
    expect(await readCase(context, "rgs", "case_1")).toEqual(original);
    expect((await sql.query(`select 1 from crm_cases`)).rows).toHaveLength(1);
  });

  it("returns undefined for a case that does not exist, and 404s from readCaseOrThrow", async () => {
    expect(await readCase(context, "rgs", "nope")).toBeUndefined();
    await expect(readCaseOrThrow(context, "rgs", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not leak a case across tenants", async () => {
    await writeCase(context, buildCase());
    expect(await readCase(context, "other-tenant", "case_1")).toBeUndefined();
  });

  it("reports a typed 409 naming the case when the stored case has no applicants", async () => {
    await writeCase(context, buildCase());
    await writeCase(context, buildCase({ applicants: [] } as Partial<crm.CrmCase>));
    await expect(readCase(context, "rgs", "case_1")).rejects.toBeInstanceOf(CorruptRecordError);
    await expect(readCase(context, "rgs", "case_1")).rejects.toMatchObject({
      statusCode: 409,
      code: "CORRUPT_RECORD",
    });
    await expect(readCase(context, "rgs", "case_1")).rejects.toThrow(/case_1/);
  });

  it("preserves applicant order across the single/double-digit boundary", async () => {
    const applicants = Array.from({ length: 11 }, (_unused, index) => ({
      applicantRef: String(30000 + index),
      travellerId: `trv_${index}`,
      custody: "NOT_HELD" as const,
      outcome: "PENDING" as const,
      passportNumber: `PASSPORT_${String(index).padStart(2, "0")}`,
    }));
    const original = buildCase({ applicants } as Partial<crm.CrmCase>);
    await writeCase(context, original);
    const loaded = await readCase(context, "rgs", "case_1");
    expect(loaded!.applicants).toEqual(original.applicants);
  });

  it("takes searchText names from the Postgres travellers written through upsertTraveller", async () => {
    const asha = await upsertTraveller(context, "rgs", {
      fullName: "Asha Rao",
      passportNumber: "M1234567",
    });
    const ravi = await upsertTraveller(context, "rgs", { fullName: "Ravi Singh" });
    await writeCase(
      context,
      buildCase({
        applicants: [
          {
            applicantRef: "31377",
            travellerId: asha.travellerId,
            passportNumber: "IGNORED_WHEN_TRAVELLER_HAS_ONE",
            custody: "NOT_HELD",
            outcome: "PENDING",
          },
          {
            applicantRef: "31378",
            travellerId: ravi.travellerId,
            passportNumber: "A9988776",
            custody: "NOT_HELD",
            outcome: "PENDING",
          },
        ],
      }),
    );
    const row = await sql.query<{ search_text: string | null }>(`select search_text from crm_cases`);
    expect(row.rows[0]?.search_text).toBe("asha rao m1234567 ravi singh a9988776");
  });

  it("stamps the group name into searchText so the ledger can find a family by name", async () => {
    await writeCase(context, buildCase({ groupName: "Sharma Family" }));
    const row = await sql.query<{ search_text: string | null; group_name: string | null }>(
      `select search_text, group_name from crm_cases`,
    );
    expect(String(row.rows[0]?.search_text)).toContain("sharma family");
    expect(row.rows[0]?.group_name).toBe("Sharma Family");
  });

  it("moves the stored roll-up when one applicant's custody moves", async () => {
    // No mutator may change an applicant without the stored summary following;
    // changeApplicantCustody goes through writeCase like every other mutator.
    const crmCase = buildCase({
      applicants: [applicant("A1", { custody: "WITH_RGS" }), applicant("A2", { custody: "WITH_RGS" })],
    });
    await writeCase(context, crmCase);

    await changeApplicantCustody(context, "rgs", "case_1", "A1", "AT_EMBASSY", "ops@rgs.test");

    const row = await sql.query<{ applicant_summary: unknown }>(`select applicant_summary from crm_cases`);
    expect(row.rows[0]?.applicant_summary).toEqual({
      count: 2,
      custody: { WITH_RGS: 1, AT_EMBASSY: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("drops a stale summary carried in on the case body rather than storing it", async () => {
    const crmCase = buildCase({ applicants: [applicant("A1")] });
    await writeCase(context, {
      ...crmCase,
      applicantSummary: { count: 99, custody: { RETURNED: 99 }, outcome: {} },
    } as typeof crmCase);

    const row = await sql.query<{ applicant_summary: unknown }>(`select applicant_summary from crm_cases`);
    expect(row.rows[0]?.applicant_summary).toEqual({
      count: 1,
      custody: { NOT_HELD: 1 },
      outcome: { PENDING: 1 },
    });
  });
});
