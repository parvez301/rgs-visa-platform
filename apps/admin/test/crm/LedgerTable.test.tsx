import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { LedgerTable } from "../../src/crm/ledger/LedgerTable";
import { mountedCaseIds, mountedCell, renderLedger, scrollLedgerTo } from "./virtual";

function buildRows(rowCount: number): crm.LedgerRow[] {
  return Array.from({ length: rowCount }, (_unused, rowIndex) => ({
    caseId: `case_${String(rowIndex).padStart(4, "0")}`,
    caseRef: `RGS-${1000 + rowIndex}`,
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA" as const,
    visaType: "TOURIST" as const,
    caseStatus: "IN_PROGRESS" as const,
    billingStatus: "UNKNOWN" as const,
    receivedDate: "2026-03-04",
    totalInr: 12000,
    updatedAt: "2026-03-04T10:00:00.000Z",
    applicantSummary: { count: 3, custody: { AT_EMBASSY: 2, WITH_RGS: 1 }, outcome: { PENDING: 3 } },
  }));
}

const partnerNames = { partner_1: "Skyline Travels" };

describe("LedgerTable", () => {
  it("mounts a window of rows, not all 7,156", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );

    const mounted = mountedCaseIds(container);
    expect(mounted.length).toBeGreaterThan(5);
    // The whole reason for virtualizing. If this ever passes with 7,156, the
    // virtualizer has been bypassed and the screen will die on real data.
    expect(mounted.length).toBeLessThan(200);
    expect(mounted[0]).toBe("case_0000");
  });

  it("renders the spec's columns, in the spec's order", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(10)} partnerNamesById={partnerNames} />,
    );

    const headerKeys = [...container.querySelectorAll("[data-testid='ledger-header'] [data-column]")].map(
      (cell) => cell.getAttribute("data-column"),
    );
    expect(headerKeys).toEqual([
      "caseRef",
      "partner",
      "destinationCountry",
      "caseType",
      "applicants",
      "caseStatus",
      "billingStatus",
      "receivedDate",
      "appointmentDate",
      "totalInr",
    ]);
  });

  it("shows the partner's canonical name, not the partner id", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "partner").textContent).toBe("Skyline Travels");
  });

  it("carries the custody roll-up on the collapsed parent row", () => {
    // Spec §4: the collapsed parent must carry enough per-applicant signal
    // that expanding is rarely needed, and the roll-up comes from the META
    // item's summary -- the row never reads applicant records.
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(5)} partnerNamesById={partnerNames} />,
    );

    const applicantsCell = mountedCell(container, "case_0000", "applicants");
    expect(applicantsCell.textContent).toContain("3");
    expect(applicantsCell.textContent).toContain("2 at embassy · 1 with us");
  });

  it("says 'Not summarised' for a case imported before the roll-up existed", () => {
    const [rowWithoutSummary] = buildRows(1);
    const { applicantSummary: _dropped, ...bareRow } = rowWithoutSummary!;
    const { container } = renderLedger(
      <LedgerTable rows={[bareRow]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "applicants").textContent).toContain("Not summarised");
  });

  it("marks an UNKNOWN billing status as import debt", () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(3)} partnerNamesById={partnerNames} />,
    );

    expect(mountedCell(container, "case_0000", "billingStatus").innerHTML).toContain("border-dashed");
  });

  it("mounts a different window after scrolling, and the far row really is there", async () => {
    const { container } = renderLedger(
      <LedgerTable rows={buildRows(7156)} partnerNamesById={partnerNames} />,
    );
    expect(mountedCaseIds(container)).not.toContain("case_3000");

    await scrollLedgerTo(container, 3000 * 32);

    // Asserted against a row the virtualizer actually mounted -- this is the
    // mechanism spec §10 asks the plan to name.
    expect(mountedCaseIds(container)).toContain("case_3000");
    expect(mountedCell(container, "case_3000", "caseRef").textContent).toBe("RGS-4000");
  });

  it("renders an empty ledger as an empty state rather than a broken table", () => {
    const { container, getByText } = renderLedger(
      <LedgerTable rows={[]} partnerNamesById={partnerNames} />,
    );

    expect(mountedCaseIds(container, { allowEmpty: true })).toEqual([]);
    expect(getByText(/no cases/i)).toBeInTheDocument();
  });
});
