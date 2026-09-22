import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { BILLING_LABELS, CASE_STATUS_LABELS } from "../labels";
import { crmClient } from "../api/crmClient";
import { LEDGER_CACHE_KEY_PREFIX } from "../api/mutations";
import { CARD_CLASS, FIELD_LABEL_CLASS, INPUT_CLASS, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "../components/controls";
import {
  applyBulkLedgerEdits,
  BULK_SELECTION_WARN_THRESHOLD,
  summariseBulkEditResults,
  type BulkLedgerAxis,
} from "./bulkEdits";

export interface BulkActionsBarProps {
  selectedCaseIds: readonly string[];
  onClearSelection: () => void;
}

/**
 * Human bulk path for the Ledger selection: N sequential single-case status
 * or billing writes, with a per-case result summary. Deliberately not the
 * agent proposal path -- ops asked for a direct toolbar.
 */
export function BulkActionsBar({ selectedCaseIds, onClearSelection }: BulkActionsBarProps) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [caseStatusTarget, setCaseStatusTarget] = useState<crm.CaseStatus | "">("");
  const [billingStatusTarget, setBillingStatusTarget] = useState<crm.BillingStatus | "">("");
  const [isApplying, setIsApplying] = useState(false);
  const [resultSummary, setResultSummary] = useState<string | null>(null);

  if (selectedCaseIds.length === 0) return null;

  async function runBulk(column: BulkLedgerAxis, nextValue: string): Promise<void> {
    if (idToken === null) return;
    if (
      selectedCaseIds.length > BULK_SELECTION_WARN_THRESHOLD &&
      !window.confirm(
        `Apply this change to ${selectedCaseIds.length} cases? That is more than ${BULK_SELECTION_WARN_THRESHOLD}.`,
      )
    ) {
      return;
    }

    setIsApplying(true);
    setResultSummary(null);
    try {
      const results = await applyBulkLedgerEdits({
        caseIds: selectedCaseIds,
        column,
        nextValue,
        performEdit: async (caseId, editColumn, editValue) => {
          if (editColumn === "caseStatus") {
            await crmClient.setCaseStatus(idToken, caseId, editValue as crm.CaseStatus);
          } else {
            await crmClient.setBillingStatus(idToken, caseId, editValue as crm.BillingStatus);
          }
        },
      });
      await queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
      const summary = summariseBulkEditResults(results);
      if (summary.failedCount === 0) {
        setResultSummary(`Applied to ${summary.appliedCount} case${summary.appliedCount === 1 ? "" : "s"}.`);
      } else {
        setResultSummary(
          `${summary.appliedCount} applied, ${summary.failedCount} failed` +
            (summary.failedCaseIds.length > 0 ? `: ${summary.failedCaseIds.join(", ")}` : ".") +
            (summary.failedCaseIds.length > 0 ? "." : ""),
        );
      }
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={`flex flex-wrap items-end gap-3 px-4 py-3 ${CARD_CLASS}`}
    >
      <p className="text-sm font-medium text-ink">
        {selectedCaseIds.length} selected
      </p>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>Set status</span>
        <select
          aria-label="Bulk case status"
          value={caseStatusTarget}
          disabled={isApplying}
          onChange={(changeEvent) => setCaseStatusTarget(changeEvent.target.value as crm.CaseStatus | "")}
          className={INPUT_CLASS}
        >
          <option value="">Choose…</option>
          {crm.CASE_STATUSES.map((caseStatus) => (
            <option key={caseStatus} value={caseStatus}>
              {CASE_STATUS_LABELS[caseStatus]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={isApplying || caseStatusTarget === ""}
        className={PRIMARY_BUTTON_CLASS}
        onClick={() => {
          if (caseStatusTarget === "") return;
          void runBulk("caseStatus", caseStatusTarget);
        }}
      >
        Apply status
      </button>

      <label className="flex flex-col gap-1">
        <span className={FIELD_LABEL_CLASS}>Set billing</span>
        <select
          aria-label="Bulk billing status"
          value={billingStatusTarget}
          disabled={isApplying}
          onChange={(changeEvent) =>
            setBillingStatusTarget(changeEvent.target.value as crm.BillingStatus | "")
          }
          className={INPUT_CLASS}
        >
          <option value="">Choose…</option>
          {crm.BILLING_STATUSES.map((billingStatus) => (
            <option key={billingStatus} value={billingStatus}>
              {BILLING_LABELS[billingStatus]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={isApplying || billingStatusTarget === ""}
        className={PRIMARY_BUTTON_CLASS}
        onClick={() => {
          if (billingStatusTarget === "") return;
          void runBulk("billingStatus", billingStatusTarget);
        }}
      >
        Apply billing
      </button>

      <button type="button" disabled={isApplying} className={SECONDARY_BUTTON_CLASS} onClick={onClearSelection}>
        Clear selection
      </button>

      {resultSummary !== null && (
        <p role="status" className="basis-full text-sm text-ink-soft">
          {resultSummary}
        </p>
      )}
    </div>
  );
}
