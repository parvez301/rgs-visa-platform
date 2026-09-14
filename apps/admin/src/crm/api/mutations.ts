import { useMutation, useQueryClient, type QueryClient, type QueryKey, type UseMutationResult } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { ApiRequestError } from "../../lib/adminApi";
import { useUndoToast } from "../UndoToast";
import { BILLING_LABELS, CASE_STATUS_LABELS, VISA_TYPE_LABELS } from "../labels";
import { crmClient, type LedgerLoad } from "./crmClient";
import { crmQueryKeys } from "./hooks";

/**
 * R34: every optimistic cache operation below runs against this PREFIX, never
 * against a single computed `crmQueryKeys.ledger(...)` key. That key is
 * parameterised by the desk agent's active filter (hooks.ts:18,
 * `["crm", "ledger", sortedStatuses, partnerId]`) -- a mutation fired from an
 * edited cell has no idea which filter produced the row it is looking at, so
 * a computed key is the wrong key the instant an edit happens under any
 * filter other than the one guessed. Cancel, snapshot, write and invalidate
 * all go through `getQueriesData`/`setQueriesData` against this prefix so
 * every matching cache entry -- whatever filter produced it -- sees the same
 * write and, on failure, the same rollback. `mutations.test.tsx`'s
 * "R34" test is the one that fails if this ever regresses to a single key.
 */
const LEDGER_CACHE_KEY_PREFIX: QueryKey = ["crm", "ledger"];

export type LedgerEditColumn = "caseStatus" | "billingStatus" | "appointmentDate" | "visaType";

export interface LedgerEdit {
  caseId: string;
  column: LedgerEditColumn;
  /** `undefined` when the case had no value on this axis before the edit (an unset `appointmentDate`/`visaType`). */
  previousValue: string | undefined;
  nextValue: string;
}

/**
 * What a 409 leaves behind for the human to resolve. `serverMessage` is the
 * API's own words (`ApiRequestError.message`) -- rule 4 says show it, not
 * paraphrase it, because the server is the one that knows why the transition
 * from the *stored* state is illegal.
 */
export interface LedgerConflict {
  edit: LedgerEdit;
  serverMessage: string;
}

const LEDGER_EDIT_COLUMN_LABELS: Record<LedgerEditColumn, string> = {
  caseStatus: "Status",
  billingStatus: "Billing",
  appointmentDate: "Appointment date",
  visaType: "Visa type",
};

/**
 * The human-facing value for one edit's `nextValue` -- enum values are never
 * shown raw (global constraint), so every axis routes through its own label
 * map. Exported for `LedgerTable`'s conflict prompt, which shows the same
 * "your value" alongside the server's message.
 */
export function describeLedgerEditValue(edit: LedgerEdit): string {
  switch (edit.column) {
    case "caseStatus":
      return CASE_STATUS_LABELS[edit.nextValue as crm.CaseStatus];
    case "billingStatus":
      return BILLING_LABELS[edit.nextValue as crm.BillingStatus];
    case "visaType":
      return edit.nextValue === "" ? "No visa type" : VISA_TYPE_LABELS[edit.nextValue as crm.VisaType];
    case "appointmentDate":
      return edit.nextValue === "" ? "No appointment date" : edit.nextValue;
  }
}

function describeUndoMessage(edit: LedgerEdit): string {
  return `${LEDGER_EDIT_COLUMN_LABELS[edit.column]} changed to ${describeLedgerEditValue(edit)}.`;
}

/**
 * Undo has a limit (spec §9): reversing a status/billing edit is itself a
 * transition, and the state machines do not allow every reverse move
 * (`CLOSED -> anything` is not legal, for instance). `appointmentDate` and
 * `visaType` have no state machine guarding them -- any value can be set back
 * -- so only the two axis columns can ever be "impossible to undo".
 */
