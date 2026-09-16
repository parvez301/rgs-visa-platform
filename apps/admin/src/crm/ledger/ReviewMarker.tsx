import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { COMPACT_BUTTON_CLASS, COMPACT_PRIMARY_BUTTON_CLASS, INPUT_CLASS } from "../components/controls";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { crmClient, type OpenReviewSummaryEntry } from "../api/crmClient";
import { crmQueryKeys, useReviewItem } from "../api/hooks";
import { REVIEW_REASON_LABELS } from "../labels";

/**
 * Spec §7's review markers, on the Ledger row rather than on a screen of their
 * own.
 *
 * The workbook import left 3,958 review items and 1,480 merge proposals behind
 * and gave RGS no interface at all for them, so cleaning their own data is
 * work the product cannot currently do. Putting the work IN the Ledger is what
 * makes it ordinary daily work instead of a separate chore nobody schedules.
 *
 * What resolving does and does not do is the load-bearing part of this file.
 * `resolveReviewItem` (services/api/src/domain/crm/reviewQueue.ts) closes the
 * review item and writes nothing to the case -- there is no case write in that
 * module, by design. A marker offering "apply this value" would therefore be
 * lying about what the button does, so the two actions here are named for what
 * they really are (Dismiss, and Record the ... value) and the panel says in so
 * many words that the case itself is unchanged.
 */

/** px between the marker chip and the popover it opens. */
const POPOVER_GAP_PX = 4;
const POPOVER_WIDTH_PX = 360;
/**
 * The panel's own scroll box. It is BOTH the CSS max-height and the height the
 * flip below reserves (fix round 1, F2): while the max-height lived only in a
 * `max-h-80` class, the number that decided WHERE the panel goes and the number
 * that decided how tall it gets were two values free to drift apart.
 */
const POPOVER_MAX_HEIGHT_PX = 320;

/** What the anchor maths needs from the chip's rect, and nothing else. */
interface MarkerChipRect {
  top: number;
  bottom: number;
  left: number;
}

/**
 * Where the panel can actually be READ, given where the chip is
 * (fix round 1, F2).
 *
 * The Ledger is a full-height grid of 32px rows, so a large share of the chips
 * a desk agent can see sit in the bottom 320px of the viewport. Anchored below
 * with no flip, those panels open past the fold -- and because the panel is
 * `position: fixed`, scrolling the grid never brings one into view; it only
 * moves the row away from the parked panel. Flipping the panel above the chip
 * is what keeps it on screen at all.
 *
 * The horizontal clamp is the same argument sideways: the REF column is
 * sticky-left, so the chip is near the left edge on a wide screen, but on a
 * narrow one (or a browser window dragged small) a 360px panel anchored at the
 * chip runs off the right edge, where `position: fixed` again means no scroll
 * reaches it.
 */
function computePopoverAnchor(markerChipRect: MarkerChipRect): { top: number; left: number } {
  const fitsBelowTheChip =
    markerChipRect.bottom + POPOVER_GAP_PX + POPOVER_MAX_HEIGHT_PX <= window.innerHeight;
  return {
    top: fitsBelowTheChip
      ? markerChipRect.bottom + POPOVER_GAP_PX
      : markerChipRect.top - POPOVER_MAX_HEIGHT_PX - POPOVER_GAP_PX,
    // `Math.max(0, ...)` as well as the right-edge clamp: on a viewport
    // narrower than the panel itself the right-edge clamp alone computes a
    // NEGATIVE left, which hides the panel off the other side instead.
    left: Math.max(0, Math.min(markerChipRect.left, window.innerWidth - POPOVER_WIDTH_PX)),
  };
}

/**
 * The two kinds of review work, which spec §7 requires be marked differently:
 * a field-level problem is a correction to one cell, a merge candidate is a
 * judgement about two cases. Different mark, different words, because they are
 * different work.
 */
type ReviewMarkerKind = "field" | "merge";

