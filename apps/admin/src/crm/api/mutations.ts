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
export const LEDGER_CACHE_KEY_PREFIX: QueryKey = ["crm", "ledger"];

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
 *
 * Exported alongside the three functions below because Task 14's
 * `useApplicantEdit` (R49) writes to the same two caches for the same reasons
 * -- a second, verbatim copy of this triple is what the ruling forbids.
 */
export interface OptimisticCaseWriteContext {
  ledgerSnapshots: [QueryKey, LedgerLoad | undefined][];
  caseSnapshot: crm.CrmCase | undefined;
}

/**
 * How one write shows up optimistically in each cache that holds the case.
 *
 * `patchLedgerRow` is optional, and its absence is a claim, not an omission: a
 * per-applicant custody change moves the Ledger's `applicantSummary` roll-up,
 * which is computed SERVER-side (`packages/shared/src/crm/ledger.ts`) from the
 * whole applicant list. Guessing at the new roll-up client-side would put a
 * number on screen that the next refetch contradicts, so that write patches
 * the case cache only and lets `onSettled`'s ledger invalidation fetch the
 * real roll-up.
 */
export interface OptimisticCaseWritePatches {
  patchCase(caseRecord: crm.CrmCase): crm.CrmCase;
  patchLedgerRow?(ledgerRow: crm.LedgerRow): crm.LedgerRow;
}

export async function applyOptimisticCaseWriteAndSnapshot(
  queryClient: QueryClient,
  caseId: string,
  patches: OptimisticCaseWritePatches,
  signalOptimisticWriteApplied: () => void,
): Promise<OptimisticCaseWriteContext> {
  await queryClient.cancelQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
  await queryClient.cancelQueries({ queryKey: crmQueryKeys.case(caseId) });

  const ledgerSnapshots = queryClient.getQueriesData<LedgerLoad>({ queryKey: LEDGER_CACHE_KEY_PREFIX });
  const caseSnapshot = queryClient.getQueryData<crm.CrmCase>(crmQueryKeys.case(caseId));

  const { patchLedgerRow } = patches;
  if (patchLedgerRow !== undefined) {
    queryClient.setQueriesData<LedgerLoad>({ queryKey: LEDGER_CACHE_KEY_PREFIX }, (previousLedgerLoad) => {
      if (previousLedgerLoad === undefined) return previousLedgerLoad;
      return {
        ...previousLedgerLoad,
        rows: previousLedgerLoad.rows.map((row) => (row.caseId === caseId ? patchLedgerRow(row) : row)),
      };
    });
  }
  queryClient.setQueryData<crm.CrmCase>(crmQueryKeys.case(caseId), (previousCase) =>
    previousCase === undefined ? previousCase : patches.patchCase(previousCase),
  );

  // Signalled AFTER the cache write above, never before: `commitEdit`'s
  // caller is awaiting exactly this, and the whole point of "optimistic" is
  // that the cache already holds the new value by the time that await
  // resolves (rule 2's own test: "before the request resolves").
  signalOptimisticWriteApplied();

  return { ledgerSnapshots, caseSnapshot };
}

export function rollbackOptimisticCaseWrite(
  queryClient: QueryClient,
  caseId: string,
  context: OptimisticCaseWriteContext | undefined,
): void {
  if (context === undefined) return;
  for (const [ledgerQueryKey, snapshotLedgerLoad] of context.ledgerSnapshots) {
    queryClient.setQueryData(ledgerQueryKey, snapshotLedgerLoad);
  }
  queryClient.setQueryData(crmQueryKeys.case(caseId), context.caseSnapshot);
}

