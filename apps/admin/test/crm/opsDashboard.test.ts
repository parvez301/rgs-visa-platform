import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { countOpsDashboard } from "../../src/crm/ledger/opsDashboard";

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_0000",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12_000,
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("countOpsDashboard", () => {
  it("counts live collect/appointments for today and ignores closed cases", () => {
    const counts = countOpsDashboard(
      [
        buildRow({
          caseId: "collect",
          caseStatus: "IN_PROGRESS",
          expectedCollectionDate: "2026-09-22",
        }),
        buildRow({
          caseId: "appt",
          caseStatus: "APPOINTMENT_SET",
          appointmentDate: "2026-09-22",
        }),
        buildRow({
          caseId: "both",
          caseStatus: "NEW",
          appointmentDate: "2026-09-22",
          expectedCollectionDate: "2026-09-22",
        }),
        buildRow({
          caseId: "closed_collect",
          caseStatus: "CLOSED",
          expectedCollectionDate: "2026-09-22",
        }),
        buildRow({ caseId: "live_other", caseStatus: "SUBMITTED" }),
      ],
      "2026-09-22",
    );

    expect(counts).toEqual({ collectToday: 2, appointmentsToday: 2, pendingLive: 4 });
  });
});
