import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiRequestError } from "../lib/adminApi";

/**
 * One toast on screen. `undo` is optional on purpose: rule 3 (spec §8) asks
 * for an undo on every committed edit, but the state-machine guard on the
 * undo button (spec §9 -- `crm.canTransitionCaseStatus`/`canTransitionBilling`)
 * means some edits cannot be undone from here at all. Rather than invent a
 * second "plain notice" method on the context, an absent `undo` is what
 * renders the toast without a button -- one call path, two shapes of result.
 */
interface UndoToastEntry {
  toastId: string;
  message: string;
  undo: (() => Promise<void>) | undefined;
  status: "idle" | "undoing" | "failed";
  failureMessage: string | undefined;
}

export interface UndoToastContextValue {
  /**
   * Shows a toast. Pass `undo` when the edit can be reversed from here;
   * leave it out to show an informational toast with no button (the
   * "cannot be undone from here" case).
   */
  showUndo(message: string, undo?: () => Promise<void>): void;
}

const UndoToastContext = createContext<UndoToastContextValue | null>(null);

/** Enough to notice a mistake, few enough that toasts never pile up. */
const MAXIMUM_VISIBLE_TOASTS = 3;
const AUTO_DISMISS_AFTER_MILLISECONDS = 10_000;

let nextToastSequenceNumber = 0;

function describeUndoFailure(undoError: unknown): string {
  if (undoError instanceof Error && undoError.message.length > 0) {
    return undoError.message;
  }
  return "The undo could not be completed.";
}

/**
 * Mounted once, in `AppProviders` above the routes, so every screen shares one
 * toast stack. NOT in `CrmLayout`: `CaseScreen` calls `useLedgerEdit()` above
 * its own layout, and this provider was once documented as living there while
 * nothing mounted it at all -- staging `/crm` rendered blank (2026-09-16).
 * `useLedgerEdit` and `useApplicantEdit` are the callers today, but the
 * context is not ledger-specific -- anything wanting an undo affordance can
 * reach it.
 */
export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<UndoToastEntry[]>([]);
  const dismissTimersByToastId = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearDismissTimer = useCallback((toastId: string) => {
    const existingTimer = dismissTimersByToastId.current.get(toastId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      dismissTimersByToastId.current.delete(toastId);
    }
  }, []);

  const dismissToast = useCallback(
    (toastId: string) => {
      clearDismissTimer(toastId);
      setToasts((currentToasts) => currentToasts.filter((toast) => toast.toastId !== toastId));
    },
    [clearDismissTimer],
  );

  const armAutoDismiss = useCallback(
    (toastId: string) => {
      const timer = setTimeout(() => dismissToast(toastId), AUTO_DISMISS_AFTER_MILLISECONDS);
      dismissTimersByToastId.current.set(toastId, timer);
    },
    [dismissToast],
  );

  // Every armed timer must die with the provider -- otherwise a test (or a
  // navigated-away screen) leaves a `setTimeout` pointed at a `setToasts`
  // whose component tree no longer exists.
  useEffect(() => {
    const timersByToastId = dismissTimersByToastId.current;
    return () => {
      for (const timer of timersByToastId.values()) clearTimeout(timer);
      timersByToastId.clear();
    };
  }, []);

  const showUndo = useCallback(
    (message: string, undo?: () => Promise<void>) => {
      const toastId = `undo-toast-${nextToastSequenceNumber++}`;
      const newToast: UndoToastEntry = {
        toastId,
        message,
        undo,
        status: "idle",
        failureMessage: undefined,
      };
      setToasts((currentToasts) => {
        const nextToasts = [...currentToasts, newToast];
        const overflowCount = nextToasts.length - MAXIMUM_VISIBLE_TOASTS;
        if (overflowCount <= 0) return nextToasts;
        // Oldest drops first -- a desk agent editing fast should still see
        // the toast for the edit they just made, not one from ten rows ago.
        for (const droppedToast of nextToasts.slice(0, overflowCount)) {
          clearDismissTimer(droppedToast.toastId);
        }
        return nextToasts.slice(overflowCount);
      });
      armAutoDismiss(toastId);
    },
    [armAutoDismiss, clearDismissTimer],
  );

  /**
   * The undo callback is itself a mutation (rule 3): optimistic, and
   * rollback-safe on its own. If it fails, the cache has already reverted to
   * the pre-undo value via that mutation's own `onError` -- this toast's job
   * is only to say so, and to offer another try rather than disappearing as
   * though the undo worked.
   */
  async function handleUndoClick(toast: UndoToastEntry) {
    if (toast.undo === undefined) return;
    clearDismissTimer(toast.toastId);
    setToasts((currentToasts) =>
      currentToasts.map((entry) =>
        entry.toastId === toast.toastId ? { ...entry, status: "undoing", failureMessage: undefined } : entry,
      ),
    );
    try {
      await toast.undo();
      dismissToast(toast.toastId);
    } catch (undoError) {
      // Fix round 1, F4: a 409 here means the case moved again underneath the
      // undo itself, and `useLedgerEdit`'s own `onErrorForEdit` (shared by
      // every mutation, undo included) has already opened the conflict
      // prompt for this exact failure. A live "Retry undo" beside that
      // prompt would offer a second, contradictory answer to one question --
      // and retrying is precisely what rule 4 forbids. Clearing `undo`
      // (rather than only hiding the button in the render below) means a
      // stray click can never re-invoke it either; every other failure keeps
      // its retry affordance unchanged.
      const isConflict = undoError instanceof ApiRequestError && undoError.statusCode === 409;
      setToasts((currentToasts) =>
        currentToasts.map((entry) =>
          entry.toastId === toast.toastId
            ? {
                ...entry,
                status: "failed",
                failureMessage: describeUndoFailure(undoError),
                undo: isConflict ? undefined : entry.undo,
              }
            : entry,
        ),
      );
    }
  }

  return (
    <UndoToastContext.Provider value={{ showUndo }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.toastId}
            role="status"
            className="pointer-events-auto flex max-w-sm items-start gap-3 rounded-crm-card border border-crm-rule-box bg-crm-canvas px-3 py-2 text-[13px] text-crm-charcoal shadow"
          >
            <span className="flex-1">
              {toast.message}
              {toast.status === "failed" && (
                <span className="block text-crm-steel">Undo failed: {toast.failureMessage}</span>
              )}
            </span>
            {toast.undo !== undefined && (
              <button
                type="button"
                onClick={() => void handleUndoClick(toast)}
                disabled={toast.status === "undoing"}
                // R71: neutral text with the underline doing the work. Undo is
                // a real action and must read as one, but `--crm-primary` is
                // reserved for the single Approve button in the product, and a
                // toast that appears after every committed edit is the last
                // place that reservation should leak.
                className="shrink-0 font-medium text-crm-charcoal underline disabled:opacity-60"
              >
                {toast.status === "undoing" ? "Undoing…" : toast.status === "failed" ? "Retry undo" : "Undo"}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismissToast(toast.toastId)}
              aria-label="Dismiss"
              className="shrink-0 text-crm-steel"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </UndoToastContext.Provider>
  );
}

export function useUndoToast(): UndoToastContextValue {
  const context = useContext(UndoToastContext);
  if (context === null) {
    throw new Error("useUndoToast must be called beneath an UndoToastProvider");
  }
  return context;
}
