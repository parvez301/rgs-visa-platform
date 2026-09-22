import { describe, expect, it, vi } from "vitest";
import {
  applyBulkLedgerEdits,
  summariseBulkEditResults,
} from "../../src/crm/ledger/bulkEdits";

describe("applyBulkLedgerEdits", () => {
  it("runs one edit per case in order and reports a per-case failure without stopping", async () => {
    const performEdit = vi.fn(async (caseId: string) => {
      if (caseId === "case_b") throw new Error("illegal transition");
    });

    const results = await applyBulkLedgerEdits({
      caseIds: ["case_a", "case_b", "case_c"],
      column: "billingStatus",
      nextValue: "BILL_SENT",
      performEdit,
    });

    expect(performEdit.mock.calls.map((call) => call[0])).toEqual(["case_a", "case_b", "case_c"]);
    expect(results).toEqual([
      { caseId: "case_a", ok: true },
      { caseId: "case_b", ok: false, errorMessage: "illegal transition" },
      { caseId: "case_c", ok: true },
    ]);
    expect(summariseBulkEditResults(results)).toEqual({
      appliedCount: 2,
      failedCount: 1,
      failedCaseIds: ["case_b"],
    });
  });
});
