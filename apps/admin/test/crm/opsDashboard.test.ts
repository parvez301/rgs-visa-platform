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
    caseStatus: "DOCS_UNDER_REVIEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-03-04",
    totalInr: 12_000,
    lineItemCount: 0,
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
          caseStatus: "DOCS_UNDER_REVIEW",
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

    expect(counts).toEqual({
      collectToday: 2,
      appointmentsToday: 2,
      appointmentsUpcoming: 0,
      pendingLive: 4,
    });
  });

  it("needs the full live set: a today-only slice makes Upcoming look empty", () => {
    const todayOnlySlice = [
      buildRow({
        caseId: "today",
        caseStatus: "APPOINTMENT_SET",
        appointmentDate: "2026-09-22",
      }),
    ];
    const fullLiveSet = [
      ...todayOnlySlice,
      buildRow({
        caseId: "future_a",
        caseStatus: "READY_FOR_SUBMISSION",
        appointmentDate: "2026-09-25",
      }),
      buildRow({
        caseId: "future_b",
        caseStatus: "APPOINTMENT_SET",
        appointmentDate: "2026-10-01",
      }),
    ];

    expect(countOpsDashboard(todayOnlySlice, "2026-09-22").appointmentsUpcoming).toBe(0);
    expect(countOpsDashboard(fullLiveSet, "2026-09-22").appointmentsUpcoming).toBe(2);
  });

  it("counts future appointment dates under appointmentsUpcoming (not today)", () => {
    const counts = countOpsDashboard(
      [
        buildRow({
          caseId: "today",
          caseStatus: "APPOINTMENT_SET",
          appointmentDate: "2026-09-22",
        }),
        buildRow({
          caseId: "tomorrow",
          caseStatus: "READY_FOR_SUBMISSION",
          appointmentDate: "2026-09-25",
        }),
        buildRow({
          caseId: "past",
          caseStatus: "APPOINTMENT_SET",
          appointmentDate: "2026-09-01",
        }),
      ],
      "2026-09-22",
    );

    expect(counts.appointmentsToday).toBe(1);
    expect(counts.appointmentsUpcoming).toBe(1);
  });
});
