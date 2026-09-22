import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { crmClient } from "../api/crmClient";
import { crmQueryKeys } from "../api/hooks";
import { CARD_CLASS, FIELD_LABEL_CLASS, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from "../components/controls";
import { DOCUMENT_CHECK_STATE_LABELS } from "../labels";

export interface DocumentChecklistSectionProps {
  caseRecord: crm.CrmCase;
}

/**
 * Destination document marks on this case. Empty checklists try once to pull
 * the country template; each row then moves Missing → Received → Verified.
 */
export function DocumentChecklistSection({ caseRecord }: DocumentChecklistSectionProps) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const ensureAttemptedForCaseIdRef = useRef<string | null>(null);

  const invalidateCase = () =>
    queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseRecord.caseId) });

  const ensureMutation = useMutation({
    mutationFn: () => crmClient.ensureDocumentChecklist(idToken!, caseRecord.caseId),
    onSuccess: async () => {
      setEnsureError(null);
      await invalidateCase();
      await queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseRecord.caseId) });
    },
    onError: (error: Error) => setEnsureError(error.message),
  });

  const setStateMutation = useMutation({
    mutationFn: (input: { label: string; state: crm.DocumentCheckState }) =>
      crmClient.setDocumentCheckState(idToken!, caseRecord.caseId, input.label, input.state),
    onSuccess: async () => {
      await invalidateCase();
      await queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseRecord.caseId) });
    },
  });

  useEffect(() => {
    if (caseRecord.documentChecklist.length > 0) return;
    if (idToken === null) return;
    if (ensureAttemptedForCaseIdRef.current === caseRecord.caseId) return;
    ensureAttemptedForCaseIdRef.current = caseRecord.caseId;
    ensureMutation.mutate();
    // Intentionally once per case id when the checklist is empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseRecord.caseId, caseRecord.documentChecklist.length, idToken]);

  return (
    <section className={`${CARD_CLASS} p-4`} data-testid="document-checklist">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Documents</h2>
        {caseRecord.documentChecklist.length === 0 && (
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            disabled={ensureMutation.isPending || idToken === null}
            onClick={() => {
              ensureAttemptedForCaseIdRef.current = null;
              ensureMutation.mutate();
            }}
          >
            Load country checklist
          </button>
        )}
      </div>

      {ensureError !== null && (
        <p role="alert" className="mb-2 text-sm text-rose-800">
          {ensureError}
        </p>
      )}

      {caseRecord.documentChecklist.length === 0 ? (
        <p className="text-sm text-ink-soft">
          {ensureMutation.isPending
            ? "Loading the country checklist…"
            : "No document checklist on this case. Load one from the destination country if it is on file."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {caseRecord.documentChecklist.map((documentCheck) => (
            <li
              key={documentCheck.label}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0"
            >
              <span className="font-medium text-ink">{documentCheck.label}</span>
              <label className="flex items-center gap-2 text-sm">
                <span className={FIELD_LABEL_CLASS}>Status</span>
                <select
                  aria-label={`${documentCheck.label} status`}
                  className={`${INPUT_CLASS} py-1`}
                  value={documentCheck.state}
                  disabled={setStateMutation.isPending || idToken === null}
                  onChange={(changeEvent) =>
                    setStateMutation.mutate({
                      label: documentCheck.label,
                      state: changeEvent.target.value as crm.DocumentCheckState,
                    })
                  }
                >
                  {crm.DOCUMENT_CHECK_STATES.map((state) => (
                    <option key={state} value={state}>
                      {DOCUMENT_CHECK_STATE_LABELS[state]}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