function isUndoPossible(edit: LedgerEdit): boolean {
  if (edit.previousValue === undefined) return false;
  switch (edit.column) {
    case "caseStatus":
      return crm.canTransitionCaseStatus(edit.nextValue as crm.CaseStatus, edit.previousValue as crm.CaseStatus);
    case "billingStatus":
      return crm.canTransitionBilling(edit.nextValue as crm.BillingStatus, edit.previousValue as crm.BillingStatus);
    case "appointmentDate":
    case "visaType":
      return true;
  }
}

function describeUndoImpossibleMessage(edit: LedgerEdit): string {
  switch (edit.column) {
    case "caseStatus":
      return `This change cannot be undone from here — the case is now ${CASE_STATUS_LABELS[edit.nextValue as crm.CaseStatus]}.`;
    case "billingStatus":
      return `This change cannot be undone from here — billing is now ${BILLING_LABELS[edit.nextValue as crm.BillingStatus]}.`;
    case "appointmentDate":
    case "visaType":
      // isUndoPossible never returns false for these two outside the
      // `previousValue === undefined` guard above, so this branch only
      // covers that guard -- there is no reverse state-machine failure to
      // name for an axis with no state machine.
      return "This change cannot be undone from here.";
  }
}

function applyEditToLedgerRow(row: crm.LedgerRow, edit: LedgerEdit): crm.LedgerRow {
  switch (edit.column) {
    case "caseStatus":
      return { ...row, caseStatus: edit.nextValue as crm.CaseStatus };
    case "billingStatus":
      return { ...row, billingStatus: edit.nextValue as crm.BillingStatus };
    case "appointmentDate":
      return { ...row, appointmentDate: edit.nextValue === "" ? undefined : edit.nextValue };
    case "visaType":
      return { ...row, visaType: edit.nextValue === "" ? undefined : (edit.nextValue as crm.VisaType) };
  }
}

function applyEditToCase(caseRecord: crm.CrmCase, edit: LedgerEdit): crm.CrmCase {
  switch (edit.column) {
    case "caseStatus":
      return { ...caseRecord, caseStatus: edit.nextValue as crm.CaseStatus };
    case "billingStatus":
      return { ...caseRecord, billingStatus: edit.nextValue as crm.BillingStatus };
    case "appointmentDate":
      return { ...caseRecord, appointmentDate: edit.nextValue === "" ? undefined : edit.nextValue };
    case "visaType":
      return { ...caseRecord, visaType: edit.nextValue === "" ? undefined : (edit.nextValue as crm.VisaType) };
  }
}

/**
 * What `onError` needs back from `onMutate` to put everything back the way it
 * was. `ledgerSnapshots` is every matching ledger cache ENTRY (R34), each one
 * the whole `LedgerLoad` -- rows array included, not a single row -- so a
 * rollback can never resurrect a case that a concurrent refetch had already
 * dropped from the list (rule 2).
 */
interface LedgerEditRollbackContext {
  ledgerSnapshots: [QueryKey, LedgerLoad | undefined][];
  caseSnapshot: crm.CrmCase | undefined;
}

async function applyOptimisticEditAndSnapshot(
  queryClient: QueryClient,
  edit: LedgerEdit,
  signalOptimisticWriteApplied: () => void,
): Promise<LedgerEditRollbackContext> {
  await queryClient.cancelQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
  await queryClient.cancelQueries({ queryKey: crmQueryKeys.case(edit.caseId) });

  const ledgerSnapshots = queryClient.getQueriesData<LedgerLoad>({ queryKey: LEDGER_CACHE_KEY_PREFIX });
  const caseSnapshot = queryClient.getQueryData<crm.CrmCase>(crmQueryKeys.case(edit.caseId));

  queryClient.setQueriesData<LedgerLoad>({ queryKey: LEDGER_CACHE_KEY_PREFIX }, (previousLedgerLoad) => {
    if (previousLedgerLoad === undefined) return previousLedgerLoad;
    return {
      ...previousLedgerLoad,
      rows: previousLedgerLoad.rows.map((row) =>
        row.caseId === edit.caseId ? applyEditToLedgerRow(row, edit) : row,
      ),
    };
  });
  queryClient.setQueryData<crm.CrmCase>(crmQueryKeys.case(edit.caseId), (previousCase) =>
    previousCase === undefined ? previousCase : applyEditToCase(previousCase, edit),
  );

  // Signalled AFTER the cache write above, never before: `commitEdit`'s
  // caller is awaiting exactly this, and the whole point of "optimistic" is
  // that the cache already holds the new value by the time that await
  // resolves (rule 2's own test: "before the request resolves").
  signalOptimisticWriteApplied();

  return { ledgerSnapshots, caseSnapshot };
}

