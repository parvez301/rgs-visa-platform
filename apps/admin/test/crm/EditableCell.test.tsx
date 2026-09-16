import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { crm } from "@rgs/shared";
import { EditableCell } from "../../src/crm/ledger/EditableCell";

function buildRow(overrides: Partial<crm.LedgerRow> = {}): crm.LedgerRow {
  return {
    caseId: "case_1",
    caseRef: "RGS-1001",
    partnerId: "partner_1",
    destinationCountry: "AE",
    caseType: "VISA",
    visaType: "TOURIST",
    caseStatus: "IN_PROGRESS",
    billingStatus: "UNBILLED",
    receivedDate: "2026-01-01",
    appointmentDate: "2026-02-01",
    totalInr: 10000,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EditableCell", () => {
  it("opens on Enter and closes on Escape with the old value intact", () => {
    const onCommit = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    const { container } = render(
      <EditableCell column="caseStatus" row={row} onCommit={onCommit} isEditing={false} />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(container.textContent).toContain("In progress");

    const staticWrapper = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(staticWrapper, { key: "Enter" });

    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();

    fireEvent.keyDown(select, { key: "Escape" });

    // Closed, and nothing was ever committed -- the old value is what is
    // still on screen because `row` itself was never touched.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(container.textContent).toContain("In progress");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on blur", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    render(<EditableCell column="caseStatus" row={row} onCommit={onCommit} isEditing />);

    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "APPOINTMENT_SET");
    // Tabbing away is a real blur, not a synthetic one dispatched by hand.
    await user.tab();

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("APPOINTMENT_SET");
  });

  it("commits and stays open on Cmd+Enter", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    render(<EditableCell column="caseStatus" row={row} onCommit={onCommit} isEditing />);

    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "SUBMITTED");
    fireEvent.keyDown(select, { key: "Enter", metaKey: true });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("SUBMITTED");
    // Cmd+Enter commits without closing -- the widget is still the one on
    // screen, ready for another change.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("closes without committing a no-op blur (the value never actually changed)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    render(<EditableCell column="caseStatus" row={row} onCommit={onCommit} isEditing />);

    await user.tab();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("offers only the transitions the state machine allows from here", () => {
    // A dropdown listing every CASE_STATUS invites a desk agent to pick one
    // that 409s. crm.canTransitionCaseStatus is the same rule the server
    // enforces, so the list and the server agree by construction.
    const row = buildRow({ caseStatus: "DECIDED" });
    render(<EditableCell column="caseStatus" row={row} onCommit={vi.fn()} isEditing />);

    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(optionLabels).toContain("Closed");
    expect(optionLabels).not.toContain("New");
  });

  it("offers only the billing transitions the state machine allows from here", () => {
    const row = buildRow({ billingStatus: "PAID" });
    render(<EditableCell column="billingStatus" row={row} onCommit={vi.fn()} isEditing />);

    // PAID has no forward transitions at all -- the only option left is the
    // current value itself.
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(optionLabels).toEqual(["Paid"]);
  });

  it("renders a date input for appointmentDate and a select for the two axes", () => {
    const row = buildRow();
    const { rerender } = render(
      <EditableCell column="appointmentDate" row={row} onCommit={vi.fn()} isEditing />,
    );
    const dateInput = screen.getByDisplayValue(row.appointmentDate!);
    expect(dateInput).toHaveAttribute("type", "date");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    rerender(<EditableCell column="caseStatus" row={row} onCommit={vi.fn()} isEditing />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();

    rerender(<EditableCell column="billingStatus" row={row} onCommit={vi.fn()} isEditing />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("writes nothing when the appointment date is cleared, because the PUT body cannot unset it", async () => {
    // The twin of `CasePage.test.tsx`'s test of the same name. G3: this file's
    // only `appointmentDate` test asserted the input's TYPE and never committed
    // one, and every commit test here used `caseStatus` -- so `commitDraft("")`
    // -> `updateCaseDetails({ appointmentDate: "" })` -> `isoDateBody` 400 ->
    // silent rollback had no coverage at either end.
    const onCommit = vi.fn();
    const onCloseEditor = vi.fn();
    const row = buildRow({ appointmentDate: "2026-02-01" });
    const { container } = render(
      <EditableCell
        column="appointmentDate"
        row={row}
        onCommit={onCommit}
        isEditing
        onCloseEditor={onCloseEditor}
      />,
    );

    const dateInput = screen.getByDisplayValue("2026-02-01");
    fireEvent.change(dateInput, { target: { value: "" } });
    // The draft really was cleared -- without this the assertion below is about
    // an input that never changed, which no guard is needed to keep quiet.
    expect(dateInput).toHaveValue("");

    fireEvent.blur(dateInput);

    expect(onCommit).not.toHaveBeenCalled();
    // A no-op, not a stuck editor: the cell closes and hands the grid its
    // `editing` state back, or the arrow keys stay dead afterwards.
    expect(onCloseEditor).toHaveBeenCalledOnce();
    expect(container.querySelector("input")).toBeNull();
    // And the row's own stored value is what is on screen again, so nothing
    // claims the date was cleared.
    expect(container.textContent).toContain("2026-02-01");
  });

  it("disables the visaType select, with a reason, when the case is not a VISA case", () => {
    // CrmCaseSchema refuses a visaType on a non-VISA case -- offering the
    // control here would let a desk agent trigger a 400 that reads as a
    // mystery, so it is disabled with a title explaining why instead.
    const row = buildRow({ caseType: "ATTESTATION", visaType: undefined });
    render(<EditableCell column="visaType" row={row} onCommit={vi.fn()} isEditing />);

    const select = screen.getByRole("combobox");
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("title", expect.stringContaining("VISA"));
  });

  it("enables the visaType select, listing every VISA_TYPE, on a VISA case", () => {
    const row = buildRow({ caseType: "VISA", visaType: "TOURIST" });
    render(<EditableCell column="visaType" row={row} onCommit={vi.fn()} isEditing />);

    const select = screen.getByRole("combobox");
    expect(select).not.toBeDisabled();
    expect(screen.getAllByRole("option")).toHaveLength(crm.VISA_TYPES.length);
  });

  it("tells the grid to close its own editing state after a commit-and-close", async () => {
    const user = userEvent.setup();
    const onCloseEditor = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    render(
      <EditableCell column="caseStatus" row={row} onCommit={vi.fn()} isEditing onCloseEditor={onCloseEditor} />,
    );

    await user.selectOptions(screen.getByRole("combobox"), "APPOINTMENT_SET");
    await user.tab();

    expect(onCloseEditor).toHaveBeenCalledOnce();
  });

  it("does not tell the grid to close on a commit-and-stay", () => {
    const onCloseEditor = vi.fn();
    const row = buildRow({ caseStatus: "IN_PROGRESS" });
    render(
      <EditableCell column="caseStatus" row={row} onCommit={vi.fn()} isEditing onCloseEditor={onCloseEditor} />,
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });

    expect(onCloseEditor).not.toHaveBeenCalled();
  });
});
