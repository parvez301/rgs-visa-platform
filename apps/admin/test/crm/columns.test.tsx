import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import {
  collapsedLedgerRowHeight,
  LEDGER_COLUMNS,
  LEDGER_ROW_HEIGHT,
} from "../../src/crm/ledger/columns";

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

  it("lists only extra family REF NOs under the case REF (no duplicate)", () => {
    render(
      <MemoryRouter>
        {refColumn.render(
          buildRow({
            caseRef: "38599",
            groupName: "CHRISTI FAMILY",
            applicantRefs: ["38599", "38600", "38601", "38602"],
          }),
          "Paradise Tours",
          { isFocusedRow: false },
        )}
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "38599" })).toBeInTheDocument();
    expect(screen.getByTestId("ledger-applicant-refs")).toHaveTextContent("+38600 · 38601 · 38602");
    expect(screen.getByText("CHRISTI FAMILY")).toBeInTheDocument();
  });

  it("hides the extras line when the only ref is the case REF", () => {
    const { container } = render(
      <MemoryRouter>
        {refColumn.render(buildRow({ caseRef: "38603", applicantRefs: ["38603"] }), "Customer", {
          isFocusedRow: false,
        })}
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-testid='ledger-applicant-refs']")).toBeNull();
  });
});

describe("collapsedLedgerRowHeight", () => {
  it("keeps solo rows at the base height", () => {
    expect(collapsedLedgerRowHeight(buildRow())).toBe(LEDGER_ROW_HEIGHT);
  });

  it("grows for family REF stacks so extras + group name fit", () => {
    const familyHeight = collapsedLedgerRowHeight(
      buildRow({
        caseRef: "38608",
        groupName: "PATANJALI FAMILY",
        applicantRefs: ["38608", "38609"],
      }),
    );
    expect(familyHeight).toBeGreaterThan(LEDGER_ROW_HEIGHT);
    expect(familyHeight).toBe(12 + 3 * 16);
  });
});