/**
 * R76: the ledger is marked STALE, never refetched on the spot; the case is
 * refetched actively.
 *
 * `listLedgerRows` (services/api/src/domain/crm/ledger.ts) reads GSI1 through
 * `queryGsiPage`, and a DynamoDB GSI read is always eventually consistent --
 * the plan's own `## Established facts` says so. Refetching the instant the PUT
 * settles therefore races the index: the base-table write returns, the client
 * immediately re-reads GSI1, and GSI1 may still be serving the pre-write
 * projection. The refetch then overwrites the optimistic value with the stale
 * one -- and because `hooks.ts` gives the ledger `staleTime: 5 * 60_000`,
 * nothing asks again for five minutes. The desk agent watches their edit apply,
 * revert, and stay reverted. The race is narrow (GSI propagation is usually
 * sub-second against a 50-200ms round trip) but one-directional: it can only
 * ever lose the newer value.
 *
 * `refetchType: "none"` marks every matching ledger entry invalidated without
 * starting a fetch, so the next natural read -- a remount, a window focus, a
 * filter change -- picks the ledger up once the index has caught up, and until
 * then the optimistic patch (which holds exactly what the PUT wrote) stands.
 * The case query keeps refetching actively on purpose: `getCase` is a
 * strongly consistent GetItem on the base table, so it has no race to lose.
 *
 * No test can see this. `InMemoryTableClient` is strongly consistent by
 * construction, so `queryGsiPage` there always reflects the preceding `put`
 * (G5) -- this comment is the record of the decision, which is why it is this
 * long. What `mutations.test.tsx` CAN pin, and does, is the mechanism: after a
 * settled write the ledger entry is invalidated and no second ledger GET went
 * out, while the case GET did.
 */
export function invalidateAfterCaseWriteSettles(queryClient: QueryClient, caseId: string): void {
  void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX, refetchType: "none" });
  void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseId) });
}

/**
 * Rule 4's one trigger: a 409 shows both values and asks. Shared with
 * `useApplicantEdit` so the two hooks can never disagree about which failures
 * earn a prompt.
 */
export function readConflictMessage(error: Error): string | undefined {
  return error instanceof ApiRequestError && error.statusCode === 409 ? error.message : undefined;
}

/** What a non-`ApiRequestError` failure -- a dropped connection, a DNS failure -- says. */
const WRITE_DID_NOT_SAVE_MESSAGE =
  "Your edit did not save. Check your connection and try again.";

/**
 * R77: what a write failure that is NOT a 409 tells the human.
 *
 * Plan rule 2 and spec line 333 both say "rollback on failure" and neither
 * asks for a message, and the branch followed the letter: a 400 from a
 * malformed body, a 403 from an expired token, a 500 or a dropped connection
 * all produced an optimistic write, a rollback, and nothing at all -- the
 * value flickered and reverted, four different causes looking identical.
 * The server's own words where there are any (rule 4's reasoning about a 409
 * applies just as well to a 400: the server is the one that knows why), and a
 * fixed sentence naming the likeliest cause when the failure never reached a
 * server to have words.
 */
export function describeFailedWriteMessage(error: Error): string {
  return error instanceof ApiRequestError ? error.message : WRITE_DID_NOT_SAVE_MESSAGE;
}

/**
 * The handshake that makes `commitEdit` resolve when the OPTIMISTIC write
 * lands rather than when the request round-trips.
 *
 * Keyed by the exact edit object `commitEdit` receives (reference identity,
 * set and read within the same call) so concurrent edits on different cells
 * never share -- or clobber -- each other's signal. A `WeakMap` rather than a
 * `Map` because nothing ever removes an entry: the edit object is the only
 * thing keeping it alive.
 */
export function useOptimisticWriteSignal<EditType extends object>(): {
  /** Registers, then returns, the promise `commitEdit` awaits. Call before starting the mutation. */
  waitForWriteApplied(edit: EditType): Promise<void>;
  signalWriteApplied(edit: EditType): void;
} {
  const writeAppliedResolvers = useRef(new WeakMap<EditType, () => void>());
  return {
    waitForWriteApplied(edit: EditType): Promise<void> {
      return new Promise<void>((resolveWriteApplied) => {
        writeAppliedResolvers.current.set(edit, resolveWriteApplied);
      });
    },
    signalWriteApplied(edit: EditType): void {
      writeAppliedResolvers.current.get(edit)?.();
    },
  };
}

