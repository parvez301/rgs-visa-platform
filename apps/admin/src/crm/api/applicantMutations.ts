import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { useUndoToast } from "../UndoToast";
import { CUSTODY_LABELS, OUTCOME_LABELS } from "../labels";
import { crmClient } from "./crmClient";
import {
  applyOptimisticCaseWriteAndSnapshot,
  describeFailedWriteMessage,
  invalidateAfterCaseWriteSettles,
  readConflictMessage,
  rollbackOptimisticCaseWrite,
  useOptimisticWriteSignal,
  type OptimisticCaseWriteContext,
} from "./mutations";

/**
 * The per-applicant half of "every write: optimistic, rollback on failure,
 * visible undo" (spec line 333, R49).
 *
 * A separate file from `mutations.ts`, and a separate hook from
 * `useLedgerEdit`, for one structural reason: `LedgerEdit` addresses a CASE
 * (`{ caseId, column, ... }`) because that is all a ledger row has, and
 * `custody`/`outcome` live on an APPLICANT -- their routes carry an
 * `applicantRef` in the path, which a `LedgerEdit` has nowhere to put. What is
 * NOT duplicated is the optimistic machinery: the snapshot/patch, the
 * rollback, the invalidation and the 409 test are all imported from
 * `mutations.ts`, so the two hooks cannot drift apart on any of them.
 */
export type ApplicantEditAxis = "custody" | "outcome";

export interface ApplicantEdit {
  caseId: string;
  applicantRef: string;
  axis: ApplicantEditAxis;
  /** The applicant's stored value before this edit -- what an undo writes back. */
  fromValue: string;
  toValue: string;
}

/** Same shape, same reason, as `LedgerConflict`: the server's own words (rule 4). */
export interface ApplicantConflict {
  edit: ApplicantEdit;
  serverMessage: string;
}

const APPLICANT_EDIT_AXIS_LABELS: Record<ApplicantEditAxis, string> = {
  custody: "Custody",
  outcome: "Outcome",
};

/** Enum values are never shown raw (global constraint), undo toasts included. */
export function describeApplicantEditValue(edit: ApplicantEdit): string {
  return edit.axis === "custody"
    ? CUSTODY_LABELS[edit.toValue as crm.CustodyStatus]
    : OUTCOME_LABELS[edit.toValue as crm.ApplicantOutcome];
}

function describeApplicantEditFromValue(edit: ApplicantEdit): string {
  return edit.axis === "custody"
    ? CUSTODY_LABELS[edit.fromValue as crm.CustodyStatus]
    : OUTCOME_LABELS[edit.fromValue as crm.ApplicantOutcome];
}

function describeUndoMessage(edit: ApplicantEdit): string {
  return `${APPLICANT_EDIT_AXIS_LABELS[edit.axis]} for applicant ${edit.applicantRef} changed to ${describeApplicantEditValue(edit)}.`;
}

/**
 * Both per-applicant axes ARE state machines (unlike `appointmentDate` and
 * `visaType`), so an undo is a transition the server may refuse: `RETURNED`
 * has no outgoing custody edges at all, and a decided `APPROVED`/`REJECTED`
 * outcome has none either. Offering an Undo button that 409s is worse than
 * saying up front that this one cannot be taken back from here.
 */
function isUndoPossible(edit: ApplicantEdit): boolean {
  return edit.axis === "custody"
    ? crm.canTransitionCustody(edit.toValue as crm.CustodyStatus, edit.fromValue as crm.CustodyStatus)
    : crm.canTransitionOutcome(edit.toValue as crm.ApplicantOutcome, edit.fromValue as crm.ApplicantOutcome);
}

function describeUndoImpossibleMessage(edit: ApplicantEdit): string {
  return `This change cannot be undone from here — ${APPLICANT_EDIT_AXIS_LABELS[
    edit.axis
  ].toLowerCase()} for applicant ${edit.applicantRef} is now ${describeApplicantEditValue(edit)}.`;
}

function applyEditToCase(caseRecord: crm.CrmCase, edit: ApplicantEdit): crm.CrmCase {
  return {
    ...caseRecord,
    applicants: caseRecord.applicants.map((applicant) => {
      if (applicant.applicantRef !== edit.applicantRef) return applicant;
      return edit.axis === "custody"
        ? { ...applicant, custody: edit.toValue as crm.CustodyStatus }
        : { ...applicant, outcome: edit.toValue as crm.ApplicantOutcome };
    }),
  };
}

type ApplicantAxisMutation = UseMutationResult<crm.CrmCase, Error, ApplicantEdit, OptimisticCaseWriteContext>;

export interface UseApplicantEditResult {
  /** Optimistic: resolves once the new value is in the case cache, not once the request round-trips. */
  commitEdit(edit: ApplicantEdit): Promise<void>;
  pendingConflict: ApplicantConflict | undefined;
  resolveConflict(choice: "keepMine" | "keepTheirs"): void;
}

/**
 * Call once per screen, for the same reason `useLedgerEdit` says so:
 * `pendingConflict` is local React state, and two calls would each keep their
 * own and silently disagree about whether a prompt is open.
 */
