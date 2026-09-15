import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { crm } from "@rgs/shared";
import { ViewChips } from "../../src/crm/ledger/ViewChips";
import type { LedgerFilters, LedgerSort } from "../../src/crm/ledger/filters";

/**
 * The saved-views chip row, which the Task 13 review found had no test at all
 * -- and which is where the silent-save-failure defect (fix round 1, F4)
 * lives. `views.ts` is exercised directly by `views.test.ts`; this file is
 * about what the desk agent is shown when that module succeeds and when it
 * fails.
 */
const ACTIVE_FILTERS: LedgerFilters = { statuses: ["NEW"] as crm.CaseStatus[], destinationCountry: "AE" };
const ACTIVE_SORT: LedgerSort = { column: "receivedDate", direction: "desc" };

function renderViewChips() {
  const onApplyView = vi.fn();
  const result = render(
    <ViewChips
      userEmail="ops@rgs.test"
      activeFilters={ACTIVE_FILTERS}
      activeSort={ACTIVE_SORT}
      onApplyView={onApplyView}
    />,
  );
  return { ...result, onApplyView };
}

/** Walks the naming flow a desk agent walks: open the box, name it, press Save. */
async function saveCurrentViewAs(user: ReturnType<typeof userEvent.setup>, viewName: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: "+ Save current view" }));
  await user.type(screen.getByLabelText("Name this view"), viewName);
  await user.click(screen.getByRole("button", { name: "Save" }));
}

function pressedChipNames(): string[] {
  return screen
    .getAllByTestId("view-chip")
    .filter((chipElement) => chipElement.getAttribute("aria-pressed") === "true")
    .map((chipElement) => chipElement.textContent ?? "");
}

describe("ViewChips", () => {
  it("ships the three built-in views and offers no delete affordance for them", () => {
    renderViewChips();

    expect(screen.getAllByTestId("view-chip").map((chip) => chip.textContent)).toEqual([
      "Live work",
      "Awaiting payment",
      "Everything",
    ]);
    expect(screen.queryByRole("button", { name: /^Delete the/ })).not.toBeInTheDocument();
  });

  it("saves the current filters under a name, presses its chip and says nothing about failure", async () => {
    const user = userEvent.setup();
    renderViewChips();

    await saveCurrentViewAs(user, "Dubai rush");

    expect(screen.getByRole("button", { name: "Dubai rush" })).toBeInTheDocument();
    expect(pressedChipNames()).toEqual(["Dubai rush"]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says the view could not be saved instead of dropping it silently (fix round 1, F4)", async () => {
    // A private window, cleared site data, or a full quota. The view list is
    // re-read from storage right after every save, so a swallowed failure
    // leaves the desk agent looking at a chip row their new view is simply
    // absent from.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const user = userEvent.setup();
    renderViewChips();

    await saveCurrentViewAs(user, "Dubai rush");

    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not save this view — storage is unavailable",
    );
    expect(screen.queryByRole("button", { name: "Dubai rush" })).not.toBeInTheDocument();
    // And no chip is marked active either: marking the id of a view that was
    // never stored leaves every chip unpressed with no explanation, which is
    // the same silence in a second place.
    expect(pressedChipNames()).toEqual([]);
  });

  it("keeps the product's one accent colour off the Save button (fix round 1, F3)", async () => {
    // Global constraint: `--crm-primary` marks exactly one control in the
    // product -- Approve on an agent proposal card -- and explicitly not
    // Save. A className assertion because the constraint IS about the
    // treatment: there is nothing else on screen to read it off.
    const user = userEvent.setup();
    renderViewChips();
    await user.click(screen.getByRole("button", { name: "+ Save current view" }));

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton.className).not.toContain("crm-primary");
    expect(saveButton.className).not.toContain("crm-lavender");
    expect(saveButton.className).toContain("border-crm-rule-box");
  });
});
