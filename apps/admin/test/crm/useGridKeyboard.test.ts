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
    const ranged = gridReducer(anchored, { kind: "clickSelect", rowIndex: 4, withShift: true }, bounds);
    expect(ranged.selectedRowIndexes).toEqual([0, 1, 2, 3, 4]);
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
