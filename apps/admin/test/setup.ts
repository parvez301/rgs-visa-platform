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

/**
 * jsdom under this vitest config gives us the `Storage` CLASS but no
 * `localStorage` INSTANCE: `Object.prototype.toString.call(localStorage)` is
 * `[object Object]`, its prototype is `Object.prototype`, and `getItem` /
 * `setItem` / `removeItem` / `clear` are all `undefined`. So the very first
 * `localStorage.clear()` in a test's own `beforeEach` throws, and every test
 * in that file dies before it asserts anything.
 *
 * `views.ts` legitimately depends on the real thing -- it calls `localStorage`
 * directly and wraps every read and write in try/catch, which is exactly right
 * for a private window. Shimming the harness is therefore the fix, not a
 * storage seam in shipping code; a seam would let tests inject a fake and
 * delete the only thing the round-trip test proves, that the real per-email
 * key namespacing works.
 *
 * What a test that silently tolerated the absence would FALSELY prove: with no
 * working storage every read throws and falls back, so "falls back to the
 * built-in views when localStorage throws" passes whether or not the fallback
 * works at all. Only a round-trip through a storage that really stores can
 * tell those two apart. Same reason as the offsetHeight/offsetWidth shim
 * above: jsdom is missing a browser capability the product depends on, and a
 * test that tolerates the gap tests nothing.
 *
 * The methods go on `Storage.prototype`, not on the instance, because
 * views.test.ts's `vi.spyOn(Storage.prototype, "getItem")` intercepts have to
 * land on the same object `localStorage.getItem` resolves through -- that is
 * what makes the "localStorage throws" test able to make it throw.
 */
const localStorageBackingStore = new Map<string, string>();

Object.defineProperties(Storage.prototype, {
  getItem: {
    configurable: true,
    writable: true,
    // `null`, never `undefined`, for a missing key: `views.ts` tests
    // `storedValue === null` before parsing, exactly as the DOM spec says.
    value(storageKey: string): string | null {
      const storedValue = localStorageBackingStore.get(String(storageKey));
      return storedValue === undefined ? null : storedValue;
    },
  },
  setItem: {
    configurable: true,
    writable: true,
    // Real Storage coerces both key and value to strings; a shim that kept
    // the original type would let a test store a number and read one back,
    // proving a JSON round-trip the browser would never have performed.
    value(storageKey: string, storageValue: string): void {
      localStorageBackingStore.set(String(storageKey), String(storageValue));
    },
  },
  removeItem: {
    configurable: true,
    writable: true,
    value(storageKey: string): void {
      localStorageBackingStore.delete(String(storageKey));
    },
  },
  clear: {
    configurable: true,
    writable: true,
    value(): void {
      localStorageBackingStore.clear();
    },
  },
  key: {
    configurable: true,
    writable: true,
    value(keyIndex: number): string | null {
      return [...localStorageBackingStore.keys()][keyIndex] ?? null;
    },
  },
  length: {
    configurable: true,
    get(): number {
      return localStorageBackingStore.size;
    },
  },
});

const localStorageInstance = Object.create(Storage.prototype) as Storage;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  get(): Storage {
    return localStorageInstance;
  },
});

/**
 * One test file's keys must not leak into the next. Cleared through the
 * backing Map rather than through `localStorage.clear()` so a test that has
 * spied on or mocked `Storage.prototype.clear` cannot leave the store dirty
 * for whatever runs after it.
 */
afterEach(() => {
  localStorageBackingStore.clear();
});
