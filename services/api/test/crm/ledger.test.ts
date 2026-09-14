import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext, type TestContext } from "../helpers";
import { writeCase } from "../../src/domain/crm/caseStore";
import {
  DEFAULT_LEDGER_PAGE_LIMIT,
  LEDGER_PROJECTED_ATTRIBUTES,
  listLedgerRows,
} from "../../src/domain/crm/ledger";
import { casePartitionKey, META_SORT_KEY } from "../../src/domain/crm/keys";

const TENANT_ID = "rgs";

function buildCase(overrides: Partial<crm.CrmCase> & { caseId: string }): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
    tenantId: TENANT_ID,
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

async function seedCases(context: TestContext, cases: crm.CrmCase[]): Promise<void> {
  for (const crmCase of cases) await writeCase(context, crmCase);
}

describe("listLedgerRows", () => {
  it("projects only the Ledger's own columns", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", legacyRaw: { STATUS: "the whole original spreadsheet row" } }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ caseRef: "RGS-case_1", caseStatus: "NEW", totalInr: 12000 });
    // Both halves asserted: the columns are right AND the two heavy
    // attributes are gone. Checking only the first would pass against a
    // route that returned whole cases.
    expect(page.rows[0]).not.toHaveProperty("legacyRaw");
    expect(page.rows[0]).not.toHaveProperty("lineItems");
    expect(LEDGER_PROJECTED_ATTRIBUTES).not.toContain("legacyRaw");
    expect(LEDGER_PROJECTED_ATTRIBUTES).not.toContain("lineItems");
  });

  it("carries the applicant roll-up through", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({
        caseId: "case_1",
        applicants: [
          { applicantRef: "A1", travellerId: "t1", custody: "AT_EMBASSY", outcome: "PENDING" },
          { applicantRef: "A2", travellerId: "t2", custody: "WITH_RGS", outcome: "PENDING" },
        ],
      }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows[0]!.applicantSummary).toEqual({
      count: 2,
      custody: { AT_EMBASSY: 1, WITH_RGS: 1 },
      outcome: { PENDING: 2 },
    });
  });

  it("reads every requested status, spilling from one partition into the next", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED" }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW", "SUBMITTED"],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2", "case_3"]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns every row exactly once across a cursor walk that crosses a partition boundary", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW", updatedAt: "2026-03-04T10:00:01.000Z" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW", updatedAt: "2026-03-04T10:00:02.000Z" }),
      buildCase({ caseId: "case_3", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:03.000Z" }),
      buildCase({ caseId: "case_4", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:04.000Z" }),
      buildCase({ caseId: "case_5", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:05.000Z" }),
    ]);

    const collectedCaseIds: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await listLedgerRows(context, TENANT_ID, {
        statuses: ["NEW", "SUBMITTED"],
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      collectedCaseIds.push(...page.rows.map((row) => row.caseId));
      cursor = page.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(collectedCaseIds).toHaveLength(5);
    expect(new Set(collectedCaseIds).size).toBe(5);
  });

  it("refuses a cursor issued for a different filter rather than silently restarting", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", caseStatus: "NEW" }),
    ]);

    const firstPage = await listLedgerRows(context, TENANT_ID, { statuses: ["NEW"], limit: 1 });
    expect(firstPage.nextCursor).toBeDefined();

    await expect(
      listLedgerRows(context, TENANT_ID, {
        statuses: ["SUBMITTED"],
        limit: 1,
        cursor: firstPage.nextCursor!,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a malformed cursor", async () => {
    const context = buildTestContext();

    await expect(
      listLedgerRows(context, TENANT_ID, { statuses: ["NEW"], limit: 10, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("names a row it could not read instead of dropping it", async () => {
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1" })]);
    // Corrupt the stored META item the way a hand-repair would: a
    // destinationCountry that is not a country code at all.
    const metaItem = await context.table.get(casePartitionKey(TENANT_ID, "case_1"), META_SORT_KEY);
    await context.table.put({ ...metaItem!, destinationCountry: "United Arab Emirates" });

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows).toHaveLength(0);
    expect(page.unreadableCaseIds).toEqual(["case_1"]);
  });

  it("reads one partner's whole partition when partnerId is given, whatever the statuses say", async () => {
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", partnerId: "partner_a", caseStatus: "NEW" }),
      buildCase({ caseId: "case_2", partnerId: "partner_a", caseStatus: "CLOSED" }),
      buildCase({ caseId: "case_3", partnerId: "partner_b", caseStatus: "NEW" }),
    ]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW"],
      partnerId: "partner_a",
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    // Both of partner_a's cases, including the CLOSED one the status filter
    // would have excluded: in partner mode the client filters, and the
    // alternative is pages that arrive almost empty.
    expect(page.rows.map((row) => row.caseId).sort()).toEqual(["case_1", "case_2"]);
  });

  it("never reassembles a case", async () => {
    // The whole point of the read model. readCase issues a base-table get plus
    // a base-table query per case; a Ledger that did that is 14,312
    // round-trips. Asserted by counting what the table client was asked for.
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1" }), buildCase({ caseId: "case_2" })]);
    let baseTableReadCount = 0;
    const countingTable = {
      ...context.table,
      get: async (...callArguments: Parameters<typeof context.table.get>) => {
        baseTableReadCount += 1;
        return context.table.get(...callArguments);
      },
      query: async (...callArguments: Parameters<typeof context.table.query>) => {
        baseTableReadCount += 1;
        return context.table.query(...callArguments);
      },
      queryGsiPage: context.table.queryGsiPage.bind(context.table),
      queryGsi: context.table.queryGsi.bind(context.table),
      put: context.table.put.bind(context.table),
      delete: context.table.delete.bind(context.table),
    };

    await listLedgerRows({ ...context, table: countingTable }, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(baseTableReadCount).toBe(0);
  });

  // Fix round 1 (review of e6473bd).

  it("returns each row exactly once even when the caller repeats a status (F1)", async () => {
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1", caseStatus: "NEW" })]);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW", "NEW"],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    // Asserted on the full id list, not just the count: a fix that dropped a
    // different row instead of deduping the repeated partition read would
    // still pass a bare `toHaveLength(1)`.
    expect(page.rows.map((row) => row.caseId)).toEqual(["case_1"]);
  });

  it("resumes a cursor across the same status set sent in a different order, instead of 400ing or silently skipping a status (F2)", async () => {
    // This is the test that proves the safe fix for concern 3 is the right
    // one. Canonicalizing ONLY `scopeKeyFor` (so this cursor stops 400ing)
    // would leave `partitionIndex` pointing at a partition of a
    // differently-ordered `partitionKeys` array, silently skipping
    // SUBMITTED instead of refusing the cursor. Do not "simplify" the
    // canonicalization in listLedgerRows back to a raw `.join(",")`.
    const context = buildTestContext();
    await seedCases(context, [
      buildCase({ caseId: "case_1", caseStatus: "NEW", updatedAt: "2026-03-04T10:00:01.000Z" }),
      buildCase({ caseId: "case_2", caseStatus: "SUBMITTED", updatedAt: "2026-03-04T10:00:02.000Z" }),
    ]);

    const firstPage = await listLedgerRows(context, TENANT_ID, {
      statuses: ["NEW", "SUBMITTED"],
      limit: 1,
    });
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await listLedgerRows(context, TENANT_ID, {
      statuses: ["SUBMITTED", "NEW"],
      limit: 1,
      cursor: firstPage.nextCursor!,
    });

    const collectedCaseIds = [...firstPage.rows, ...secondPage.rows].map((row) => row.caseId);
    expect(collectedCaseIds.sort()).toEqual(["case_1", "case_2"]);
    expect(new Set(collectedCaseIds).size).toBe(2);
  });

  it("reads a case whose META item predates applicantSummary as a normal, readable row (F3)", async () => {
    const context = buildTestContext();
    await seedCases(context, [buildCase({ caseId: "case_1" })]);
    const metaItem = await context.table.get(casePartitionKey(TENANT_ID, "case_1"), META_SORT_KEY);
    // Drop the attribute entirely, the way one of the 7,156 cases imported
    // before writeCase computed a roll-up is actually stored -- not present
    // as `undefined`, simply absent from the item.
    const { applicantSummary: _droppedSummary, ...metaItemWithoutSummary } = metaItem!;
    await context.table.put(metaItemWithoutSummary);

    const page = await listLedgerRows(context, TENANT_ID, {
      statuses: [...crm.CASE_STATUSES],
      limit: DEFAULT_LEDGER_PAGE_LIMIT,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.applicantSummary).toBeUndefined();
    expect(page.unreadableCaseIds).toEqual([]);
  });
});
