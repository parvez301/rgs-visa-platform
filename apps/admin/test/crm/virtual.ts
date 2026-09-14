import { render, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";
import type { ReactElement } from "react";

/**
 * Rows the virtualizer ACTUALLY mounted, with a guard.
 *
 * A query for a row that was never rendered passes trivially, which is spec
 * §10's first named trap. Every assertion about row content must be made
 * against this function's output, and this function refuses to hand back an
 * empty list without saying why -- so a test that stops seeing rows fails as
 * "the virtualizer mounted nothing" rather than as a quietly true assertion
 * about an empty set.
 */
export function mountedCaseIds(container: HTMLElement, options: { allowEmpty?: boolean } = {}): string[] {
  const rowElements = [...container.querySelectorAll("[data-testid='ledger-row']")];
  if (rowElements.length === 0 && options.allowEmpty !== true) {
    throw new Error(
      "The virtualizer mounted no ledger rows. Either the scroll container measured zero " +
        "(check test/setup.ts's offsetHeight shim) or the table rendered nothing. Pass " +
        "{ allowEmpty: true } if an empty table is what this test is asserting.",
    );
  }
  return rowElements.map((rowElement) => rowElement.getAttribute("data-case-id") ?? "");
}

/** The cell of one mounted row, by column key. Throws if the row is not mounted. */
export function mountedCell(container: HTMLElement, caseId: string, columnKey: string): HTMLElement {
  const rowElement = container.querySelector(`[data-testid='ledger-row'][data-case-id='${caseId}']`);
  if (rowElement === null) {
    throw new Error(
      `Case ${caseId} is not among the mounted rows (${mountedCaseIds(container, { allowEmpty: true }).join(", ") || "none"}). ` +
        "Scroll it into the window before asserting on it.",
    );
  }
  const cellElement = rowElement.querySelector(`[data-column='${columnKey}']`);
  if (cellElement === null) throw new Error(`Row ${caseId} has no column ${columnKey}`);
  return cellElement as HTMLElement;
}

/** Scrolls the table's own scroll container and lets the virtualizer re-measure. */
export async function scrollLedgerTo(container: HTMLElement, scrollTop: number): Promise<void> {
  const scrollContainer = container.querySelector("[data-testid='ledger-scroll']");
  if (scrollContainer === null) throw new Error("No ledger scroll container in this render");
  scrollContainer.scrollTop = scrollTop;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function renderLedger(element: ReactElement): RenderResult {
  const result = render(element);
  // Fail fast, once, at the render rather than at the first confusing
  // assertion three lines later.
  expect(result.container.querySelector("[data-testid='ledger-scroll']")).not.toBeNull();
  return result;
}
