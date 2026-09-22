import { crm } from "@rgs/shared";
import type { LedgerFilters, LedgerSort } from "./filters";
import { LEDGER_FILTER_TODAY } from "./filters";

/** Task 13's "Produces" interface, verbatim. */
export interface LedgerView {
  viewId: string;
  name: string;
  filters: LedgerFilters;
  sort: LedgerSort;
}

/**
 * The default sort for the built-in views the brief does not name a sort for
 * ("Awaiting payment", "Unbilled", "Everything"). "Live work" has an explicit
 * one (`receivedDate` desc); these get the same ordering rather than an
 * arbitrary different one, so a desk agent moving between built-in views
 * does not also have to re-learn a new sort each time.
 */
const DEFAULT_BUILT_IN_SORT: LedgerSort = { column: "receivedDate", direction: "desc" };

const LIVE_WORK_VIEW_ID = "built-in-live-work";
const COLLECT_TODAY_VIEW_ID = "built-in-collect-today";
const APPOINTMENTS_TODAY_VIEW_ID = "built-in-appointments-today";
const AWAITING_PAYMENT_VIEW_ID = "built-in-awaiting-payment";
const UNBILLED_VIEW_ID = "built-in-unbilled";
const EVERYTHING_VIEW_ID = "built-in-everything";

const BUILT_IN_VIEW_IDS: readonly string[] = [
  LIVE_WORK_VIEW_ID,
  COLLECT_TODAY_VIEW_ID,
  APPOINTMENTS_TODAY_VIEW_ID,
  AWAITING_PAYMENT_VIEW_ID,
  UNBILLED_VIEW_ID,
  EVERYTHING_VIEW_ID,
];

/** Exported so `ViewChips` can decide whether to offer a delete affordance at all. */
export function isBuiltInLedgerViewId(viewId: string): boolean {
  return BUILT_IN_VIEW_IDS.includes(viewId);
}

export function collectTodayViewId(): string {
  return COLLECT_TODAY_VIEW_ID;
}

export function appointmentsTodayViewId(): string {
  return APPOINTMENTS_TODAY_VIEW_ID;
}

export function liveWorkViewId(): string {
  return LIVE_WORK_VIEW_ID;
}

export function awaitingPaymentViewId(): string {
  return AWAITING_PAYMENT_VIEW_ID;
}

export function unbilledViewId(): string {
  return UNBILLED_VIEW_ID;
}

export function everythingViewId(): string {
  return EVERYTHING_VIEW_ID;
}

/** Built-ins that belong in the Today chip group on the Ledger. */
export function isTodayLedgerViewId(viewId: string): boolean {
  return (
    viewId === LIVE_WORK_VIEW_ID ||
    viewId === COLLECT_TODAY_VIEW_ID ||
    viewId === APPOINTMENTS_TODAY_VIEW_ID
  );
}

/** Built-ins that belong in the Billing chip group on the Ledger. */
export function isBillingLedgerViewId(viewId: string): boolean {
  return viewId === AWAITING_PAYMENT_VIEW_ID || viewId === UNBILLED_VIEW_ID;
}

/**
 * The views a desk agent lands on before anyone has saved anything
 * (brief, "Three built-in views ship, and cannot be deleted" -- Unbilled and
 * the two today-ops views were added later). Built fresh on every call rather
 * than read from storage -- they are not data, they are the product's own
 * fixed defaults, so there is nothing to round-trip through `localStorage`
 * and nothing there can ever go stale or get lost.
 *
 * Today filters use `LEDGER_FILTER_TODAY` so apply-time resolves the desk
 * agent's local calendar, not a date frozen when the chip list mounted.
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
      viewId: COLLECT_TODAY_VIEW_ID,
      name: "Collect today",
      filters: {
        statuses: [...crm.LIVE_CASE_STATUSES],
        expectedCollectionDateOn: LEDGER_FILTER_TODAY,
      },
      sort: DEFAULT_BUILT_IN_SORT,
    },
    {
      viewId: APPOINTMENTS_TODAY_VIEW_ID,
      name: "Appointments today",
      filters: {
        statuses: [...crm.LIVE_CASE_STATUSES],
        appointmentDateOn: LEDGER_FILTER_TODAY,
      },
      sort: { column: "appointmentDate", direction: "asc" },
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
      viewId: UNBILLED_VIEW_ID,
      name: "Unbilled",
      filters: { statuses: [...crm.CASE_STATUSES], billingStatuses: ["UNBILLED"] },
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
 * `true` only when the view really is in storage; `false` when it is not, for
 * either of the two reasons below. A `localStorage` write that throws (quota
 * exceeded, a private window, cleared site data) still must not take the
 * Ledger down -- but it must not pass for a save either (fix round 1, F4).
 * The earlier version swallowed the failure on the grounds that "the
 * in-memory list is still correct", which its only caller falsifies:
 * `ViewChips` re-reads the whole list straight back out of storage after
 * every save, so a swallowed failure leaves the desk agent looking at a chip
 * row with no new view on it and no word about why. Whether to say so, and
 * how, is the caller's decision to make -- but it can only make it if this
 * function reports what happened.
 *
 * Saving over a built-in view's id is refused for the same reason deleting
 * one is (below): built-in ids are reserved, not just protected from
 * deletion, and a custom view silently squatting on `built-in-live-work`
 * would otherwise appear as a second, differently-configured "Live work" the
 * moment `loadViews` concatenates the two lists. That refusal is a `false`
 * too: nothing was stored.
 */
export function saveView(userEmail: string, view: LedgerView): boolean {
  if (isBuiltInLedgerViewId(view.viewId)) return false;
  try {
    const existingSavedViews = readSavedViewsOnly(userEmail);
    const nextSavedViews = [
      ...existingSavedViews.filter((existingView) => existingView.viewId !== view.viewId),
      view,
    ];
    localStorage.setItem(storageKeyFor(userEmail), JSON.stringify(nextSavedViews));
    return true;
  } catch {
    return false;
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

/** Look up a built-in by id for the ops strip one-click apply. */
export function findBuiltInLedgerView(viewId: string): LedgerView | undefined {
  return builtInLedgerViews().find((view) => view.viewId === viewId);
}
