import { useState } from "react";
import { COMPACT_BUTTON_CLASS, INPUT_CLASS } from "../components/controls";
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
              // R71, and the same treatment the status chips beside this row
              // now carry: the pressed chip keeps its lavender fill and takes
              // `border-ink-soft`. `--crm-primary` marks exactly one control
              // in the product, and a filter chip is not it -- the Save button
              // below has said so since fix round 1's F3, while the chip
              // beside it quietly carried the colour anyway.
              // A pressed pill is ink-filled, the Queue page's own convention for
              // an active filter; the accent red is kept for actions.
              className={`${isBuiltIn ? "rounded-full" : "rounded-l-full"} border px-3 py-1.5 text-xs font-semibold transition-colors ${
                isActiveView
                  ? "border-ink bg-ink text-paper"
                  : "border-line bg-paper text-ink-soft hover:border-ink/30"
              }`}
            >
              {view.name}
            </button>
            {!isBuiltIn && (
              <button
                type="button"
                aria-label={`Delete the "${view.name}" view`}
                onClick={() => removeView(view.viewId)}
                className="rounded-r-full border border-l-0 border-line bg-paper px-2 py-1.5 text-xs text-ink-soft transition-colors hover:text-rgs-red-deep"
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
            className={`${INPUT_CLASS} py-1 text-xs`}
          />
          <button
            type="button"
            onClick={confirmSaveCurrentView}
            // Secondary: Save confirms a name, it is not the screen's action.
            className={COMPACT_BUTTON_CLASS}
          >
            Save
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setIsNamingNewView(true)}
          className="rounded-full border border-dashed border-ink-soft/60 bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-ink/40 hover:text-ink"
        >
          + Save current view
        </button>
      )}

      {saveFailureMessage !== undefined && (
        <span role="status" className="text-xs text-rgs-red-deep">
          {saveFailureMessage}
        </span>
      )}
    </div>
  );
}
