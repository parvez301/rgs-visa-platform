import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AxisChip } from "../../src/crm/components/Chip";

describe("AxisChip", () => {
  it("renders the label, never the enum", () => {
    render(<AxisChip axis="custody" value="AT_EMBASSY" />);
    expect(screen.getByText("At embassy")).toBeInTheDocument();
    expect(screen.queryByText("AT_EMBASSY")).not.toBeInTheDocument();
  });

  it("tints a live case status differently from a decided one", () => {
    const { container: liveChip } = render(<AxisChip axis="caseStatus" value="IN_PROGRESS" />);
    const { container: decidedChip } = render(<AxisChip axis="caseStatus" value="DECIDED" />);
    expect(liveChip.firstElementChild?.className).not.toBe(decidedChip.firstElementChild?.className);
  });

  it("marks an UNKNOWN billing status as data debt, with a dashed border", () => {
    render(<AxisChip axis="billing" value="UNKNOWN" />);
    const chip = screen.getByText("Unknown");
    // Spec §3: UNKNOWN is not a state the business chose, it is what the
    // importer wrote when it could not read the sheet. It must not look like
    // a value someone decided on.
    expect(chip.className).toContain("border-dashed");
    expect(chip).toHaveAttribute("title", expect.stringContaining("import"));
  });

  it("gives UNBILLED a solid border, so debt and a real state are told apart", () => {
    render(<AxisChip axis="billing" value="UNBILLED" />);
    expect(screen.getByText("Unbilled").className).not.toContain("border-dashed");
  });
});
