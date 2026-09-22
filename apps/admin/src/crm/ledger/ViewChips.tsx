import { useState } from "react";
import { COMPACT_BUTTON_CLASS, FIELD_LABEL_CLASS, INPUT_CLASS } from "../components/controls";
import type { LedgerFilters, LedgerSort } from "./filters";
import {
  deleteView,
  isBillingLedgerViewId,
  isBuiltInLedgerViewId,
  isTodayLedgerViewId,
  loadViews,
  saveView,
  type LedgerView,
} from "./views";

interface ViewChipsProps {
  userEmail: string;
  /** The filter/sort state a new saved view would capture if saved right now. */
  activeFilters: LedgerFilters;
  activeSort: LedgerSort;
  /** Fired when a desk agent clicks a chip -- `LedgerPage` owns applying it. */
  onApplyView: (filters: LedgerFilters, sort: LedgerSort) => void;
  /** Which chip reads as pressed; owned by `LedgerPage` so ops-strip clicks stay in sync. */
  activeViewId: string | undefined;
  onActiveViewIdChange: (viewId: string | undefined) => void;
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

function chipClassName(isActiveView: boolean, isBuiltIn: boolean): string {
  return `${isBuiltIn ? "rounded-full" : "rounded-l-full"} border px-3 py-1.5 text-xs font-semibold transition-colors ${
    isActiveView
      ? "border-ink bg-ink text-paper"
      : "border-line bg-paper text-ink-soft hover:border-ink/30"
  }`;
}

function ViewChipButton({
  view,
  isActiveView,
  onSelect,
  onDelete,
}: {
  view: LedgerView;
  isActiveView: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const isBuiltIn = isBuiltInLedgerViewId(view.viewId);
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        data-testid="view-chip"
        aria-pressed={isActiveView}
        onClick={onSelect}
        className={chipClassName(isActiveView, isBuiltIn)}
      >
        {view.name}
      </button>
      {!isBuiltIn && onDelete !== undefined && (
        <button
          type="button"
          aria-label={`Delete the "${view.name}" view`}
          onClick={onDelete}
          className="rounded-r-full border border-l-0 border-line bg-paper px-2 py-1.5 text-xs text-ink-soft transition-colors hover:text-rgs-red-deep"
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * The saved-views chip row (Task 13), grouped into Today / Billing / More so
 * six built-ins do not read as one undifferentiated pill strip.
 */
export function ViewChips({
  userEmail,
  activeFilters,
  activeSort,
  onApplyView,
  activeViewId,
  onActiveViewIdChange,
}: ViewChipsProps) {
  const [views, setViews] = useState<LedgerView[]>(() => loadViews(userEmail));
  const [isNamingNewView, setIsNamingNewView] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [saveFailureMessage, setSaveFailureMessage] = useState<string | undefined>(undefined);

  const todayViews = views.filter((view) => isTodayLedgerViewId(view.viewId));
  const billingViews = views.filter((view) => isBillingLedgerViewId(view.viewId));
  const moreViews = views.filter(
    (view) => !isTodayLedgerViewId(view.viewId) && !isBillingLedgerViewId(view.viewId),
  );

  function selectView(view: LedgerView) {
    onActiveViewIdChange(view.viewId);
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
      setSaveFailureMessage("Could not save this view — storage is unavailable");
      return;
    }
    setSaveFailureMessage(undefined);
    onActiveViewIdChange(newView.viewId);
    setNewViewName("");
    setIsNamingNewView(false);
  }

  function removeView(viewId: string) {
    deleteView(userEmail, viewId);
    setViews(loadViews(userEmail));
    if (activeViewId === viewId) onActiveViewIdChange(undefined);
  }

  function renderGroup(label: string, groupViews: LedgerView[]) {
    if (groupViews.length === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        {groupViews.map((view) => (
          <ViewChipButton
            key={view.viewId}
            view={view}
            isActiveView={activeViewId === view.viewId}
            onSelect={() => selectView(view)}
            onDelete={
              isBuiltInLedgerViewId(view.viewId) ? undefined : () => removeView(view.viewId)
            }
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="view-chips">
      {renderGroup("Today", todayViews)}
      {renderGroup("Billing", billingViews)}
      {renderGroup("More", moreViews)}

      <div className="flex flex-wrap items-center gap-2">
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
            <button type="button" onClick={confirmSaveCurrentView} className={COMPACT_BUTTON_CLASS}>
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
    </div>
  );
}
