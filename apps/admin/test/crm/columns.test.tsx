import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import { LEDGER_COLUMNS } from "../../src/crm/ledger/columns";

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_1",
    caseRef: "RGS-2026-0912",
    partnerId: "partner_1",
    destinationCountry: "FR",
    caseType: "VISA",
    caseStatus: "NEW",
    billingStatus: "UNBILLED",
    receivedDate: "2026-09-20",
    totalInr: 0,
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const refColumn = LEDGER_COLUMNS.find((column) => column.key === "caseRef")!;

describe("REF column", () => {
  it("renders the group name as a second line under the REF", () => {
    render(
      <MemoryRouter>{refColumn.render(buildRow({ groupName: "Sharma Family" }), "Skyline Travels", { isFocusedRow: false })}</MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "RGS-2026-0912" })).toBeInTheDocument();
    expect(screen.getByText("Sharma Family")).toBeInTheDocument();
  });

  it("renders no second line when the case has no group name", () => {
    const { container } = render(
      <MemoryRouter>{refColumn.render(buildRow(), "Skyline Travels", { isFocusedRow: false })}</MemoryRouter>,
    );
    expect(container.querySelector("[data-testid='ledger-group-name']")).toBeNull();
  });
});
