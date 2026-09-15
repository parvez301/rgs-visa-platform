import { describe, expect, it } from "vitest";
import { gridReducer, type GridState } from "../../src/crm/ledger/useGridKeyboard";

const bounds = { rowCount: 10, columnCount: 10 };
const initialState: GridState = {
  focus: { rowIndex: 0, columnIndex: 0 },
  selectedRowIndexes: [],
  expandedRowIndexes: [],
  editing: undefined,
};

describe("gridReducer", () => {
  it("moves the focus and stops at the edges rather than wrapping", () => {
    const movedDown = gridReducer(initialState, { kind: "move", direction: "down" }, bounds);
    expect(movedDown.focus).toEqual({ rowIndex: 1, columnIndex: 0 });
    // Wrapping would move a desk agent from the last row to the first without
    // them noticing which case they are now editing.
    expect(gridReducer(initialState, { kind: "move", direction: "up" }, bounds).focus).toEqual({
      rowIndex: 0,
      columnIndex: 0,
    });
    const atLastRow = { ...initialState, focus: { rowIndex: 9, columnIndex: 0 } };
    expect(gridReducer(atLastRow, { kind: "move", direction: "down" }, bounds).focus.rowIndex).toBe(9);
  });

  it("expands a collapsed parent on right-arrow from the REF column, instead of moving", () => {
    const expanded = gridReducer(initialState, { kind: "move", direction: "right" }, bounds);
    expect(expanded.expandedRowIndexes).toEqual([0]);
    expect(expanded.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
  });

  it("moves right on right-arrow once the row is already expanded", () => {
    const alreadyExpanded = { ...initialState, expandedRowIndexes: [0] };
    const moved = gridReducer(alreadyExpanded, { kind: "move", direction: "right" }, bounds);
    expect(moved.focus).toEqual({ rowIndex: 0, columnIndex: 1 });
  });

  it("collapses on left-arrow from the REF column of an expanded row", () => {
    const alreadyExpanded = { ...initialState, expandedRowIndexes: [0] };
    const collapsed = gridReducer(alreadyExpanded, { kind: "move", direction: "left" }, bounds);
    expect(collapsed.expandedRowIndexes).toEqual([]);
  });

  it("moves right from a non-REF column without touching expansion", () => {
    const inMiddle = { ...initialState, focus: { rowIndex: 0, columnIndex: 4 } };
    const moved = gridReducer(inMiddle, { kind: "move", direction: "right" }, bounds);
    expect(moved.focus.columnIndex).toBe(5);
    expect(moved.expandedRowIndexes).toEqual([]);
  });

  it("does not wrap focus from the last column back to the first", () => {
    // expandedRowIndexes: [0] takes the REF-column overload out of play, so
    // this is purely the ordinary right-edge clamp on the last column.
    const atLastColumn = { ...initialState, focus: { rowIndex: 0, columnIndex: 9 }, expandedRowIndexes: [0] };
    const moved = gridReducer(atLastColumn, { kind: "move", direction: "right" }, bounds);
    expect(moved.focus).toEqual({ rowIndex: 0, columnIndex: 9 });
  });

  it("clamps Shift+arrow selection extension at both row edges, rather than wrapping the selection", () => {
    // A wrapped extension is worse than a wrapped focus move: a desk agent
    // sees a wrapped cursor and corrects it, but a selection that silently
    // wraps to the far end of a 7,156-row ledger selects rows nobody saw.
    const extendedUpFromTopRow = gridReducer(initialState, { kind: "extendSelection", direction: "up" }, bounds);
    expect(extendedUpFromTopRow.focus.rowIndex).toBe(0);
    expect(extendedUpFromTopRow.selectedRowIndexes).toEqual([0]);

    const atLastRow = { ...initialState, focus: { rowIndex: 9, columnIndex: 0 } };
    const extendedDownFromLastRow = gridReducer(atLastRow, { kind: "extendSelection", direction: "down" }, bounds);
    expect(extendedDownFromLastRow.focus.rowIndex).toBe(9);
    expect(extendedDownFromLastRow.selectedRowIndexes).toEqual([9]);
  });

  it("toggles selection with Space and extends it with Shift+arrow", () => {
    const selected = gridReducer(initialState, { kind: "toggleSelection" }, bounds);
    expect(selected.selectedRowIndexes).toEqual([0]);
    expect(gridReducer(selected, { kind: "toggleSelection" }, bounds).selectedRowIndexes).toEqual([]);

    const extended = gridReducer(selected, { kind: "extendSelection", direction: "down" }, bounds);
    expect(extended.selectedRowIndexes).toEqual([0, 1]);
    expect(extended.focus.rowIndex).toBe(1);
  });

  it("selects a contiguous range on shift-click", () => {
    const anchored = gridReducer(initialState, { kind: "toggleSelection" }, bounds);
    const ranged = gridReducer(
      anchored,
      { kind: "clickSelect", rowIndex: 4, columnIndex: 0, withShift: true },
      bounds,
    );
    expect(ranged.selectedRowIndexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("moves column focus to the clicked cell, not just the clicked row (fix round 1, F3)", () => {
    // The gap the reviewer found: clicking a non-REF cell moved row focus but
    // left column focus wherever it already was, so the clicked cell never
    // actually became the focused cell and Enter opened the wrong editor.
    const clicked = gridReducer(
      initialState,
      { kind: "clickSelect", rowIndex: 3, columnIndex: 5, withShift: false },
      bounds,
    );
    expect(clicked.focus).toEqual({ rowIndex: 3, columnIndex: 5 });
  });

  it("moves column focus to the clicked cell on a shift-click too", () => {
    const anchored = { ...initialState, focus: { rowIndex: 0, columnIndex: 2 } };
    const ranged = gridReducer(
      anchored,
      { kind: "clickSelect", rowIndex: 4, columnIndex: 7, withShift: true },
      bounds,
    );
    expect(ranged.focus).toEqual({ rowIndex: 4, columnIndex: 7 });
    expect(ranged.selectedRowIndexes).toEqual([0, 1, 2, 3, 4]);
  });

  describe("rowsReplaced -- client-side filtering swaps the rows under index-keyed state (fix round 1, F2)", () => {
    // Every index in `GridState` addresses a POSITION, and from Task 13 on,
    // `LedgerPage` re-filters `rows` client-side on every keystroke in the
    // search box. Without this action, "row 0 is expanded" survives a filter
    // that removed row 0's case, and a desk agent sees another case's
    // applicants disclosed under a row they never expanded.
    const threeCaseIds = ["case_a", "case_b", "case_c"];

    it("moves a surviving case's focus, selection and expansion to its new index", () => {
      const beforeFiltering: GridState = {
        focus: { rowIndex: 0, columnIndex: 4 },
        selectedRowIndexes: [0, 1],
        expandedRowIndexes: [2],
        editing: undefined,
      };

      // case_a 0 -> 1, case_c 2 -> 0, case_b dropped. Every surviving case
      // changes index, so a reducer that simply kept the old numbers cannot
      // pass this by accident.
      const afterFiltering = gridReducer(
        beforeFiltering,
        { kind: "rowsReplaced", previousCaseIds: threeCaseIds, nextCaseIds: ["case_c", "case_a"] },
        bounds,
      );

      expect(afterFiltering.focus).toEqual({ rowIndex: 1, columnIndex: 4 });
      expect(afterFiltering.selectedRowIndexes).toEqual([1]);
      expect(afterFiltering.expandedRowIndexes).toEqual([0]);
    });

    it("drops the focused case's row rather than pointing focus at a row that no longer exists", () => {
      const focusedOnLastRow: GridState = {
        focus: { rowIndex: 2, columnIndex: 3 },
        selectedRowIndexes: [],
        expandedRowIndexes: [],
        editing: undefined,
      };

      const afterFiltering = gridReducer(
        focusedOnLastRow,
        { kind: "rowsReplaced", previousCaseIds: threeCaseIds, nextCaseIds: ["case_a", "case_b"] },
        bounds,
      );

      // The focused case is gone, so focus falls to the nearest row that does
      // exist -- never past the end, which is what leaves DOM focus on
      // document.body and the grid unreachable from the keyboard.
      expect(afterFiltering.focus).toEqual({ rowIndex: 1, columnIndex: 3 });
    });

    it("clears focus, selection and expansion when the filter matches nothing at all", () => {
      const withStateEverywhere: GridState = {
        focus: { rowIndex: 2, columnIndex: 5 },
        selectedRowIndexes: [0, 2],
        expandedRowIndexes: [1],
        editing: undefined,
      };

      const afterFiltering = gridReducer(
        withStateEverywhere,
        { kind: "rowsReplaced", previousCaseIds: threeCaseIds, nextCaseIds: [] },
        bounds,
      );

      expect(afterFiltering.focus).toEqual({ rowIndex: 0, columnIndex: 5 });
      expect(afterFiltering.selectedRowIndexes).toEqual([]);
      expect(afterFiltering.expandedRowIndexes).toEqual([]);
    });

    it("leaves state untouched when a refetch returns the very same cases", () => {
      const withStateEverywhere: GridState = {
        focus: { rowIndex: 2, columnIndex: 5 },
        selectedRowIndexes: [0, 2],
        expandedRowIndexes: [1],
        editing: undefined,
      };

      // A server refetch hands back a new array of the same cases. Remapping
      // it would be a no-op on paper, but returning the SAME state object is
      // what keeps a background refetch from re-rendering the grid and
      // re-measuring every row for nothing.
      const afterRefetch = gridReducer(
        withStateEverywhere,
        { kind: "rowsReplaced", previousCaseIds: threeCaseIds, nextCaseIds: [...threeCaseIds] },
        bounds,
      );

      expect(afterRefetch).toBe(withStateEverywhere);
    });
  });

  it("begins and cancels an edit without moving the focus", () => {
    const editing = gridReducer(initialState, { kind: "beginEdit" }, bounds);
    expect(editing.editing).toEqual({ rowIndex: 0, columnIndex: 0 });
    const cancelled = gridReducer(editing, { kind: "cancelEdit" }, bounds);
    expect(cancelled.editing).toBeUndefined();
    expect(cancelled.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
  });

  it("ignores a move while a cell is being edited, so arrow keys reach the input", () => {
    const editing = gridReducer(initialState, { kind: "beginEdit" }, bounds);
    const stillEditing = gridReducer(editing, { kind: "move", direction: "down" }, bounds);
    expect(stillEditing.focus).toEqual({ rowIndex: 0, columnIndex: 0 });
    expect(stillEditing.editing).toEqual({ rowIndex: 0, columnIndex: 0 });
  });
});
