import { useCallback, useReducer, useRef } from "react";

/**
 * A cell address in the grid, as a (row, column) pair of zero-based indexes.
 * Never a case id or a column key -- those are display-layer concerns the
 * component resolves separately, so this reducer stays testable with plain
 * numbers and a synthetic `bounds` shape (see `gridReducer`'s tests).
 */
export interface GridPosition {
  rowIndex: number;
  columnIndex: number;
}

export interface GridState {
  focus: GridPosition;
  /** Row indexes, in selection order. Space toggles; Shift extends. */
  selectedRowIndexes: number[];
  /** The row whose applicants are disclosed, if any. */
  expandedRowIndexes: number[];
  editing: GridPosition | undefined;
}

export type GridAction =
  | { kind: "move"; direction: "up" | "down" | "left" | "right" }
  | { kind: "beginEdit" }
  | { kind: "cancelEdit" }
  | { kind: "commitAndStay" }
  | { kind: "toggleSelection" }
  | { kind: "extendSelection"; direction: "up" | "down" }
  | { kind: "clickSelect"; rowIndex: number; columnIndex: number; withShift: boolean };

export interface GridBounds {
  rowCount: number;
  columnCount: number;
}

/**
 * REF is always `LEDGER_COLUMNS[0]` -- sticky-left, per spec §3 -- and the
 * reducer is deliberately given only `{ rowCount, columnCount }` as bounds
 * (no column metadata), so it cannot look this up. It hardcodes the
 * convention instead of importing `LEDGER_COLUMNS`, which is what keeps this
 * file a pure reducer testable with a synthetic 10x10 grid that has no REF
 * column of its own.
 */
const REF_COLUMN_INDEX = 0;

const INITIAL_GRID_STATE: GridState = {
  focus: { rowIndex: 0, columnIndex: 0 },
  selectedRowIndexes: [],
  expandedRowIndexes: [],
  editing: undefined,
};

function clampIndex(candidateIndex: number, lowerBound: number, upperBound: number): number {
  return Math.min(Math.max(candidateIndex, lowerBound), upperBound);
}

/**
 * Pure reducer for the grid's focus, selection, expansion and editing state.
 * No DOM, no virtualizer, no column metadata -- see the module comment on
 * `REF_COLUMN_INDEX` for why. `LedgerTable` wires this to real keys and real
 * mounted cells; this function is what makes every branch of the fixed
 * keymap testable without rendering anything.
 */
export function gridReducer(previousState: GridState, action: GridAction, bounds: GridBounds): GridState {
  switch (action.kind) {
    case "move": {
      // Arrow keys reach the edit input while a cell is being edited, not
      // the grid -- the reducer must not move focus out from under it.
      if (previousState.editing !== undefined) return previousState;

      const isOnRefColumn = previousState.focus.columnIndex === REF_COLUMN_INDEX;
      const isFocusedRowExpanded = previousState.expandedRowIndexes.includes(previousState.focus.rowIndex);

      // → is overloaded: on a collapsed parent's REF cell it expands instead
      // of moving. Resolved here, not in the component, so both branches are
      // reducer-level tests rather than rendered-DOM ones.
      //
      // Minor, fix round 1 (F6): this costs any caller counting keypresses
      // from the REF column one extra →. Reaching column index N from a
      // collapsed row's REF cell (index 0) takes N+1 right-arrows, not N --
      // the first one only expands the row. `LedgerKeyboard.test.tsx`'s own
      // "resolves the overloaded →" test demonstrates the mechanism; nothing
      // previously said so in words for a reader who is not stepping through
      // this switch.
      if (action.direction === "right" && isOnRefColumn && !isFocusedRowExpanded) {
        return {
          ...previousState,
          expandedRowIndexes: [...previousState.expandedRowIndexes, previousState.focus.rowIndex],
        };
      }

      // ← on an expanded parent's REF cell collapses instead of moving.
      if (action.direction === "left" && isOnRefColumn && isFocusedRowExpanded) {
        return {
          ...previousState,
          expandedRowIndexes: previousState.expandedRowIndexes.filter(
            (expandedRowIndex) => expandedRowIndex !== previousState.focus.rowIndex,
          ),
        };
      }

      const lastRowIndex = bounds.rowCount - 1;
      const lastColumnIndex = bounds.columnCount - 1;
      const nextFocus: GridPosition = { ...previousState.focus };
      // Focus never wraps: each direction clamps against its own edge rather
      // than modulo-ing back around to the opposite one.
      switch (action.direction) {
        case "up":
          nextFocus.rowIndex = clampIndex(previousState.focus.rowIndex - 1, 0, lastRowIndex);
          break;
        case "down":
          nextFocus.rowIndex = clampIndex(previousState.focus.rowIndex + 1, 0, lastRowIndex);
          break;
        case "left":
          nextFocus.columnIndex = clampIndex(previousState.focus.columnIndex - 1, 0, lastColumnIndex);
          break;
        case "right":
          nextFocus.columnIndex = clampIndex(previousState.focus.columnIndex + 1, 0, lastColumnIndex);
          break;
      }
      return { ...previousState, focus: nextFocus };
    }

    case "beginEdit":
      return { ...previousState, editing: { ...previousState.focus } };

    case "cancelEdit":
      return { ...previousState, editing: undefined };

    case "commitAndStay":
      // Task 12 owns the actual optimistic write; this reducer only models
      // that editing ends and focus does not move.
      return { ...previousState, editing: undefined };

    case "toggleSelection": {
      const focusedRowIndex = previousState.focus.rowIndex;
      const isAlreadySelected = previousState.selectedRowIndexes.includes(focusedRowIndex);
      return {
        ...previousState,
        selectedRowIndexes: isAlreadySelected
          ? previousState.selectedRowIndexes.filter((selectedRowIndex) => selectedRowIndex !== focusedRowIndex)
          : [...previousState.selectedRowIndexes, focusedRowIndex],
      };
    }

    case "extendSelection": {
      const lastRowIndex = bounds.rowCount - 1;
      const rowIndexDelta = action.direction === "down" ? 1 : -1;
      const nextFocusedRowIndex = clampIndex(previousState.focus.rowIndex + rowIndexDelta, 0, lastRowIndex);
      const nextSelectedRowIndexes = previousState.selectedRowIndexes.includes(nextFocusedRowIndex)
        ? previousState.selectedRowIndexes
        : [...previousState.selectedRowIndexes, nextFocusedRowIndex];
      return {
        ...previousState,
        focus: { ...previousState.focus, rowIndex: nextFocusedRowIndex },
        selectedRowIndexes: nextSelectedRowIndexes,
      };
    }

    case "clickSelect": {
      // The keymap (spec §4) gives selection exactly two triggers -- Space
      // toggles, Shift extends -- and click is not one of them. A plain
      // click here only moves focus, the same as any other navigation; only
      // `withShift` touches `selectedRowIndexes`. The anchor for that range
      // is the row focus was on before this click (not a separately stored
      // field), so it agrees with Shift+↑↓'s own anchor -- wherever focus
      // already was.
      //
      // Fix round 1, F3: a click also carries the column the human actually
      // clicked, not just the row -- otherwise clicking a non-REF cell moved
      // row focus but left column focus wherever it was (often column 0),
      // so the clicked cell never became focused and Enter opened the wrong
      // cell's editor. Resolved here, in the reducer, rather than in
      // `LedgerTable`'s click handler, per the same "overloaded-→" precedent
      // above: a click's exact effect on focus is grid semantics.
      if (!action.withShift) {
        return { ...previousState, focus: { rowIndex: action.rowIndex, columnIndex: action.columnIndex } };
      }
      const anchorRowIndex = previousState.focus.rowIndex;
      const rangeStartRowIndex = Math.min(anchorRowIndex, action.rowIndex);
      const rangeEndRowIndex = Math.max(anchorRowIndex, action.rowIndex);
      const selectedRowIndexes = Array.from(
        { length: rangeEndRowIndex - rangeStartRowIndex + 1 },
        (_unused, offsetFromRangeStart) => rangeStartRowIndex + offsetFromRangeStart,
      );
      return {
        ...previousState,
        focus: { rowIndex: action.rowIndex, columnIndex: action.columnIndex },
        selectedRowIndexes,
      };
    }

    default:
      return previousState;
  }
}

