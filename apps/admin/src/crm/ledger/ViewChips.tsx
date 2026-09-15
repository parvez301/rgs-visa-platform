import { useState } from "react";
import type { LedgerFilters, LedgerSort } from "./filters";
import { deleteView, isBuiltInLedgerViewId, loadViews, saveView, type LedgerView } from "./views";

interface ViewChipsProps {
  userEmail: string;
  /** The filter/sort state a new saved view would capture if saved right now. */
  activeFilters: LedgerFilters;
  activeSort: LedgerSort;
  /** Fired when a desk agent clicks a chip -- `LedgerPage` owns applying it. */
  onApplyView: (filters: LedgerFilters, sort: LedgerSort) => void;
}

/**
 * Unique within one user's own saved-views list, which is all it ever needs
 * to be -- nothing parses or guesses this id, so `Date.now()` plus a short
 * random suffix is enough, with no dependency on `crypto.randomUUID` being
 * present in every runtime this component might render in.
 */
function generateNewViewId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The saved-views chip row (Task 13). Deliberately owns its OWN copy of the
 * views list (loaded once via `loadViews`, refreshed after every save/
 * delete) rather than lifting that state into `LedgerPage` -- `LedgerPage`
 * only needs to know WHICH filters/sort are active right now, which it
 * already tracks for its own status/partner controls; it has no other
 * reason to know the full views list exists.
 *
 * No chip starts pressed: `LedgerPage`'s own initial filter state (no
 * statuses selected) does not correspond to any one of these views, and
 * auto-applying "Live work" on mount would silently change what a desk
 * agent's first paint of the Ledger shows -- a bigger behavior change than
 * this task's brief asks for.
 */
export function ViewChips({ userEmail, activeFilters, activeSort, onApplyView }: ViewChipsProps) {
  const [views, setViews] = useState<LedgerView[]>(() => loadViews(userEmail));
  const [activeViewId, setActiveViewId] = useState<string | undefined>(undefined);
  const [isNamingNewView, setIsNamingNewView] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  /**
   * Set only when a save did not reach storage (fix round 1, F4). The list
   * below is re-read from `localStorage` after every save, so a failed write
   * is otherwise indistinguishable from never having pressed Save: the chip
   * is simply not there.
   */
  const [saveFailureMessage, setSaveFailureMessage] = useState<string | undefined>(undefined);

  function selectView(view: LedgerView) {
    setActiveViewId(view.viewId);
    onApplyView(view.filters, view.sort);
  }

  function confirmSaveCurrentView() {
    const trimmedViewName = newViewName.trim();
    if (trimmedViewName.length === 0) return;
    const newView: LedgerView = {
      viewId: generateNewViewId(),
      name: trimmedViewName,
      filters: activeFilters,
      sort: activeSort,
    };
    const wasPersisted = saveView(userEmail, newView);
    setViews(loadViews(userEmail));
    if (!wasPersisted) {
      // The naming box stays open with the typed name still in it: the desk
      // agent's next move is to try again (another window, site data
      // re-enabled), and retyping the name is a second small punishment for
      // a failure that was not theirs. `activeViewId` is deliberately NOT
      // set -- marking a view active that no chip can render leaves the
      // whole row unpressed, which says nothing at all.
      setSaveFailureMessage("Could not save this view — storage is unavailable");
      return;
    }
    setSaveFailureMessage(undefined);
    setActiveViewId(newView.viewId);
    setNewViewName("");
    setIsNamingNewView(false);
  }

  function removeView(viewId: string) {
    deleteView(userEmail, viewId);
    setViews(loadViews(userEmail));
    setActiveViewId((currentActiveViewId) => (currentActiveViewId === viewId ? undefined : currentActiveViewId));
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="view-chips">
      {views.map((view) => {
        const isActiveView = activeViewId === view.viewId;
        const isBuiltIn = isBuiltInLedgerViewId(view.viewId);
        return (
          <span key={view.viewId} className="inline-flex items-center">
            <button
              type="button"
              data-testid="view-chip"
              aria-pressed={isActiveView}
              onClick={() => selectView(view)}
              className={`${isBuiltIn ? "rounded-crm-control" : "rounded-l-crm-control"} border px-2 py-1 text-[12px] ${
                isActiveView
                  ? "border-crm-primary bg-crm-lavender text-crm-charcoal"
                  : "border-crm-rule-box text-crm-steel"
              }`}
            >
              {view.name}
            </button>
            {!isBuiltIn && (
              <button
                type="button"
                aria-label={`Delete the "${view.name}" view`}
                onClick={() => removeView(view.viewId)}
                className="rounded-r-crm-control border border-l-0 border-crm-rule-box px-1.5 py-1 text-[12px] text-crm-steel"
              >
                ×
              </button>
            )}
          </span>
        );
      })}

      {isNamingNewView ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={newViewName}
            onChange={(event) => setNewViewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirmSaveCurrentView();
              if (event.key === "Escape") {
                setIsNamingNewView(false);
                setNewViewName("");
              }
            }}
            placeholder="Name this view"
            aria-label="Name this view"
            className="rounded-crm-control border border-crm-rule-box px-2 py-1 text-[12px]"
          />
          <button
            type="button"
            onClick={confirmSaveCurrentView}
            // Neutral, not `--crm-primary`: that colour marks exactly one
            // control in the whole product (Approve on an agent proposal
            // card), and Save is named in the constraint as one it must not
            // mark. Same treatment as "Keep theirs" in `LedgerTable`'s
            // conflict prompt (fix round 1, F3).
            className="rounded-crm-control border border-crm-rule-box px-2 py-1 text-[12px]"
          >
            Save
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setIsNamingNewView(true)}
          className="rounded-crm-control border border-dashed border-crm-steel px-2 py-1 text-[12px] text-crm-steel"
        >
          + Save current view
        </button>
      )}

      {saveFailureMessage !== undefined && (
        <span role="status" className="text-[12px] text-crm-rose">
          {saveFailureMessage}
        </span>
      )}
    </div>
  );
}
