import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../src/db/migrate";
import { ApiError } from "../../src/lib/errors";
import type { SqlClient } from "../../src/lib/sql";
import { listLedgerRowsFromPostgres } from "../../src/domain/crm/ledgerPostgres";

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
     ) values ($1,$2,$3,$4,$5,$6,null,null,$7,$8,$9,$10,$11,1500,'2026-03-04T10:00:00.000Z',$12,$13)`,
    [
      seed.tenantId ?? "rgs",
      seed.caseId,
      seed.caseRef ?? `RGS-${seed.caseId}`,
      seed.partnerId ?? "partner_1",
      seed.destinationCountry ?? "AE",
      seed.caseType ?? "VISA",
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
  let sql: SqlClient;

  beforeEach(async () => {
    sql = pgliteAsSqlClient(new PGlite());
    await applyMigrations(sql);
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
});
