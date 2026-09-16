import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { crm } from "@rgs/shared";
import {
  AxisChip,
  BILLING_TINTS,
  CASE_STATUS_TINTS,
  CUSTODY_TINTS,
  OUTCOME_TINTS,
} from "../../src/crm/components/Chip";

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

describe("AxisChip colour mapping", () => {
  it("gives every case status a tint, and the three phases of a case's life three different hues", () => {
    for (const caseStatus of crm.CASE_STATUSES) {
      expect(CASE_STATUS_TINTS[caseStatus]).toMatch(/^bg-[a-z]+-\d+ text-[a-z]+-\d+$/);
    }
    const hueOf = (tint: string) => tint.split(" ")[0]!;
    // A fresh case, a filed case and a decided case must not share a hue: the
    // grid is scanned by colour before it is read.
    expect(new Set([CASE_STATUS_TINTS.NEW, CASE_STATUS_TINTS.SUBMITTED, CASE_STATUS_TINTS.DECIDED].map(hueOf)).size).toBe(3);
    // Abandoned work reads as such.
    expect(hueOf(CASE_STATUS_TINTS.NOT_SUBMITTED)).toBe(hueOf(CASE_STATUS_TINTS.WITHDRAWN));
    expect(hueOf(CASE_STATUS_TINTS.NOT_SUBMITTED)).not.toBe(hueOf(CASE_STATUS_TINTS.DECIDED));
  });

  it("covers every custody, outcome and billing value", () => {
    for (const custody of crm.CUSTODY_STATUSES) expect(CUSTODY_TINTS[custody]).toBeTruthy();
    for (const outcome of crm.APPLICANT_OUTCOMES) expect(OUTCOME_TINTS[outcome]).toBeTruthy();
    for (const billing of crm.BILLING_STATUSES) expect(BILLING_TINTS[billing]).toBeTruthy();
  });

  it("paints UNKNOWN billing as attention, not as a neutral value", () => {
    expect(BILLING_TINTS.UNKNOWN).not.toBe(BILLING_TINTS.UNBILLED);
    expect(BILLING_TINTS.UNKNOWN).toContain("amber");
  });
});
