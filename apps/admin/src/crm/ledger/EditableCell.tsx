import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { crm } from "@rgs/shared";
import { AxisChip } from "../components/Chip";
import { BILLING_LABELS, CASE_STATUS_LABELS, VISA_TYPE_LABELS } from "../labels";
import type { LedgerEditColumn } from "../api/mutations";

interface EditableCellProps {
  column: LedgerEditColumn;
  row: crm.LedgerRow;
  /** Fires with the raw string the widget committed -- never before the human confirms it. */
  onCommit: (nextValue: string) => void;
  /**
   * Driven by the grid's own `gridState.editing` (Task 11): true means "the
   * grid wants this cell open right now." `EditableCell` also opens/closes
   * itself on its own Enter/Escape (see below) so it stays usable -- and
   * testable -- with no grid around it at all; the two never disagree in
   * practice because the same keydown that flips this prop also reaches
   * this component's own handler first.
   */
  isEditing: boolean;
  /**
   * Called whenever this cell closes itself, for any reason: a commit that
   * does not stay open, or an Escape cancel. Lets the grid clear its own
   * `editing` field (via the existing `cancelEdit` action) so arrow-key
   * navigation is not blocked forever after the first edit. Optional so the
   * component is fully usable standalone in a test.
   */
  onCloseEditor?: () => void;
  /**
   * Overrides the closed-cell display that `renderStaticValue` below would
   * otherwise produce. Needed because `LedgerColumn.render` and this
   * component's own per-axis static rendering can legitimately disagree: the
   * "Type" column's `render` shows `describeCaseType` (case type AND visa
   * type together, e.g. "Visa · Tourist"), while this component's own
   * `visaType` branch only knows the visa type alone. Wiring `visaType` onto
   * that column (fix round 1, F1) without this prop would silently regress
   * every row's closed "Type" cell to the bare visa label. Optional so the
   * 11 pre-existing tests that render this component with no column of its
   * own in mind keep using the built-in per-axis fallback unchanged.
   */
  renderClosedValue?: () => ReactNode;
}

/** The row's own current value for this axis, as the plain string every editor works in. */
export function readLedgerColumnValue(column: LedgerEditColumn, row: crm.LedgerRow): string {
  switch (column) {
    case "caseStatus":
      return row.caseStatus;
    case "billingStatus":
      return row.billingStatus;
    case "appointmentDate":
      return row.appointmentDate ?? "";
    case "visaType":
      return row.visaType ?? "";
  }
}

/**
 * A dropdown listing every `CaseStatus`/`BillingStatus` invites a click that
 * 409s. `crm.canTransitionCaseStatus`/`canTransitionBilling` are the same
 * rules the server enforces, so the offered list and the server agree by
 * construction. The current value always stays in the list -- a `<select>`
 * whose `value` names an absent `<option>` renders blank.
 */
function allowedCaseStatusOptions(currentCaseStatus: crm.CaseStatus): crm.CaseStatus[] {
  return crm.CASE_STATUSES.filter(
    (candidateCaseStatus) =>
      candidateCaseStatus === currentCaseStatus ||
      crm.canTransitionCaseStatus(currentCaseStatus, candidateCaseStatus),
  );
}

function allowedBillingStatusOptions(currentBillingStatus: crm.BillingStatus): crm.BillingStatus[] {
  return crm.BILLING_STATUSES.filter(
    (candidateBillingStatus) =>
      candidateBillingStatus === currentBillingStatus ||
      crm.canTransitionBilling(currentBillingStatus, candidateBillingStatus),
  );
}

function renderStaticValue(column: LedgerEditColumn, row: crm.LedgerRow) {
  switch (column) {
    case "caseStatus":
      return <AxisChip axis="caseStatus" value={row.caseStatus} />;
    case "billingStatus":
      return <AxisChip axis="billing" value={row.billingStatus} />;
    case "appointmentDate":
      return row.appointmentDate ?? "—";
    case "visaType":
      return row.visaType === undefined ? "—" : VISA_TYPE_LABELS[row.visaType];
  }
}

