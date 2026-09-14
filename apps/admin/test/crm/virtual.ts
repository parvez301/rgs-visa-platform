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

/**
 * Makes `@tanstack/react-virtual`'s `rowVirtualizer.scrollToIndex()` actually
 * move the mounted window under jsdom. Call this once, at the top of any test
 * file that drives the virtualizer programmatically (keyboard-driven
 * scrolling, an editor scrolling itself into view, an expanded sub-row
 * pushing later rows down -- Tasks 12 and 13 will both need this). Do not put
 * this in the shared `test/setup.ts`: a shim every test gets for free is one
 * nobody knows is load-bearing, and `mountedCaseIds`'s whole design is that a
 * test asks for the guarantee it needs.
 *
 * Two independent jsdom gaps, found while wiring Task 11's keyboard
 * navigation, both of which leave `scrollToIndex` looking like it ran but
 * moving nothing:
 *
 * 1. **jsdom 25 has no `Element.scrollTo` at all** -- confirmed by
 *    construction: `typeof element.scrollTo` is `undefined`, and calling it
 *    throws `TypeError: ... is not a function`. react-virtual's default
 *    `scrollToFn` (`scrollWithAdjustments`) calls
 *    `scrollElement.scrollTo?.(...)`, so under plain jsdom this is a *silent*
 *    no-op -- it never throws, it just never moves anything.
 *
 *    A real browser's `scrollTo` both sets the scroll position and fires the
 *    'scroll' event react-virtual's `observeElementOffset` listens for (the
 *    same event `scrollLedgerTo` above dispatches by hand for mouse-driven
 *    scrolling) -- but a real browser fires that event *asynchronously* (the
 *    next frame), never inside the synchronous call to `scrollTo` itself.
 *    Dispatching it synchronously here is still observably different from a
 *    real browser: it re-enters react-virtual's own `flushSync(rerender)`
 *    while a caller that scrolls from inside a React commit (a `useEffect`,
 *    as `LedgerTable` does) is still rendering, which produces a "flushSync
 *    was called from inside a lifecycle method" console warning. React does
 *    not drop the update over this -- it still lands, just with the warning
 *    -- so a synchronous dispatch does not make a correctly-written test fail
 *    (verified: 13/13 runs warn and still pass). Deferring with `setTimeout`
 *    is kept anyway because it is what a real `scrollTo` actually does, and
 *    a shim that lies about a browser's own timing papers over nothing.
 *
 * 2. **`getMaxScrollOffset()` (react-virtual) reads `scrollElement.scrollHeight
 *    - scrollElement.clientHeight`**, and jsdom leaves both at `0` (no layout
 *    engine; neither is touched by `test/setup.ts`'s `offsetHeight`/
 *    `offsetWidth` shim, which only sizes the *viewport* for the mount-window
 *    calculation). With both stuck at `0`, `getOffsetForAlignment`'s clamp
 *    (`Math.min(maxOffset, toOffset)`) collapses every computed scroll target
 *    back to `0` regardless of which row was asked for -- this is the gap
 *    that actually leaves the mounted window frozen, independent of #1 and
 *    present even once #1 is fixed. `clientHeight` is shimmed to mirror
 *    `offsetHeight`; `scrollHeight` to a constant large enough for any row
 *    count this suite renders.
 */
export function installVirtualScrolling(): void {
  if (typeof HTMLElement.prototype.scrollTo !== "function") {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, xCoordinateOrOptions?: ScrollToOptions | number, maybeYCoordinate?: number) {
        if (typeof xCoordinateOrOptions === "object" && xCoordinateOrOptions !== null) {
          if (xCoordinateOrOptions.top !== undefined) this.scrollTop = xCoordinateOrOptions.top;
          if (xCoordinateOrOptions.left !== undefined) this.scrollLeft = xCoordinateOrOptions.left;
        } else {
          if (xCoordinateOrOptions !== undefined) this.scrollLeft = xCoordinateOrOptions;
          if (maybeYCoordinate !== undefined) this.scrollTop = maybeYCoordinate;
        }
        const scrollTargetElement = this;
        setTimeout(() => {
          scrollTargetElement.dispatchEvent(new Event("scroll"));
        }, 0);
      },
    });
  }

  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      return this.offsetHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(): number {
      return 10_000_000;
    },
  });
}
