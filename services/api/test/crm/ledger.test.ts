import { crm } from "@rgs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/lib/errors";
import type { SqlClient } from "../../src/lib/sql";
import { writeCase } from "../../src/domain/crm/caseStore";
import { listLedgerRowsFromPostgres } from "../../src/domain/crm/ledgerPostgres";
import { buildTestContext, closeTestContexts, type TestContext } from "../helpers";

afterEach(closeTestContexts);

const APPLICANT_SUMMARY = { count: 1, custody: { WITH_RGS: 1 }, outcome: { PENDING: 1 } };

interface SeedCase {
  caseId: string;
  caseRef?: string;
  partnerId?: string;
  destinationCountry?: string;
  caseType?: string;
  caseStatus?: string;
  billingStatus?: string;
  receivedDate?: string;
  appointmentDate?: string | null;
  expectedCollectionDate?: string | null;
  groupName?: string | null;
  searchText?: string | null;
  tenantId?: string;
}

async function seedCase(sql: SqlClient, seed: SeedCase): Promise<void> {
  await sql.query(
    `insert into crm_cases (
       tenant_id, case_id, case_ref, partner_id, destination_country, case_type,
       visa_type, group_name, case_status, billing_status, received_date,
       appointment_date, expected_collection_date, total_inr, updated_at,
       applicant_summary, search_text
     ) values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11,$12,1500,'2026-03-04T10:00:00.000Z',$13,$14)`,
    [
      seed.tenantId ?? "rgs",
      seed.caseId,
      seed.caseRef ?? `RGS-${seed.caseId}`,
      seed.partnerId ?? "partner_1",
      seed.destinationCountry ?? "AE",
      seed.caseType ?? "VISA",
      seed.groupName ?? null,
      seed.caseStatus ?? "NEW",
      seed.billingStatus ?? "UNKNOWN",
      seed.receivedDate ?? "2026-03-04",
      seed.appointmentDate ?? null,
      seed.expectedCollectionDate ?? null,
      JSON.stringify(APPLICANT_SUMMARY),
      seed.searchText ?? null,
    ],
  );
}

async function seedApplicant(
  sql: SqlClient,
  seed: {
    caseId: string;
    applicantIndex: number;
    applicantRef: string;
    refNo?: string | null;
    tenantId?: string;
  },
): Promise<void> {
  await sql.query(
    `insert into crm_applicants (
       tenant_id, case_id, applicant_index, applicant_ref, ref_no, traveller_id
     ) values ($1,$2,$3,$4,$5,$6)`,
    [
      seed.tenantId ?? "rgs",
      seed.caseId,
      seed.applicantIndex,
      seed.applicantRef,
      seed.refNo ?? null,
      `traveller_${seed.caseId}_${seed.applicantIndex}`,
    ],
  );
}