/**
 * Maps the fixed keymap (spec §4) to `GridAction`s and owns the reducer.
 * `LedgerTable` supplies real `bounds` and wires `onKeyDown` to the grid's
 * scroll container; `dispatch` is exposed separately for interactions the
 * keymap does not cover, such as a mouse click on a row.
 */
export function useGridKeyboard(bounds: GridBounds): {
  state: GridState;
  onKeyDown: (event: KeyboardEvent) => void;
  dispatch: (action: GridAction) => void;
} {
  // `bounds` is a fresh object every render (LedgerTable computes it inline
  // from `rows.length`); a ref lets the reducer always see the latest values
  // without forcing `useReducer` to be handed a new reducer function -- and
  // therefore a new `dispatch` identity is never at risk -- on every render.
  const latestBoundsRef = useRef(bounds);
  latestBoundsRef.current = bounds;

  const reducerWithLatestBounds = useCallback(
    (currentState: GridState, action: GridAction) => gridReducer(currentState, action, latestBoundsRef.current),
    [],
  );

  const [state, dispatch] = useReducer(reducerWithLatestBounds, INITIAL_GRID_STATE);

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const isCommitAndStay = event.key === "Enter" && (event.metaKey || event.ctrlKey);

    // Every branch below both consumes the key (preventDefault) and
    // dispatches -- Space scrolling the page out from under a desk agent
    // mid-selection is exactly the bug that preventDefault exists to stop.
    if (event.shiftKey && event.key === "ArrowUp") {
      event.preventDefault();
      dispatch({ kind: "extendSelection", direction: "up" });
      return;
    }
    if (event.shiftKey && event.key === "ArrowDown") {
      event.preventDefault();
      dispatch({ kind: "extendSelection", direction: "down" });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      dispatch({ kind: "move", direction: "up" });
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      dispatch({ kind: "move", direction: "down" });
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      dispatch({ kind: "move", direction: "left" });
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      dispatch({ kind: "move", direction: "right" });
      return;
    }
    if (isCommitAndStay) {
      event.preventDefault();
      dispatch({ kind: "commitAndStay" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      dispatch({ kind: "beginEdit" });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ kind: "cancelEdit" });
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      dispatch({ kind: "toggleSelection" });
      return;
    }
    // Every other key (Tab, Cmd+F, plain letters, ...) is left alone: the
    // grid must never block browser-native behaviour it does not own.
  }, []);

  return { state, onKeyDown, dispatch };
}
