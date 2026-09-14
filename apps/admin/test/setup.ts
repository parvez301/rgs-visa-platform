import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom has no layout engine: every element reports a zero-sized rect and
 * zero client dimensions. TanStack Virtual measures its scroll container to
 * decide what to mount, so under jsdom it mounts NOTHING -- and a test that
 * queries for a row then passes on `expect(rows).toHaveLength(0)` has tested
 * nothing at all. This is spec §10's first named trap.
 *
 * Giving the JSDOM element prototypes a real size is what makes the
 * virtualizer mount a real window of rows, so an assertion about row content
 * is an assertion about something that exists. `installVirtualViewport` in
 * test/crm/virtual.ts is the per-test knob; this is the floor.
 */
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement): number {
    return Number(this.dataset?.["testHeight"] ?? 800);
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement): number {
    return Number(this.dataset?.["testWidth"] ?? 1400);
  },
});