async function seedPartner(sql: SqlClient, partnerId: string, canonicalName: string): Promise<void> {
  await sql.query(
    `insert into crm_partners (tenant_id, partner_id, canonical_name, contact_email, updated_at)
     values ('rgs', $1, $2, null, '2026-03-01T08:00:00.000Z')`,
    [partnerId, canonicalName],
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("listLedgerRowsFromPostgres", () => {
  let context: TestContext;
  let sql: SqlClient;

  beforeEach(async () => {
    context = await buildTestContext();
    sql = context.sql;
    await seedPartner(sql, "partner_1", "Acme Travel");
    await seedPartner(sql, "partner_2", "Zenith Visas");
    await seedCase(sql, {
      caseId: "case_a",
      caseRef: "RGS-1001",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseStatus: "NEW",
      billingStatus: "UNBILLED",
      receivedDate: "2026-03-01",
      appointmentDate: "2026-04-01",
      searchText: "asha rao m1234567",
    });
    await seedCase(sql, {
      caseId: "case_b",
      caseRef: "RGS-1002",
      partnerId: "partner_2",
      destinationCountry: "GB",
      caseType: "ATTESTATION",
      caseStatus: "SUBMITTED",
      billingStatus: "PAID",
      receivedDate: "2026-03-02",
      expectedCollectionDate: "2026-05-10",
      searchText: "bilal khan k7654321",
    });
    await seedCase(sql, {
      caseId: "case_c",
      caseRef: "RGS-1003",
      partnerId: "partner_1",
      destinationCountry: "GB",
      caseStatus: "SUBMITTED",
      billingStatus: "PAID",
      receivedDate: "2026-03-03",
    });
  });

  it("returns every row of the tenant newest first, mapped through LedgerRowSchema", async () => {
    const page = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 10 });

    expect(page.rows.map((row) => row.caseId)).toEqual(["case_c", "case_b", "case_a"]);
    expect(page.unreadableCaseIds).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.rows[2]).toEqual({
      caseId: "case_a",
      caseRef: "RGS-1001",
      partnerId: "partner_1",
      destinationCountry: "AE",
      caseType: "VISA",
      caseStatus: "NEW",
      billingStatus: "UNBILLED",
      receivedDate: "2026-03-01",
      appointmentDate: "2026-04-01",
      totalInr: 1500,
      lineItemCount: 0,
      updatedAt: "2026-03-04T10:00:00.000Z",
      applicantSummary: APPLICANT_SUMMARY,
      searchText: "asha rao m1234567",
    });
  });

  it("does not return another tenant's rows", async () => {
    await seedCase(sql, { caseId: "other_tenant_case", tenantId: "other" });
    const page = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 10 });
    expect(page.rows.map((row) => row.caseId)).not.toContain("other_tenant_case");
  });

  it("combines status, partner and destination country filters", async () => {
    const page = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: ["SUBMITTED"],
      partnerId: "partner_1",
      destinationCountry: "GB",
      limit: 10,
    });
    expect(page.rows.map((row) => row.caseId)).toEqual(["case_c"]);
  });

  it("combines case type, billing status and date-on filters", async () => {
    const byType = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      caseType: "ATTESTATION",
      billingStatuses: ["PAID", "PART_PAID"],
      limit: 10,
    });
    expect(byType.rows.map((row) => row.caseId)).toEqual(["case_b"]);

    const byAppointment = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      appointmentDateOn: "2026-04-01",
      limit: 10,
    });
    expect(byAppointment.rows.map((row) => row.caseId)).toEqual(["case_a"]);

    const byCollection = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      expectedCollectionDateOn: "2026-05-10",
      limit: 10,
    });
    expect(byCollection.rows.map((row) => row.caseId)).toEqual(["case_b"]);
  });

  it("searches case_ref, search_text and the joined partner canonical_name, case-insensitively", async () => {
    const searchIds = async (search: string) =>
      (await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], search, limit: 10 })).rows.map(
        (row) => row.caseId,
      );

    expect(await searchIds("rgs-1002")).toEqual(["case_b"]);
    expect(await searchIds("M1234567")).toEqual(["case_a"]);
    expect(await searchIds("zenith")).toEqual(["case_b"]);
    expect(await searchIds("acme")).toEqual(["case_c", "case_a"]);
    expect(await searchIds("no-such-thing")).toEqual([]);
  });

  it("searches group_name and applicant REF NOs on family cases", async () => {
    await seedCase(sql, {
      caseId: "case_family",
      caseRef: "38608",
      partnerId: "partner_1",
      groupName: "PATANJALI FAMILY",
      receivedDate: "2026-03-05",
      searchText: null,
    });
    await seedApplicant(sql, {
      caseId: "case_family",
      applicantIndex: 0,
      applicantRef: "app_38608",
      refNo: "38608",
    });
    await seedApplicant(sql, {
      caseId: "case_family",
      applicantIndex: 1,
      applicantRef: "app_38609",
      refNo: "38609",
    });

    const searchIds = async (search: string) =>
      (await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], search, limit: 10 })).rows.map(
        (row) => row.caseId,
      );

    expect(await searchIds("patanjali")).toEqual(["case_family"]);
    expect(await searchIds("38609")).toEqual(["case_family"]);
  });

  it("treats LIKE metacharacters in the search literally", async () => {
    const page = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      search: "%",
      limit: 10,
    });
    expect(page.rows).toEqual([]);
  });

  it("combines search with the other filters", async () => {
    const page = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: ["NEW"],
      search: "acme",
      limit: 10,
    });
    expect(page.rows.map((row) => row.caseId)).toEqual(["case_a"]);
  });

  it("pages with a keyset cursor without skipping or repeating a row", async () => {
    const firstPage = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 2 });
    expect(firstPage.rows.map((row) => row.caseId)).toEqual(["case_c", "case_b"]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.rows.map((row) => row.caseId)).toEqual(["case_a"]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("breaks received_date ties on case_id descending", async () => {
    await seedCase(sql, { caseId: "case_d", receivedDate: "2026-03-03" });
    const firstPage = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 2 });
    expect(firstPage.rows.map((row) => row.caseId)).toEqual(["case_d", "case_c"]);
    const secondPage = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.rows.map((row) => row.caseId)).toEqual(["case_b", "case_a"]);
  });

  it("accepts the same filters in a different order against one cursor", async () => {
    const firstPage = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: ["SUBMITTED", "NEW"],
      limit: 1,
    });
    const secondPage = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: ["NEW", "SUBMITTED", "NEW"],
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.rows.map((row) => row.caseId)).toEqual(["case_b"]);
  });

  it("refuses an undecodable cursor with a 400", async () => {
    const error = await rejectionOf(
      listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 10, cursor: "not-a-cursor" }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400, message: "This ledger cursor could not be read" });
  });

  it("refuses a cursor issued for a different filter with a 400", async () => {
    const firstPage = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: ["SUBMITTED"],
      limit: 1,
    });
    const error = await rejectionOf(
      listLedgerRowsFromPostgres(sql, "rgs", {
        statuses: ["NEW"],
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/issued for a different filter/),
    });

    const searchChanged = await rejectionOf(
      listLedgerRowsFromPostgres(sql, "rgs", {
        statuses: ["SUBMITTED"],
        search: "acme",
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    );
    expect(searchChanged).toMatchObject({ statusCode: 400 });
  });

  it("names a row that fails LedgerRowSchema instead of dropping or throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seedCase(sql, { caseId: "case_bad", caseType: "BOGUS", receivedDate: "2026-03-05" });

      const page = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 10 });

      expect(page.unreadableCaseIds).toEqual(["case_bad"]);
      expect(page.rows.map((row) => row.caseId)).toEqual(["case_c", "case_b", "case_a"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not repeat an unreadable last row on the next page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seedCase(sql, { caseId: "case_bad", caseType: "BOGUS", receivedDate: "2026-03-05" });

      const firstPage = await listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 2 });
      expect(firstPage.unreadableCaseIds).toEqual(["case_bad"]);
      expect(firstPage.rows.map((row) => row.caseId)).toEqual(["case_c"]);

      const secondPage = await listLedgerRowsFromPostgres(sql, "rgs", {
        statuses: [],
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.unreadableCaseIds).toEqual([]);
      expect(secondPage.rows.map((row) => row.caseId)).toEqual(["case_b", "case_a"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a non-positive limit and a malformed date filter with a 400", async () => {
    expect(
      await rejectionOf(listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 0 })),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await rejectionOf(
        listLedgerRowsFromPostgres(sql, "rgs", {
          statuses: [],
          limit: 10,
          appointmentDateOn: "04/01/2026",
        }),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it.each(["2026-13-45", "2026-02-30", "2026-00-10", "2026-04-31", "0000-01-01"])(
    "rejects the impossible date %s with a 400, not a Postgres error",
    async (impossibleDate) => {
      for (const filterName of ["appointmentDateOn", "expectedCollectionDateOn"] as const) {
        const error = await rejectionOf(
          listLedgerRowsFromPostgres(sql, "rgs", {
            statuses: [],
            limit: 10,
            [filterName]: impossibleDate,
          }),
        );
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ statusCode: 400 });
      }
    },
  );

  it("accepts a real leap day", async () => {
    const page = await listLedgerRowsFromPostgres(sql, "rgs", {
      statuses: [],
      limit: 10,
      appointmentDateOn: "2028-02-29",
    });
    expect(page.rows).toEqual([]);
  });

  it("refuses a well-formed cursor carrying an impossible receivedDate with the unreadable-cursor 400", async () => {
    const forged = Buffer.from(
      JSON.stringify({ v: 1, scopeKey: "x", receivedDate: "2026-13-45", caseId: "case_a" }),
      "utf8",
    ).toString("base64url");
    const error = await rejectionOf(
      listLedgerRowsFromPostgres(sql, "rgs", { statuses: [], limit: 10, cursor: forged }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 400, message: "This ledger cursor could not be read" });
  });
});