function rollbackOptimisticEdit(
  queryClient: QueryClient,
  edit: LedgerEdit,
  context: LedgerEditRollbackContext | undefined,
): void {
  if (context === undefined) return;
  for (const [ledgerQueryKey, snapshotLedgerLoad] of context.ledgerSnapshots) {
    queryClient.setQueryData(ledgerQueryKey, snapshotLedgerLoad);
  }
  queryClient.setQueryData(crmQueryKeys.case(edit.caseId), context.caseSnapshot);
}

function invalidateAfterSettle(queryClient: QueryClient, edit: LedgerEdit): void {
  void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
  void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(edit.caseId) });
}

type LedgerAxisMutation = UseMutationResult<crm.CrmCase, Error, LedgerEdit, LedgerEditRollbackContext>;

export interface UseLedgerEditResult {
  /**
   * Optimistic: resolves once the new value is in the cache, not once the
   * request round-trips (rule 2). Direct human edits go straight to the REST
   * routes -- they are never staged behind the agent's approval gate (rule 1).
   */
  commitEdit(edit: LedgerEdit): Promise<void>;
  pendingConflict: LedgerConflict | undefined;
  resolveConflict(choice: "keepMine" | "keepTheirs"): void;
}

/**
 * One `useMutation` per axis (caseStatus/billingStatus/appointmentDate/
 * visaType), each carrying the same `onMutate`/`onError`/`onSettled` triple.
 * Call this once per screen (`LedgerTable` owns the call; `EditableCell`
 * receives `commitEdit` as a prop) -- `pendingConflict` is local React state,
 * and two independent calls would each keep their own, silently diverging.
 */
