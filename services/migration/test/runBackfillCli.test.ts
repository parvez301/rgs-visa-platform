import { crm } from "@rgs/shared";
import { describe, expect, it } from "vitest";
import { buildTestContext } from "@rgs/api/test/helpers";
import { writeCase } from "@rgs/api/src/domain/crm/caseStore";
import { casePartitionKey, META_SORT_KEY } from "@rgs/api/src/domain/crm/keys";
import { runBackfillCli } from "../src/runBackfillCli";

/**
 * N8, applied to the backfill: `backfillCli.ts` used to do its work at module
 * scope (`buildProductionContext()` reached for directly, `console.log`/
 * `console.table` called inline), so nothing here was testable without a real
 * table. `runBackfillCli` takes its dependencies as arguments the way
 * `runImportCli` does, so this file can call it against an in-memory context.
 */

function buildCase(caseId: string): crm.CrmCase {
  return crm.CrmCaseSchema.parse({
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
    applicants: [
      { applicantRef: "A1", travellerId: "t1", custody: "WITH_RGS", outcome: "PENDING" },
    ],
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-04T10:00:00.000Z",
  });
}

describe("runBackfillCli", () => {
  it("runs the backfill against the injected context and prints the summary it returns", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase("case_1"));
    // Simulate the real stored state: written before Task 1 existed.
    const metaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    const { applicantSummary: _dropped, ...metaWithoutSummary } = metaItem!;
    await context.table.put(metaWithoutSummary as typeof metaItem & { PK: string; SK: string });

    const loggedLines: string[] = [];
    const loggedErrors: string[] = [];
    const loggedSummaries: Record<string, unknown>[] = [];

    const cliResult = await runBackfillCli({
      buildContext: () => context,
      logLine: (message) => loggedLines.push(message),
      logError: (message) => loggedErrors.push(message),
      logSummary: (summary) => loggedSummaries.push(summary),
    });

    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.report).toMatchObject({ scanned: 1, written: 1, alreadyCurrent: 0 });
    expect(loggedSummaries).toEqual([
      { scanned: 1, written: 1, alreadyCurrent: 0, unreadable: 0 },
    ]);
    // Nothing unreadable on this run -- no error line printed over it.
    expect(loggedErrors).toEqual([]);

    const backfilledMetaItem = await context.table.get(casePartitionKey("rgs", "case_1"), META_SORT_KEY);
    expect(backfilledMetaItem?.["applicantSummary"]).toEqual({
      count: 1,
      custody: { WITH_RGS: 1 },
      outcome: { PENDING: 1 },
    });
  });

  it("prints the unreadable case ids as an error line rather than staying silent", async () => {
    const context = buildTestContext();
    await writeCase(context, buildCase("case_1"));
    // A partition holding META with no applicant items -- what a timeout
    // between writeCase's two writes leaves behind.
    await context.table.delete(casePartitionKey("rgs", "case_1"), "APPLICANT#00");

    const loggedErrors: string[] = [];

    const cliResult = await runBackfillCli({
      buildContext: () => context,
      logLine: () => {},
      logError: (message) => loggedErrors.push(message),
      logSummary: () => {},
    });

    expect(cliResult.report.unreadableCaseIds).toEqual(["case_1"]);
    expect(loggedErrors).toEqual(["Cases that could not be reassembled: case_1"]);
  });
});
