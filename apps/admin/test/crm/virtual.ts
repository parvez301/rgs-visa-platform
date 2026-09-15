import { render, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect } from "vitest";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { AuthContext, type AuthState } from "../../src/lib/auth";
import { UndoToastProvider } from "../../src/crm/UndoToast";
import { AgentPanelProvider } from "../../src/crm/agent/AgentPanelProvider";

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

/**
 * The element carrying one mounted row's GRID SEMANTICS -- `role="row"`,
 * `aria-selected`, `aria-expanded`.
 *
 * Deliberately not the same element as `[data-testid='ledger-row']`, which is
 * the positioned wrapper the virtualizer transforms and sizes, and which
 * carries no role at all: a `row`'s required owned elements are its
 * `gridcell`s, so a generic container between the two drops every cell out of
 * the row in the computed accessibility tree (fix round 1, F5). Tests that
 * measure POSITION want the wrapper; tests that assert SELECTION or
 * EXPANSION want this.
 */
export function mountedGridRow(container: HTMLElement, caseId: string): HTMLElement {
  const gridRowElement = container.querySelector<HTMLElement>(
    `[data-testid='ledger-row'][data-case-id='${caseId}'] [role='row']`,
  );
  if (gridRowElement === null) {
    throw new Error(
      `Case ${caseId} has no role="row" element among the mounted rows ` +
        `(${mountedCaseIds(container, { allowEmpty: true }).join(", ") || "none"}).`,
    );
  }
  return gridRowElement;
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

/**
 * A fixed, signed-in `AuthState` for `LedgerTable`'s own `useLedgerEdit` call
 * (Task 12), which reads `idToken` via `useAuth()`. Supplied through the
 * real `AuthContext` rather than a per-file `vi.mock` of the whole auth
 * module -- one fixture here covers every test that renders `LedgerTable`
 * through this helper, instead of each test file needing its own mock.
 */
const TEST_AUTH_STATE: AuthState = {
  isLoading: false,
  isSignedIn: true,
  email: "agent@example.com",
  idToken: "test-id-token",
  needsNewPassword: false,
  signIn: async () => "signedIn",
  completeNewPassword: async () => {},
  signOut: () => {},
};

/**
 * `LedgerTable` now calls `useLedgerEdit()` (Task 12) unconditionally, which
 * needs a `QueryClientProvider` (for the optimistic cache work) and an
 * `UndoToastProvider` (for the undo toast) as ancestors, on top of the auth
 * context above. A fresh `QueryClient` per render keeps one test's cache
 * from leaking into the next.
 */
export function renderLedger(element: ReactElement): RenderResult & {
  /**
   * Re-renders a NEW element inside the very same providers and the very same
   * `QueryClient` -- what `LedgerPage` does when a client-side filter changes
   * `rows` (Task 13). `RenderResult.rerender` cannot be used directly for
   * that: it replaces the whole tree, so it would drop the auth/query/toast
   * providers this helper wrapped the element in.
   */
  rerenderLedger: (nextElement: ReactElement) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Plain `createElement` rather than JSX -- this file is `.ts`, not `.tsx`
  // (see the brief's own note that it stays `virtual.ts`), and TypeScript
  // refuses JSX syntax outside a `.tsx` file regardless of the `jsx` compiler
  // option.
  // `AgentPanelProvider` from Task 15 on: `CrmLayout`'s right column holds the
  // agent panel, whose conversation lives in a provider mounted above the
  // routes in `main.tsx` (R63). `useAgentPanelSession` throws without it --
  // deliberately, because a silent local-state fallback would lose the
  // conversation on every navigation -- so the harness mounts the same
  // provider production does.
  // `MemoryRouter` from Task 14 on: the Ledger's REF cell is a `<Link>` to
  // `/crm/cases/:caseId` (spec §5, "reached by clicking a REF"), and
  // react-router's `useHref` throws outside a router. In production
  // `LedgerTable` is always inside `BrowserRouter` -- `AdminShell`'s own header
  // links have required one since long before this task -- so this restores
  // the harness to what the component already assumes, rather than relaxing
  // anything the component needs.
  function wrapInProviders(elementToWrap: ReactElement) {
    return createElement(
      AuthContext.Provider,
      { value: TEST_AUTH_STATE },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          UndoToastProvider,
          null,
          createElement(
            AgentPanelProvider,
            null,
            createElement(MemoryRouter, null, elementToWrap),
          ),
        ),
      ),
    );
  }

  const result = render(wrapInProviders(element));
  // Fail fast, once, at the render rather than at the first confusing
  // assertion three lines later.
  expect(result.container.querySelector("[data-testid='ledger-scroll']")).not.toBeNull();
  return {
    ...result,
    rerenderLedger: (nextElement: ReactElement) => {
      result.rerender(wrapInProviders(nextElement));
    },
  };
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