export function useLedgerEdit(): UseLedgerEditResult {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const { showUndo } = useUndoToast();
  const [pendingConflict, setPendingConflict] = useState<LedgerConflict | undefined>(undefined);

  // Keyed by the exact `LedgerEdit` object `commitEdit` receives (reference
  // identity, set and read within the same call) so concurrent edits on
  // different cells never share -- or clobber -- each other's signal.
  const optimisticWriteAppliedResolvers = useRef(new WeakMap<LedgerEdit, () => void>());

  function onMutateForEdit(edit: LedgerEdit): Promise<LedgerEditRollbackContext> {
    return applyOptimisticEditAndSnapshot(queryClient, edit, () => {
      optimisticWriteAppliedResolvers.current.get(edit)?.();
    });
  }

  function onErrorForEdit(error: Error, edit: LedgerEdit, context: LedgerEditRollbackContext | undefined): void {
    rollbackOptimisticEdit(queryClient, edit, context);
    // Rule 4: a 409 shows both values and asks -- it never picks. Every
    // other failure just rolls back silently (rule 2); only a genuine
    // conflict earns the prompt.
    if (error instanceof ApiRequestError && error.statusCode === 409) {
      setPendingConflict({ edit, serverMessage: error.message });
    }
  }

  function onSettledForEdit(_data: crm.CrmCase | undefined, _error: Error | null, edit: LedgerEdit): void {
    invalidateAfterSettle(queryClient, edit);
  }

  const caseStatusMutation = useMutation<crm.CrmCase, Error, LedgerEdit, LedgerEditRollbackContext>({
    mutationFn: (edit) => crmClient.setCaseStatus(idToken!, edit.caseId, edit.nextValue as crm.CaseStatus),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const billingStatusMutation = useMutation<crm.CrmCase, Error, LedgerEdit, LedgerEditRollbackContext>({
    mutationFn: (edit) => crmClient.setBillingStatus(idToken!, edit.caseId, edit.nextValue as crm.BillingStatus),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const appointmentDateMutation = useMutation<crm.CrmCase, Error, LedgerEdit, LedgerEditRollbackContext>({
    mutationFn: (edit) => crmClient.updateCaseDetails(idToken!, edit.caseId, { appointmentDate: edit.nextValue }),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const visaTypeMutation = useMutation<crm.CrmCase, Error, LedgerEdit, LedgerEditRollbackContext>({
    mutationFn: (edit) =>
      crmClient.updateCaseDetails(idToken!, edit.caseId, { visaType: edit.nextValue as crm.VisaType }),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });

  function mutationForColumn(column: LedgerEditColumn): LedgerAxisMutation {
    switch (column) {
      case "caseStatus":
        return caseStatusMutation;
      case "billingStatus":
        return billingStatusMutation;
      case "appointmentDate":
        return appointmentDateMutation;
      case "visaType":
        return visaTypeMutation;
    }
  }

  /**
   * The toast's own inverse write. Deliberately calls `mutateAsync` directly
   * rather than going through `commitEdit`: `commitEdit`'s promise resolves
   * as soon as the optimistic write lands (so the caller never waits on a
   * round trip), but the toast needs the OPPOSITE -- a promise that settles
   * with the real outcome, so it can tell the human the undo failed rather
   * than assuming it worked. Going through `mutateAsync` also means an undo
   * never itself offers a further undo -- rule 3 asks for an undo on every
   * committed *edit*, and an undo is not staged as a fresh edit here.
   */
  function performUndo(edit: LedgerEdit): Promise<void> {
    const inverseEdit: LedgerEdit = {
      caseId: edit.caseId,
      column: edit.column,
      previousValue: edit.nextValue,
      nextValue: edit.previousValue ?? "",
    };
    return mutationForColumn(inverseEdit.column)
      .mutateAsync(inverseEdit)
      .then(() => undefined);
  }

  async function commitEdit(edit: LedgerEdit): Promise<void> {
    const optimisticWriteApplied = new Promise<void>((resolve) => {
      optimisticWriteAppliedResolvers.current.set(edit, resolve);
    });
    mutationForColumn(edit.column).mutate(edit, {
      onSuccess: () => {
        if (isUndoPossible(edit)) {
          showUndo(describeUndoMessage(edit), () => performUndo(edit));
        } else {
          showUndo(describeUndoImpossibleMessage(edit));
        }
      },
    });
    await optimisticWriteApplied;
  }

  function resolveConflict(choice: "keepMine" | "keepTheirs"): void {
    if (pendingConflict === undefined) return;
    const conflict = pendingConflict;
    setPendingConflict(undefined);
    if (choice === "keepMine") {
      // The human has seen the stored value and still wants theirs written --
      // rule 4 forbids the CLIENT from making this call automatically, not
      // the human. Retried as a fresh edit, so it is optimistic and
      // rollback-safe the same as any other commit.
      void commitEdit(conflict.edit);
      return;
    }
    // "Keep theirs": nothing to write -- the rollback in `onErrorForEdit`
    // already restored the stored value. Invalidating explicitly (rather
    // than relying only on `onSettled`, which already ran) is a cheap
    // insurance that both caches reflect the real, current record.
    invalidateAfterSettle(queryClient, conflict.edit);
  }

  return { commitEdit, pendingConflict, resolveConflict };
}