function buildCase(overrides: Partial<crm.CrmCase> & { caseId: string }): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
    tenantId: "rgs",
    caseRef: `RGS-${overrides.caseId}`,
    caseType: "VISA",
    visaType: "TOURIST",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12000,
    applicants: [{ applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING" }],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  });
}

describe("listLedgerRowsFromPostgres over cases written through writeCase", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await buildTestContext();
  });

  async function seedCases(cases: crm.CrmCase[]): Promise<void> {
    for (const crmCase of cases) await writeCase(context, crmCase);
  }

  it("projects only the Ledger's own columns", async () => {
    await seedCases([
      buildCase({ caseId: "case_1", legacyRaw: { STATUS: "the whole original spreadsheet row" } }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
      statuses: [...crm.CASE_STATUSES],
      limit: 500,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      caseRef: "RGS-case_1",
      caseStatus: "NEW",
      totalInr: 12000,
      lineItemCount: 0,
    });
    expect(page.rows[0]).not.toHaveProperty("legacyRaw");
    expect(page.rows[0]).not.toHaveProperty("lineItems");
  });

  it("projects lineItemCount from the case line_items array", async () => {
    await seedCases([
      buildCase({
        caseId: "case_lines",
        lineItems: [
          {
            code: "VISA_SERVICE_FEE",
            label: "Visa service fee",
            kind: "SERVICE",
            amountInr: 5000,
            quantity: 1,
          },
          {
            code: "GOVT_FEE",
            label: "Government / embassy fee",
            kind: "GOVT_FEE",
            amountInr: 1500,
            quantity: 1,
          },
        ],
        totalInr: 6500,
      }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
      statuses: [...crm.CASE_STATUSES],
      limit: 500,
    });
    const row = page.rows.find((candidate) => candidate.caseId === "case_lines");
    expect(row?.lineItemCount).toBe(2);
  });

  it("projects expectedCollectionDate when the case carries one", async () => {
    await seedCases([
      buildCase({
        caseId: "case_collect",
        expectedCollectionDate: "2026-09-22",
        appointmentDate: "2026-09-20",
      }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", { statuses: [], limit: 500 });

    expect(page.rows[0]).toMatchObject({
      caseId: "case_collect",
      expectedCollectionDate: "2026-09-22",
      appointmentDate: "2026-09-20",
    });
  });

  it("projects groupName when the case carries one, and no groupName key when it does not", async () => {
    await seedCases([
      buildCase({ caseId: "case_grouped", groupName: "Sharma Family" }),
      buildCase({ caseId: "case_solo" }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", { statuses: [], limit: 500 });

    const grouped = page.rows.find((row) => row.caseId === "case_grouped");
    const solo = page.rows.find((row) => row.caseId === "case_solo");
    expect(grouped?.groupName).toBe("Sharma Family");
    expect(solo).not.toHaveProperty("groupName");
  });

  it("projects every unique applicant REF NO for a family case", async () => {
    await seedCases([
      buildCase({
        caseId: "case_family",
        caseRef: "38599",
        groupName: "CHRISTI FAMILY",
        applicants: [
          { applicantRef: "A1", travellerId: "trav_1", custody: "WITH_RGS", outcome: "PENDING", refNo: "38599" },
          { applicantRef: "A2", travellerId: "trav_2", custody: "WITH_RGS", outcome: "PENDING", refNo: "38600" },
          { applicantRef: "A3", travellerId: "trav_3", custody: "WITH_RGS", outcome: "PENDING", refNo: "38601" },
          { applicantRef: "A4", travellerId: "trav_4", custody: "WITH_RGS", outcome: "PENDING", refNo: "38602" },
        ],
      }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
      statuses: [...crm.CASE_STATUSES],
      limit: 500,
    });
    const family = page.rows.find((row) => row.caseId === "case_family");
    expect(family?.applicantRefs).toEqual(["38599", "38600", "38601", "38602"]);
  });

  it("carries the applicant roll-up through", async () => {
    await seedCases([
      buildCase({
        caseId: "case_1",
        applicants: [
          { applicantRef: "A1", travellerId: "t1", custody: "AT_EMBASSY", outcome: "PENDING" },
          { applicantRef: "A2", travellerId: "t2", custody: "WITH_RGS", outcome: "PENDING" },
        ],
      }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", { statuses: [], limit: 500 });

    expect(page.rows[0]!.applicantSummary).toEqual({
      count: 2,
      custody: { AT_EMBASSY: 1, WITH_RGS: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("reads every requested status and returns each row once when a status is repeated", async () => {
    await seedCases([
      buildCase({ caseId: "case_1", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED" }),
      buildCase({ caseId: "case_4", caseStatus: "CLOSED" }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
      statuses: ["NEW", "SUBMITTED", "NEW"],
      limit: 500,
    });

    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2", "case_3"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("walks every row exactly once across a cursor walk spanning statuses", async () => {
    await seedCases([
      buildCase({ caseId: "case_1", caseStatus: "NEW", receivedDate: "2026-03-01" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW", receivedDate: "2026-03-02" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED", receivedDate: "2026-03-03" }),
      buildCase({ caseId: "case_4", caseStatus: "SUBMITTED", receivedDate: "2026-03-04" }),
      buildCase({ caseId: "case_5", caseStatus: "SUBMITTED", receivedDate: "2026-03-05" }),
    ]);

    const collected: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
        statuses: ["NEW", "SUBMITTED"],
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      collected.push(...page.rows.map((row) => row.caseId));
      cursor = page.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5);
  });

  it("reads one partner's cases in partner mode, across statuses, when no status filter is given", async () => {
    await seedCases([
      buildCase({ caseId: "case_1", partnerId: "partner_a", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", partnerId: "partner_a", caseStatus: "CLOSED" }),
      buildCase({ caseId: "case_3", partnerId: "partner_b", caseStatus: "NEW" }),
    ]);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", {
      statuses: [],
      partnerId: "partner_a",
      limit: 500,
    });

    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2"]);
  });

  it("names a row it could not read instead of dropping it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seedCases([buildCase({ caseId: "case_1" })]);
      await context.sql.query(
        `update crm_cases set case_type = 'BOGUS' where case_id = 'case_1'`,
      );

      const page = await listLedgerRowsFromPostgres(context.sql, "rgs", { statuses: [], limit: 500 });

      expect(page.rows).toHaveLength(0);
      expect(page.unreadableCaseIds).toEqual(["case_1"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads a case with no applicant summary as a normal, readable row", async () => {
    await seedCases([buildCase({ caseId: "case_1" })]);
    await context.sql.query(`update crm_cases set applicant_summary = null where case_id = 'case_1'`);

    const page = await listLedgerRowsFromPostgres(context.sql, "rgs", { statuses: [], limit: 500 });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.applicantSummary).toBeUndefined();
    expect(page.unreadableCaseIds).toEqual([]);
  });
});
