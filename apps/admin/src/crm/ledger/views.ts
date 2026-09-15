import { crm } from "@rgs/shared";
import type { LedgerFilters, LedgerSort } from "./filters";

/** Task 13's "Produces" interface, verbatim. */
export interface LedgerView {
  viewId: string;
  name: string;
  filters: LedgerFilters;
  sort: LedgerSort;
}

/**
 * The default sort for the two built-in views the brief does not name a
 * sort for ("Awaiting payment", "Everything"). "Live work" has an explicit
 * one (`receivedDate` desc); these two get the same ordering rather than an
 * arbitrary different one, so a desk agent moving between built-in views
 * does not also have to re-learn a new sort each time.
 */
const DEFAULT_BUILT_IN_SORT: LedgerSort = { column: "receivedDate", direction: "desc" };

const LIVE_WORK_VIEW_ID = "built-in-live-work";
const AWAITING_PAYMENT_VIEW_ID = "built-in-awaiting-payment";
const EVERYTHING_VIEW_ID = "built-in-everything";

const BUILT_IN_VIEW_IDS: readonly string[] = [LIVE_WORK_VIEW_ID, AWAITING_PAYMENT_VIEW_ID, EVERYTHING_VIEW_ID];

/** Exported so `ViewChips` can decide whether to offer a delete affordance at all. */
export function isBuiltInLedgerViewId(viewId: string): boolean {
  return BUILT_IN_VIEW_IDS.includes(viewId);
}

/**
 * The three views a desk agent lands on before anyone has saved anything
 * (brief, "Three built-in views ship, and cannot be deleted"). Built fresh
 * on every call rather than read from storage -- they are not data, they
 * are the product's own fixed defaults, so there is nothing to round-trip
 * through `localStorage` and nothing there can ever go stale or get lost.
 */
export function builtInLedgerViews(): LedgerView[] {
  return [
    {
      viewId: LIVE_WORK_VIEW_ID,
      name: "Live work",
      filters: { statuses: [...crm.LIVE_CASE_STATUSES] },
      sort: { column: "receivedDate", direction: "desc" },
    },
    {
      viewId: AWAITING_PAYMENT_VIEW_ID,
      name: "Awaiting payment",
      // All nine statuses (brief: "all statuses"): a case can be owed money
      // in any state, including a closed one.
      filters: { statuses: [...crm.CASE_STATUSES], billingStatuses: ["BILL_SENT", "PART_PAID"] },
      sort: DEFAULT_BUILT_IN_SORT,
    },
    {
      viewId: EVERYTHING_VIEW_ID,
      name: "Everything",
      filters: { statuses: [...crm.CASE_STATUSES] },
      sort: DEFAULT_BUILT_IN_SORT,
    },
  ];
}

function storageKeyFor(userEmail: string): string {
  return `rgs.crm.views.${userEmail}`;
}

function isPlausibleLedgerView(candidateValue: unknown): candidateValue is LedgerView {
  if (typeof candidateValue !== "object" || candidateValue === null) return false;
  const candidateView = candidateValue as Record<string, unknown>;
  return (
    typeof candidateView["viewId"] === "string" &&
    typeof candidateView["name"] === "string" &&
    typeof candidateView["filters"] === "object" &&
    candidateView["filters"] !== null &&
    typeof candidateView["sort"] === "object" &&
    candidateView["sort"] !== null
  );
}

/**
 * Everything a corrupt or unparseable stored value could throw -- a bad
 * JSON string, a `localStorage` that itself throws on `getItem` (private
 * window, cleared site data, a hostile SecurityError) -- lands here and
 * comes back as "no saved views", never as an exception that reaches
 * `LedgerPage`. "One bad row must not kill the screen" (brief) applies to
 * this store exactly as it does to the backend's own.
 */
function readSavedViewsOnly(userEmail: string): LedgerView[] {
  try {
    const storedValue = localStorage.getItem(storageKeyFor(userEmail));
    if (storedValue === null) return [];
    const parsedValue: unknown = JSON.parse(storedValue);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.filter(isPlausibleLedgerView);
  } catch {
    return [];
  }
}

/**
 * The built-ins, always present and always first, followed by whatever this
 * user has saved. `userEmail` namespaces the storage key (brief: "two
 * admins sharing a browser do not inherit each other's views").
 */
export function loadViews(userEmail: string): LedgerView[] {
  return [...builtInLedgerViews(), ...readSavedViewsOnly(userEmail)];
}

/**
 * A `localStorage` write that throws must not take the Ledger down either:
 * the view simply does not persist, and the desk agent keeps working with
 * the in-memory list until they save again somewhere that allows it.
 *
 * Saving over a built-in view's id is refused for the same reason deleting
 * one is (below): built-in ids are reserved, not just protected from
 * deletion, and a custom view silently squatting on `built-in-live-work`
 * would otherwise appear as a second, differently-configured "Live work" the
 * moment `loadViews` concatenates the two lists.
 */
export function saveView(userEmail: string, view: LedgerView): void {
  if (isBuiltInLedgerViewId(view.viewId)) return;
  try {
    const existingSavedViews = readSavedViewsOnly(userEmail);
    const nextSavedViews = [
      ...existingSavedViews.filter((existingView) => existingView.viewId !== view.viewId),
      view,
    ];
    localStorage.setItem(storageKeyFor(userEmail), JSON.stringify(nextSavedViews));
  } catch {
    // Nothing to do: the write failed, the in-memory list is still correct.
  }
}

/** Refuses to delete a built-in view (brief: "and cannot be deleted"). */
export function deleteView(userEmail: string, viewId: string): void {
  if (isBuiltInLedgerViewId(viewId)) return;
  try {
    const existingSavedViews = readSavedViewsOnly(userEmail);
    const nextSavedViews = existingSavedViews.filter((existingView) => existingView.viewId !== viewId);
    localStorage.setItem(storageKeyFor(userEmail), JSON.stringify(nextSavedViews));
  } catch {
    // Nothing to do: the write failed, the in-memory list is still correct.
  }
}