type LedgerAxisMutation = UseMutationResult<crm.CrmCase, Error, LedgerEdit, OptimisticCaseWriteContext>;

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
  const optimisticWriteSignal = useOptimisticWriteSignal<LedgerEdit>();

  function onMutateForEdit(edit: LedgerEdit): Promise<OptimisticCaseWriteContext> {
    return applyOptimisticCaseWriteAndSnapshot(
      queryClient,
      edit.caseId,
      {
        patchCase: (caseRecord) => applyEditToCase(caseRecord, edit),
        patchLedgerRow: (ledgerRow) => applyEditToLedgerRow(ledgerRow, edit),
      },
      () => optimisticWriteSignal.signalWriteApplied(edit),
    );
  }

  function onErrorForEdit(error: Error, edit: LedgerEdit, context: OptimisticCaseWriteContext | undefined): void {
    rollbackOptimisticCaseWrite(queryClient, edit.caseId, context);
    // Rule 4: a 409 shows both values and asks -- it never picks. Only a
    // genuine conflict earns the prompt, and the prompt is the whole message:
    // a toast beside it would be a second, quieter answer to the same
    // question.
    const conflictMessage = readConflictMessage(error);
    if (conflictMessage !== undefined) {
      setPendingConflict({ edit, serverMessage: conflictMessage });
    }
    // Every OTHER failure is reported by `reportFailedWrite` below, from
    // `commitEdit`'s own per-call `onError` rather than from here -- see that
    // function for why this shared handler is the wrong place for it.
  }

  /**
   * R77: a write failure that is not a 409 must not be silent.
   *
   * Before this, a 400 from a malformed body, a 403 from an expired token, a
   * 500 and a dropped connection all looked identical to a desk agent: the
   * value flickered and reverted, with no toast, no alert and nothing in the
   * UI to say which of the four had happened. `showUndo(message)` with no undo
   * callback is the message-only toast this branch already built for "this
   * change cannot be undone from here" -- no new machinery.
   *
   * DELIBERATELY NOT in `onErrorForEdit`, which R77 names, and this is the one
   * place this wave departs from a ruling (reported, not silent). That handler
   * is shared verbatim with the inverse write `performUndo` drives, and an
   * undo failure is ALREADY reported -- `UndoToast` renders "Undo failed:
   * <the server's words>" on the toast that offered the undo, with a Retry
   * button. Firing this from there would print the server's sentence twice for
   * one failure and, on the network branch, would tell the human "Your edit
   * did not save" about an edit that saved perfectly well and an UNDO that did
   * not. A per-call `onError` beside the `onSuccess` that is already here
   * scopes the message to a human's own commit -- including a "Keep mine"
   * retry, which goes back through `commitEdit` -- and costs no machinery at
   * all.
   */
  function reportFailedWrite(error: Error): void {
    // The 409 already has the conflict prompt, which asks a question; a toast
    // beside it would be a second, quieter answer to the same question.
    if (readConflictMessage(error) !== undefined) return;
    showUndo(describeFailedWriteMessage(error));
  }

  function onSettledForEdit(_data: crm.CrmCase | undefined, _error: Error | null, edit: LedgerEdit): void {
    invalidateAfterCaseWriteSettles(queryClient, edit.caseId);
  }

  const caseStatusMutation = useMutation<crm.CrmCase, Error, LedgerEdit, OptimisticCaseWriteContext>({
    mutationFn: (edit) => crmClient.setCaseStatus(idToken!, edit.caseId, edit.nextValue as crm.CaseStatus),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const billingStatusMutation = useMutation<crm.CrmCase, Error, LedgerEdit, OptimisticCaseWriteContext>({
    mutationFn: (edit) => crmClient.setBillingStatus(idToken!, edit.caseId, edit.nextValue as crm.BillingStatus),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const appointmentDateMutation = useMutation<crm.CrmCase, Error, LedgerEdit, OptimisticCaseWriteContext>({
    mutationFn: (edit) => crmClient.updateCaseDetails(idToken!, edit.caseId, { appointmentDate: edit.nextValue }),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const visaTypeMutation = useMutation<crm.CrmCase, Error, LedgerEdit, OptimisticCaseWriteContext>({
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
    const optimisticWriteApplied = optimisticWriteSignal.waitForWriteApplied(edit);
    mutationForColumn(edit.column).mutate(edit, {
      onSuccess: () => {
        if (isUndoPossible(edit)) {
          showUndo(describeUndoMessage(edit), () => performUndo(edit));
        } else {
          showUndo(describeUndoImpossibleMessage(edit));
        }
      },
      onError: reportFailedWrite,
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
    invalidateAfterCaseWriteSettles(queryClient, conflict.edit.caseId);
  }

  return { commitEdit, pendingConflict, resolveConflict };
}
