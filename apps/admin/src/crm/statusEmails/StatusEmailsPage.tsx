import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { crm } from "@rgs/shared";
import { AdminShell } from "../../components/AdminShell";
import { ApiRequestError } from "../../lib/adminApi";
import { useAdminAccess } from "../../lib/adminAccess";
import { useAuth } from "../../lib/auth";
import { crmClient } from "../api/crmClient";
import { crmQueryKeys } from "../api/hooks";
import {
  CARD_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";
import { CASE_STATUS_LABELS } from "../labels";
import { renderStatusEmailPreview, STATUS_EMAIL_PLACEHOLDERS } from "./previewRender";

const FIELD_CLASS = `${INPUT_CLASS} w-full`;
const SUBJECT_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 8000;

function describeFailure(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "The change did not save. Try again.";
}

/**
 * Every case status's client email, editable. A status without a stored row
 * shows the built-in default (the API reports it with `updatedBy: ""`).
 * Editing and resetting need write access to the CRM; everyone with CRM
 * access can read and preview.
 */
export function StatusEmailsPage() {
  const { idToken } = useAuth();
  const templatesQuery = useQuery({
    queryKey: crmQueryKeys.statusEmailTemplates(),
    queryFn: () => crmClient.listStatusEmailTemplates(idToken!),
    enabled: idToken !== null,
  });
  const [openCaseStatus, setOpenCaseStatus] = useState<crm.CaseStatus | null>(null);
  const templates = templatesQuery.data?.templates ?? [];
  const openTemplate = templates.find((template) => template.caseStatus === openCaseStatus);

  return (
    <AdminShell contentWidth="wide">
      <div className="crm-root flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold">Status emails</h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            The email a client receives when their case moves to each status.
          </p>
        </div>

        {templatesQuery.isError && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
            The status emails could not be loaded: {String(templatesQuery.error)}
          </p>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <section aria-label="Statuses" className={`${CARD_CLASS} overflow-hidden`}>
            {templatesQuery.isLoading && <p className="px-4 py-3 text-sm text-ink-soft">Loading…</p>}
            <ul>
              {templates.map((template) => {
                const isActive = template.caseStatus === openCaseStatus;
                return (
                  <li
                    key={template.caseStatus}
                    data-testid="status-email-row"
                    className="border-b border-line last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenCaseStatus(template.caseStatus)}
                      aria-label={`Open ${CASE_STATUS_LABELS[template.caseStatus]}`}
                      aria-current={isActive ? "true" : undefined}
                      className={`flex w-full flex-col gap-0.5 border-l-4 px-4 py-2.5 text-left text-sm ${
                        isActive ? "border-rgs-red bg-mist" : "border-transparent hover:bg-mist/60"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium text-ink">{CASE_STATUS_LABELS[template.caseStatus]}</span>
                        <span className={`text-xs ${template.enabled ? "text-ink" : "text-ink-soft"}`}>
                          {template.enabled ? "On" : "Off"}
                        </span>
                      </span>
                      <span className="truncate text-xs text-ink-soft">{template.subject}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {openTemplate !== undefined ? (
            <StatusEmailEditor key={openTemplate.caseStatus} template={openTemplate} />
          ) : (
            <section className={`${CARD_CLASS} px-6 py-10 text-center text-sm text-ink-soft`}>
              Select a status to edit its email.
            </section>
          )}
        </div>
      </div>
    </AdminShell>
  );
}

interface StatusEmailEditorProps {
  template: crm.StatusEmailTemplate;
}

function StatusEmailEditor({ template }: StatusEmailEditorProps) {
  const { idToken } = useAuth();
  const { canWrite } = useAdminAccess();
  const canWriteCrm = canWrite("crm");
  const queryClient = useQueryClient();

  const [subjectDraft, setSubjectDraft] = useState(template.subject);
  const [bodyDraft, setBodyDraft] = useState(template.body);
  const [enabledDraft, setEnabledDraft] = useState(template.enabled);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  function refreshTemplates() {
    void queryClient.invalidateQueries({ queryKey: crmQueryKeys.statusEmailTemplates() });
  }

  const saveTemplateMutation = useMutation({
    mutationFn: (body: crm.UpsertStatusEmailTemplateBody) =>
      crmClient.putStatusEmailTemplate(idToken!, template.caseStatus, body),
    onSuccess() {
      setValidationMessage(null);
      refreshTemplates();
    },
  });

  const resetTemplateMutation = useMutation({
    mutationFn: () => crmClient.resetStatusEmailTemplate(idToken!, template.caseStatus),
    onSuccess(resetTemplate) {
      saveTemplateMutation.reset();
      setSubjectDraft(resetTemplate.subject);
      setBodyDraft(resetTemplate.body);
      setEnabledDraft(resetTemplate.enabled);
      refreshTemplates();
    },
  });

  function submit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!canWriteCrm) return;
    const trimmedSubject = subjectDraft.trim();
    const trimmedBody = bodyDraft.trim();
    if (trimmedSubject === "") return setValidationMessage("Give the email a subject.");
    if (trimmedBody === "") return setValidationMessage("Give the email a body.");
    if (trimmedSubject.length > SUBJECT_MAX_LENGTH) {
      return setValidationMessage(`The subject can be at most ${SUBJECT_MAX_LENGTH} characters.`);
    }
    if (trimmedBody.length > BODY_MAX_LENGTH) {
      return setValidationMessage(`The body can be at most ${BODY_MAX_LENGTH} characters.`);
    }
    setValidationMessage(null);
    resetTemplateMutation.reset();
    saveTemplateMutation.mutate({ subject: trimmedSubject, body: trimmedBody, enabled: enabledDraft });
  }

  const isBusy = saveTemplateMutation.isPending || resetTemplateMutation.isPending;
  const mutationError = saveTemplateMutation.error ?? resetTemplateMutation.error;
  const statusLabel = CASE_STATUS_LABELS[template.caseStatus];

  return (
    <form
      aria-labelledby="status-email-title"
      onSubmit={submit}
      noValidate
      className={`${CARD_CLASS} flex min-w-0 flex-col`}
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h2 id="status-email-title" className="text-xl font-bold text-ink">
            {statusLabel}
          </h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            {template.updatedBy === ""
              ? "Using the built-in default."
              : `Last edited by ${template.updatedBy}.`}
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-5 px-6 py-5">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabledDraft}
            disabled={!canWriteCrm}
            onChange={(changeEvent) => setEnabledDraft(changeEvent.target.checked)}
          />
          Send this email when a case reaches this status
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Subject</span>
          <input
            value={subjectDraft}
            readOnly={!canWriteCrm}
            onChange={(changeEvent) => setSubjectDraft(changeEvent.target.value)}
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Body</span>
          <textarea
            value={bodyDraft}
            readOnly={!canWriteCrm}
            onChange={(changeEvent) => setBodyDraft(changeEvent.target.value)}
            rows={12}
            className={`${FIELD_CLASS} font-mono`}
          />
        </label>

        <section aria-label="Placeholders" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">Placeholders</h3>
          <p className="text-xs text-ink-soft">
            Use these in the subject or body. A line whose placeholders are all empty is left out of the email.
          </p>
          <ul className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {STATUS_EMAIL_PLACEHOLDERS.map((placeholder) => (
              <li key={placeholder.name} className="flex items-baseline gap-2">
                <code className="mrz text-ink">{`{{${placeholder.name}}}`}</code>
                <span className="text-ink-soft">
                  {placeholder.description}
                  {placeholder.omittedFromMail && " — not captured yet, so this line is left out"}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Preview" className={`${CARD_CLASS} flex flex-col gap-2 bg-mist p-4`}>
          <h3 className="text-sm font-semibold text-ink">Preview</h3>
          <p className="text-xs text-ink-soft">With sample values.</p>
          <p data-testid="status-email-preview-subject" className="text-sm font-semibold text-ink">
            {renderStatusEmailPreview(subjectDraft)}
          </p>
          <pre
            data-testid="status-email-preview-body"
            className="whitespace-pre-wrap font-sans text-sm text-ink"
          >
            {renderStatusEmailPreview(bodyDraft)}
          </pre>
        </section>

        {validationMessage !== null && (
          <p role="alert" className="text-sm text-rgs-red-deep">
            {validationMessage}
          </p>
        )}
        {mutationError !== null && (
          <p role="alert" className="text-sm text-rgs-red-deep">
            {describeFailure(mutationError)}
          </p>
        )}
        {saveTemplateMutation.isSuccess && (
          <p role="status" className="text-sm text-ink-soft">
            Saved.
          </p>
        )}
      </div>

      {canWriteCrm && (
        <footer className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => resetTemplateMutation.mutate()}
            className={SECONDARY_BUTTON_CLASS}
          >
            Reset to default
          </button>
          <button type="submit" disabled={isBusy} className={PRIMARY_BUTTON_CLASS}>
            {saveTemplateMutation.isPending ? "Saving…" : "Save"}
          </button>
        </footer>
      )}
    </form>
  );
}