export function useApplicantEdit(): UseApplicantEditResult {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const { showUndo } = useUndoToast();
  const [pendingConflict, setPendingConflict] = useState<ApplicantConflict | undefined>(undefined);
  const optimisticWriteSignal = useOptimisticWriteSignal<ApplicantEdit>();

  function onMutateForEdit(edit: ApplicantEdit): Promise<OptimisticCaseWriteContext> {
    // No `patchLedgerRow`: the Ledger's per-case `applicantSummary` roll-up is
    // computed server-side across every applicant, and a client-side guess at
    // the new counts would be contradicted by the refetch `onSettled` starts
    // moments later. The ledger prefix is invalidated instead (R49).
    return applyOptimisticCaseWriteAndSnapshot(
      queryClient,
      edit.caseId,
      { patchCase: (caseRecord) => applyEditToCase(caseRecord, edit) },
      () => optimisticWriteSignal.signalWriteApplied(edit),
    );
  }

  function onErrorForEdit(
    error: Error,
    edit: ApplicantEdit,
    context: OptimisticCaseWriteContext | undefined,
  ): void {
    rollbackOptimisticCaseWrite(queryClient, edit.caseId, context);
    const conflictMessage = readConflictMessage(error);
    if (conflictMessage !== undefined) {
      setPendingConflict({ edit, serverMessage: conflictMessage });
    }
    // Every other failure is reported by `reportFailedWrite` below, from
    // `commitEdit`'s own per-call `onError`, for the reasons `useLedgerEdit`'s
    // copy of that function sets out at length -- this handler is shared with
    // the inverse write `performUndo` drives, and a failed undo already has
    // its own words on the toast that offered it.
  }

  /** R77, and the same shape as `useLedgerEdit`'s: a non-409 write failure is never silent. */
  function reportFailedWrite(error: Error): void {
    if (readConflictMessage(error) !== undefined) return;
    showUndo(describeFailedWriteMessage(error));
  }

  function onSettledForEdit(
    _data: crm.CrmCase | undefined,
    _error: Error | null,
    edit: ApplicantEdit,
  ): void {
    invalidateAfterCaseWriteSettles(queryClient, edit.caseId);
  }

  const custodyMutation = useMutation<crm.CrmCase, Error, ApplicantEdit, OptimisticCaseWriteContext>({
    mutationFn: (edit) =>
      crmClient.setCustody(idToken!, edit.caseId, edit.applicantRef, edit.toValue as crm.CustodyStatus),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });
  const outcomeMutation = useMutation<crm.CrmCase, Error, ApplicantEdit, OptimisticCaseWriteContext>({
    mutationFn: (edit) =>
      crmClient.setOutcome(idToken!, edit.caseId, edit.applicantRef, edit.toValue as crm.ApplicantOutcome),
    onMutate: onMutateForEdit,
    onError: onErrorForEdit,
    onSettled: onSettledForEdit,
  });

  function mutationForAxis(axis: ApplicantEditAxis): ApplicantAxisMutation {
    return axis === "custody" ? custodyMutation : outcomeMutation;
  }

  /**
   * The inverse write, through the same route. `mutateAsync` rather than
   * `commitEdit` for `useLedgerEdit`'s own two reasons: the toast needs a
   * promise that settles with the REAL outcome so it can say the undo failed,
   * and an undo must never itself offer a further undo.
   */
  function performUndo(edit: ApplicantEdit): Promise<void> {
    const inverseEdit: ApplicantEdit = {
      caseId: edit.caseId,
      applicantRef: edit.applicantRef,
      axis: edit.axis,
      fromValue: edit.toValue,
      toValue: edit.fromValue,
    };
    return mutationForAxis(inverseEdit.axis)
      .mutateAsync(inverseEdit)
      .then(() => undefined);
  }

  async function commitEdit(edit: ApplicantEdit): Promise<void> {
    const optimisticWriteApplied = optimisticWriteSignal.waitForWriteApplied(edit);
    mutationForAxis(edit.axis).mutate(edit, {
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
      // Rule 4 forbids the CLIENT from retrying automatically, not the human.
      // Re-committed as a fresh edit, so the retry is optimistic and
      // rollback-safe like any other. `fromValue` is deliberately left as the
      // value this edit started from: the retry's own undo has to write back
      // what the applicant held before the human's first attempt, not the
      // value the server had meanwhile moved to.
      void commitEdit(conflict.edit);
      return;
    }
    // "Keep theirs": `onErrorForEdit`'s rollback already restored the stored
    // value; invalidating is cheap insurance that both caches hold the real
    // record.
    invalidateAfterCaseWriteSettles(queryClient, conflict.edit.caseId);
  }

  return { commitEdit, pendingConflict, resolveConflict };
}

/** Exported for the Case screen's conflict prompt, which shows "your value" beside the server's message. */
export function describeApplicantConflict(conflict: ApplicantConflict): {
  yourValue: string;
  storedValueBeforeYourEdit: string;
} {
  return {
    yourValue: describeApplicantEditValue(conflict.edit),
    storedValueBeforeYourEdit: describeApplicantEditFromValue(conflict.edit),
  };
}