interface ReviewMarkerCopy {
  /**
   * The chip's own classes. The two kinds differ in tint AND in radius (chip 4
   * vs badge 6) AND in border style, not in one of the three: a desk agent
   * scanning a column of markers has to be able to tell them apart without
   * reading anything, and colour alone is not a distinction every reader has.
   */
  chipClassName: string;
  /** The words, used as the chip's accessible name, its tooltip and the popover's headline. */
  describeMarker(openItemCount: number): string;
  /** R68: both kinds get the same two actions and different copy. */
  consequenceSentence: string;
  recordActionLabel: string;
  resolvedValueLabel: string;
  resolvedValuePlaceholder: string;
}

const MARKER_COPY: Record<ReviewMarkerKind, ReviewMarkerCopy> = {
  field: {
    // Dashed steel is the same border `AxisChip` gives an UNKNOWN billing
    // status (spec §3): both say "the import could not read this", and import
    // debt should look like import debt wherever it surfaces.
    chipClassName:
      "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-dashed border-amber-500 bg-amber-100 px-1.5 text-[11px] font-semibold leading-none text-amber-900",
    describeMarker: (openItemCount) =>
      openItemCount === 1 ? "1 import problem" : `${openItemCount} import problems`,
    consequenceSentence:
      "Resolving records the decision and does not change the case — changing the case itself is a separate edit in the row above.",
    recordActionLabel: "Record the correct value",
    resolvedValueLabel: "The correct value",
    resolvedValuePlaceholder: "What the cell should have said",
  },
  merge: {
    chipClassName:
      "inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-violet-400 bg-violet-100 px-1.5 text-[11px] font-semibold leading-none text-violet-900",
    describeMarker: (openItemCount) =>
      openItemCount === 1 ? "May be a duplicate" : `May be a duplicate · ${openItemCount} flags`,
    consequenceSentence:
      "Resolving records the decision and merges nothing — no case is joined, closed or changed here.",
    recordActionLabel: "Record the decision",
    resolvedValueLabel: "The decision",
    resolvedValuePlaceholder: "Which REF survives?",
  },
};

interface ReviewMarkerProps {
  caseRef: string;
  /**
   * This case's row of the open-review summary, or `undefined` for a case with
   * no open items. The summary is read ONCE for the whole Ledger
   * (`LedgerPage`) and handed down per row -- a marker that fetched its own
   * would be 7,156 requests to answer a question one projected read already
   * answers.
   */
  entry: OpenReviewSummaryEntry | undefined;
  /**
   * Whether this marker's row is the one the grid's focus sits on (R74).
   *
   * Passed down from `LedgerTable` through `LedgerCellContext` rather than read
   * from a context, and REQUIRED rather than defaulted: a default would let a
   * new call site silently pick either "every marker is a Tab stop" (the
   * regression R74 exists to prevent) or "no marker is reachable by keyboard
   * at all" (the reason a plain `tabIndex={-1}` is not the answer).
   */
  isFocusedRow: boolean;
}

/**
 * Renders one marker per KIND of open work on this case, so a case carrying
 * both a bad cell and a duplicate suspicion shows both -- they are resolved
 * separately and by different judgements, and one combined mark would have to
 * pick a single set of words for two different things.
 *
 * Deliberately holds no hooks of its own, and neither does the chip below
 * until it is opened: the marker is rendered inside every mounted Ledger row,
 * and a `useQuery`/`useAuth` at this level would make every row depend on
 * providers it does not otherwise need.
 */
export function ReviewMarker({ caseRef, entry, isFocusedRow }: ReviewMarkerProps) {
  if (entry === undefined) return null;
  return (
    <>
      {entry.fieldItemIds.length > 0 && (
        <OneKindOfMarker
          caseRef={caseRef}
          kind="field"
          reviewItemIds={entry.fieldItemIds}
          isFocusedRow={isFocusedRow}
        />
      )}
      {entry.mergeItemIds.length > 0 && (
        <OneKindOfMarker
          caseRef={caseRef}
          kind="merge"
          reviewItemIds={entry.mergeItemIds}
          isFocusedRow={isFocusedRow}
        />
      )}
    </>
  );
}