export function EditableCell({
  column,
  row,
  onCommit,
  isEditing,
  onCloseEditor,
  renderClosedValue,
}: EditableCellProps) {
  const [isOpen, setIsOpen] = useState(isEditing);
  const [draftValue, setDraftValue] = useState(() => readLedgerColumnValue(column, row));
  const editorElementRef = useRef<HTMLSelectElement & HTMLInputElement>(null);

  // The grid can force this cell open (Enter on the focused gridcell bubbles
  // to the grid's own keymap before this component ever sees it -- see the
  // `isEditing` doc comment) or force it closed (a different cell became the
  // one being edited). Either way, the prop is the source of truth for
  // *entering* edit mode from outside.
  useEffect(() => {
    if (isEditing) setDraftValue(readLedgerColumnValue(column, row));
    setIsOpen(isEditing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  useEffect(() => {
    if (isOpen) editorElementRef.current?.focus();
  }, [isOpen]);

  function openEditor() {
    setDraftValue(readLedgerColumnValue(column, row));
    setIsOpen(true);
  }

  function closeWithoutCommitting() {
    setDraftValue(readLedgerColumnValue(column, row));
    setIsOpen(false);
    onCloseEditor?.();
  }

  function commitDraft(options: { keepOpen: boolean }) {
    const currentValue = readLedgerColumnValue(column, row);
    if (draftValue !== currentValue) {
      onCommit(draftValue);
    }
    if (!options.keepOpen) {
      setIsOpen(false);
      onCloseEditor?.();
    }
  }

  if (!isOpen) {
    return (
      <div
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            openEditor();
          }
        }}
      >
        {renderClosedValue !== undefined ? renderClosedValue() : renderStaticValue(column, row)}
      </div>
    );
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLSelectElement | HTMLInputElement>) {
    // Never let the grid's fixed keymap see a key aimed at an open editor --
    // an ArrowDown meant to change a native <select>'s highlighted option
    // must not also move grid focus, and a preventDefault() further up the
    // bubble would cancel the browser's own default action on this element.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeWithoutCommitting();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDraft({ keepOpen: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitDraft({ keepOpen: false });
    }
  }

  if (column === "appointmentDate") {
    return (
      <input
        ref={editorElementRef}
        type="date"
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={() => commitDraft({ keepOpen: false })}
        onKeyDown={handleEditorKeyDown}
      />
    );
  }

  if (column === "visaType") {
    const isDisabledForNonVisaCase = row.caseType !== "VISA";
    return (
      <select
        ref={editorElementRef}
        value={draftValue}
        disabled={isDisabledForNonVisaCase}
        title={isDisabledForNonVisaCase ? "Only a VISA case can carry a visa type" : undefined}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={() => commitDraft({ keepOpen: false })}
        onKeyDown={handleEditorKeyDown}
      >
        {crm.VISA_TYPES.map((visaType) => (
          <option key={visaType} value={visaType}>
            {VISA_TYPE_LABELS[visaType]}
          </option>
        ))}
      </select>
    );
  }

  const isCaseStatusColumn = column === "caseStatus";
  const allowedOptionValues = isCaseStatusColumn
    ? allowedCaseStatusOptions(row.caseStatus)
    : allowedBillingStatusOptions(row.billingStatus);
  const optionLabels: Record<string, string> = isCaseStatusColumn ? CASE_STATUS_LABELS : BILLING_LABELS;

  return (
    <select
      ref={editorElementRef}
      value={draftValue}
      onChange={(event) => setDraftValue(event.target.value)}
      onBlur={() => commitDraft({ keepOpen: false })}
      onKeyDown={handleEditorKeyDown}
    >
      {allowedOptionValues.map((optionValue) => (
        <option key={optionValue} value={optionValue}>
          {optionLabels[optionValue]}
        </option>
      ))}
    </select>
  );
}