interface OneKindOfMarkerProps {
  caseRef: string;
  kind: ReviewMarkerKind;
  reviewItemIds: string[];
  isFocusedRow: boolean;
}

/**
 * R67: the open marker is a PORTAL POPOVER, not an in-row panel.
 *
 * A 32px virtualized row under `overflow-hidden` ancestors cannot host a list
 * of review items; growing the row to fit one would couple this task to the
 * expansion state `LedgerTable` already owns for applicant sub-rows. The panel
 * is therefore positioned `fixed` from the chip's own rect at open time and
 * rendered into `document.body`, which is also what keeps it out of the agent
 * panel's column.
 *
 * `role="dialog"` is NOT used: spec §6's "never a modal" is a rule about the
 * whole desk, and a dialog role announces exactly the thing that rule forbids.
 * `role="group"` with an `aria-label` naming the REF says what this is without
 * claiming the rest of the screen is inert.
 */
function OneKindOfMarker({ caseRef, kind, reviewItemIds, isFocusedRow }: OneKindOfMarkerProps) {
  const markerCopy = MARKER_COPY[kind];
  const markerButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // The anchor IS the open flag: a popover with no measured position has
  // nowhere to be, and two pieces of state that must agree are two pieces of
  // state that can disagree.
  const [popoverAnchor, setPopoverAnchor] = useState<{ top: number; left: number } | undefined>(
    undefined,
  );
  const isPopoverOpen = popoverAnchor !== undefined;
  const markerWords = markerCopy.describeMarker(reviewItemIds.length);

  // Closing WITHOUT taking focus back, for the close paths no human asked for:
  // the row scrolled away underneath the panel, or the row unmounted. Nobody
  // pressed anything, so there is no "back where the human left it" to go to.
  const dismissPopoverWithoutRestoringFocus = useCallback(() => {
    setPopoverAnchor(undefined);
  }, []);

  const closePopover = useCallback(() => {
    dismissPopoverWithoutRestoringFocus();
    // R67: focus goes back where the human left it. Nothing does this for us --
    // the popover lives in `document.body`, so closing it would otherwise drop
    // focus onto the body and leave a keyboard user at the top of the page.
    markerButtonRef.current?.focus();
  }, [dismissPopoverWithoutRestoringFocus]);

  // Escape and click-outside, while open only. Both listeners are registered
  // in the CAPTURE phase: the Ledger's own grid keymap (`useGridKeyboard`)
  // handles Escape too, and a bubbling listener here would run after it.
  useEffect(() => {
    if (!isPopoverOpen) return;
    function handleDocumentKeyDown(keyboardEvent: KeyboardEvent): void {
      if (keyboardEvent.key !== "Escape") return;
      keyboardEvent.stopPropagation();
      closePopover();
    }
    function handleDocumentMouseDown(mouseEvent: MouseEvent): void {
      const clickedNode = mouseEvent.target as Node | null;
      if (clickedNode === null) return;
      if (popoverRef.current?.contains(clickedNode) === true) return;
      // The chip itself is not "outside": its own click handler toggles the
      // popover, and closing here first would close and immediately reopen.
      if (markerButtonRef.current?.contains(clickedNode) === true) return;
      closePopover();
    }
    document.addEventListener("keydown", handleDocumentKeyDown, true);
    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, true);
      document.removeEventListener("mousedown", handleDocumentMouseDown, true);
    };
  }, [isPopoverOpen, closePopover]);

  /**
   * Fix round 1, F2: a scroll anywhere outside the panel closes it.
   *
   * The panel is positioned `fixed` from the chip's rect at the moment it
   * opened, so it does not follow the row it belongs to -- and when the grid
   * scrolls, the row is exactly what moves. Closing is the honest answer:
   * re-measuring every frame would glue a 360px panel to a row travelling up
   * the screen and then leave it hanging in space when the virtualizer
   * unmounts that row anyway.
   *
   * `capture: true` because `scroll` events do not bubble: the Ledger's own
   * scroll container is a descendant of `document`, and only a capture-phase
   * listener here sees its scroll at all.
   *
   * Focus is deliberately NOT restored on this path, for the same reason the
   * unmount path does not restore it: nobody closed this panel, and pulling
   * focus back onto a chip that may itself be scrolling out of the mounted
   * window is worse than leaving focus where the human put it.
   */
  useEffect(() => {
    if (!isPopoverOpen) return;
    function handleScrollAnywhere(scrollEvent: Event): void {
      const scrolledNode = scrollEvent.target as Node | null;
      // The panel has a scroll box of its own (max-height 320): a scroll
      // INSIDE it is a human reading this list, not the row moving under it.
      if (scrolledNode !== null && popoverRef.current?.contains(scrolledNode) === true) return;
      dismissPopoverWithoutRestoringFocus();
    }
    document.addEventListener("scroll", handleScrollAnywhere, true);
    return () => {
      document.removeEventListener("scroll", handleScrollAnywhere, true);
    };
  }, [isPopoverOpen, dismissPopoverWithoutRestoringFocus]);

  /**
   * Focus moves INTO the popover on open, which is both the ordinary
   * expectation for a disclosure and the thing that stops `LedgerTable`'s
   * focus-sync effect (R57) from pulling focus back onto the focused gridcell
   * on the next unrelated re-render: that effect only reclaims focus sitting
   * on `body` or inside the grid's own scroll container, and the popover is
   * neither.
   */
  useEffect(() => {
    if (!isPopoverOpen) return;
    popoverRef.current?.focus();
  }, [isPopoverOpen]);

  /** Open if closed, close if open -- what both the mouse and the keyboard do. */
  function togglePopover(): void {
    if (isPopoverOpen) {
      closePopover();
      return;
    }
    const markerRect = markerButtonRef.current?.getBoundingClientRect();
    // The ref is this very button, so it is set by the time its own handler
    // runs; the zero rect keeps the maths total rather than guarding a state
    // that cannot happen.
    setPopoverAnchor(computePopoverAnchor(markerRect ?? { top: 0, bottom: 0, left: 0 }));
  }

  function togglePopoverOnClick(clickEvent: ReactMouseEvent<HTMLButtonElement>): void {
    // The Ledger's gridcell carries its own click handler, which selects the
    // row -- and a selection change is reported to the agent panel (R62).
    // Opening a review popover is not a statement about which cases the agent
    // should be looking at.
    clickEvent.stopPropagation();
    togglePopover();
  }

  /**
   * R75(a): the chip handles its OWN activation keys, and stops them before the
   * grid sees them.
   *
   * R74 made this chip a roving Tab stop, which made it reachable and left it
   * inoperable. A keydown here bubbles into `LedgerTable`'s scroll container,
   * whose `onKeyDown` is the grid's fixed keymap (spec §5) -- and that keymap
   * `preventDefault()`s both of a button's activation keys: plain Enter on the
   * REF column navigates away to the case screen (R65), and Space toggles the
   * row's selection. A `preventDefault()` on `keydown` also suppresses the
   * browser's synthesized `click`, so neither key ever reached `onClick`
   * either: the tab stop promised something it could not deliver.
   *
   * `stopPropagation()` before the grid's handler runs is the same technique
   * `EditableCell` uses for an open editor, and the same one `togglePopoverOnClick`
   * above already uses for the mouse. EVERY other key is left alone on purpose:
   * the arrows must still reach the grid so a desk agent can navigate straight
   * off a marked row, and Escape belongs to the capture-phase listener that
   * closes the panel (R67).
   */
  function togglePopoverOnActivationKey(keyboardEvent: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    togglePopover();
  }

  return (
    <>
      <button
        ref={markerButtonRef}
        type="button"
        onClick={togglePopoverOnClick}
        onKeyDown={togglePopoverOnActivationKey}
        // R74: a ROVING tab stop, exactly like the gridcell wrapper's own
        // (`LedgerTable.tsx`). The REF `<Link>` beside this chip carries
        // `tabIndex={-1}` because an anchor at the browser default would put a
        // Tab stop in every mounted row; a plain `<button>` here was quietly
        // doing that same thing. But `tabIndex={-1}` alone would make the
        // marker unreachable without a mouse, and spec §5's keymap is fixed --
        // there is no ninth key to add. Tabbable on the focused row ONLY, so
        // the grid still has at most one marker in its tab order: Tab from the
        // focused REF cell reaches this chip and the next Tab leaves the grid;
        // from a cell further right in the same row the chip is one Shift+Tab
        // away instead, because the REF cell comes first in document order.
        // Every other mounted marker stays out of the tab order entirely.
        tabIndex={isFocusedRow ? 0 : -1}
        aria-expanded={isPopoverOpen}
        title={markerWords}
        className={markerCopy.chipClassName}
      >
        {/*
          The count is the chip's whole visual: the REF column is 120px and
          sticky, and a chip carrying the full sentence would push the REF
          itself out of a column every other row depends on. The WORDS are
          still the chip's accessible name and its tooltip, and the popover
          states them again -- what is compressed here is the pixels, not the
          information.
        */}
        <span aria-hidden="true">{reviewItemIds.length}</span>
        <span className="sr-only">{markerWords}</span>
      </button>

      {popoverAnchor !== undefined &&
        createPortal(
          <div
            ref={popoverRef}
            role="group"
            aria-label={`Import review for ${caseRef}`}
            tabIndex={-1}
            style={{
              position: "fixed",
              top: popoverAnchor.top,
              left: popoverAnchor.left,
              width: POPOVER_WIDTH_PX,
              // The same number `computePopoverAnchor` reserves when it flips
              // the panel above the chip -- see POPOVER_MAX_HEIGHT_PX.
              maxHeight: POPOVER_MAX_HEIGHT_PX,
            }}
            // `crm-root` because this subtree hangs off `document.body`, outside
            // the Ledger's own root -- without it the panel would inherit the
            // browser's default type rather than the desk's 14px/1.45.
            className="crm-root z-50 overflow-auto rounded-2xl border border-line bg-paper p-4 text-sm shadow-xl"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-semibold text-ink">
                {markerWords} — {caseRef}
              </p>
              <button
                type="button"
                onClick={closePopover}
                className={COMPACT_BUTTON_CLASS}
              >
                Close
              </button>
            </div>

            {/*
              Said ONCE, above the items, rather than beside each of them: it is
              a statement about what this panel can do at all, and repeating it
              per row would read as though some rows were different.
            */}
            <p className="mt-1 text-xs text-ink-soft">{markerCopy.consequenceSentence}</p>

            <ul className="mt-2 flex flex-col gap-2">
              {reviewItemIds.map((reviewItemId) => (
                <ReviewItemRow key={reviewItemId} reviewItemId={reviewItemId} markerCopy={markerCopy} />
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReviewItemRowProps {
  reviewItemId: string;
  markerCopy: ReviewMarkerCopy;
}

type ReviewItemResolution = { reviewStatus: "APPLIED" | "DISMISSED"; resolvedValue?: string };

/**
 * One review item, fetched by this component and no earlier (R69).
 *
 * A component per item rather than a loop inside the popover, so each item's
 * query, its draft value and its own failure are ordinary per-item hook state
 * -- and so that nothing at all is fetched while the marker is closed. The
 * summary route exists precisely to avoid 3,958 `getReviewItem` calls on page
 * load, and a marker that pre-fetched its items would hand that cost straight
 * back.
 */
function ReviewItemRow({ reviewItemId, markerCopy }: ReviewItemRowProps) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const reviewItemQuery = useReviewItem(reviewItemId);
  /**
   * `undefined` means "the human has not typed anything", which is NOT the
   * same as an empty box: the value shown falls back to the importer's own
   * `proposedValue` until then. Holding the draft this way rather than seeding
   * state from an effect is what keeps the prefill correct when the item
   * arrives after the first render.
   */
  const [typedResolvedValue, setTypedResolvedValue] = useState<string | undefined>(undefined);

  const resolveMutation = useMutation<crm.ReviewItem, Error, ReviewItemResolution>({
    mutationFn: (resolution) => crmClient.resolveReviewItem(idToken!, reviewItemId, resolution),
    onSuccess: () => {
      // The marker's count is the SUMMARY's id count, so this refetch is what
      // makes the count fall and this row disappear. Nothing is removed from
      // the list locally: a local removal would show an item resolved that the
      // server may not have resolved at all.
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.reviewSummary() });
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.reviewItem(reviewItemId) });
    },
  });

  if (reviewItemQuery.isLoading) {
    return <li className="text-sm text-ink-soft">Loading this review item…</li>;
  }
  const reviewItem = reviewItemQuery.data;
  if (reviewItem === undefined) {
    return (
      <li className="text-[13px] text-ink-soft">
        This review item could not be read: {String(reviewItemQuery.error?.message ?? "unknown error")}
      </li>
    );
  }

  const resolvedValueDraft = typedResolvedValue ?? reviewItem.proposedValue ?? "";
  // The route's own body schema is `z.string().min(1).optional()`, so an
  // APPLIED resolution with a blank value is a 400 the human cannot act on.
  const canRecordValue = resolvedValueDraft.trim() !== "" && !resolveMutation.isPending;
  const resolvedValueInputId = `review-item-value-${reviewItemId}`;

  return (
    <li className="rounded-xl border border-line bg-mist/40 p-3 text-sm text-ink">
      {/* The reason is an enum and never reaches a screen raw. */}
      <p className="font-semibold">{REVIEW_REASON_LABELS[reviewItem.reason]}</p>
      <p className="mt-0.5 text-ink-soft">
        {reviewItem.sourceSheet} row {reviewItem.sourceRow} · {reviewItem.fieldName}:{" "}
        {reviewItem.rawValue.trim() === "" ? "(blank)" : `“${reviewItem.rawValue}”`}
      </p>
      {reviewItem.detail !== undefined && <p className="mt-0.5 text-ink-soft">{reviewItem.detail}</p>}

      <label className="mt-2 block" htmlFor={resolvedValueInputId}>
        {markerCopy.resolvedValueLabel}
      </label>
      <input
        id={resolvedValueInputId}
        type="text"
        value={resolvedValueDraft}
        placeholder={markerCopy.resolvedValuePlaceholder}
        onChange={(changeEvent) => setTypedResolvedValue(changeEvent.target.value)}
        className={`${INPUT_CLASS} mt-1 w-full`}
      />

      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          disabled={resolveMutation.isPending}
          onClick={() => resolveMutation.mutate({ reviewStatus: "DISMISSED" })}
          className={COMPACT_BUTTON_CLASS}
        >
          Dismiss
        </button>
        <button
          type="button"
          disabled={!canRecordValue}
          onClick={() =>
            resolveMutation.mutate({
              reviewStatus: "APPLIED",
              resolvedValue: resolvedValueDraft.trim(),
            })
          }
          className={COMPACT_PRIMARY_BUTTON_CLASS}
        >
          {markerCopy.recordActionLabel}
        </button>
      </div>

      {/*
        R69: a failed resolution leaves the item exactly where it was, with the
        server's own words beside it. The common failure here is a 409 -- two
        reviewers working the same queue, and the other one got there first
        (`reviewQueue.ts` refuses a second resolution rather than overwriting
        the first reviewer's decision) -- and a row that vanished on that
        failure would tell this reviewer their own decision had been recorded.
      */}
      {resolveMutation.isError && (
        <p role="alert" className="mt-2 text-rose-900">
          This item was not resolved: {resolveMutation.error.message}
        </p>
      )}
    </li>
  );
}
