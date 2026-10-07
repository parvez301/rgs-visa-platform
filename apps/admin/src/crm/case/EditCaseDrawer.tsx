import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { crmClient, type CaseView } from "../api/crmClient";
import { crmQueryKeys, usePartners } from "../api/hooks";
import { LEDGER_CACHE_KEY_PREFIX } from "../api/mutations";
import {
  COMPACT_BUTTON_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";
import { CASE_TYPE_LABELS, ENTRY_TYPE_LABELS, PROCESSING_LABELS, VISA_TYPE_LABELS } from "../labels";
import {
  buildCaseDetailsPatch,
  draftFromCase,
  planApplicantChanges,
  type ApplicantDraftRow,
  type CaseDraft,
} from "./caseEditDiff";

/** A full email address, TLD of 2+ characters. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FULL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FIELD_CLASS = `${INPUT_CLASS} w-full`;

interface EditCaseDrawerProps {
  caseRecord: CaseView;
  onClose(): void;
}

/**
 * Every field on a case, editable at any stage, from the case page. Status,
 * billing, custody and outcome are deliberately absent: each keeps its own
 * control and state machine.
 *
 * Saving sends only what changed, in a fixed order -- the case's own fields,
 * then applicant edits, then new applicants, then removals -- and stops at the
 * first refusal, telling the desk what already went through.
 */
export function EditCaseDrawer({ caseRecord, onClose }: EditCaseDrawerProps) {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const partnersQuery = usePartners();
  const countriesQuery = useQuery({
    queryKey: ["crm", "destination-countries"],
    queryFn: async () => {
      const response = await crmClient.listDestinationCountries(idToken!);
      return response.countries;
    },
    enabled: idToken !== null,
  });

  const originalDraft = useMemo(() => draftFromCase(caseRecord), [caseRecord]);
  const [caseDraft, setCaseDraft] = useState<CaseDraft>(() => draftFromCase(caseRecord));
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [partialSaveMessage, setPartialSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    function closeOnEscape(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const saveChangesMutation = useMutation({
    async mutationFn(): Promise<void> {
      const caseDetailsPatch = buildCaseDetailsPatch(originalDraft, caseDraft);
      const applicantPlan = planApplicantChanges(originalDraft, caseDraft);
      const completedSteps: string[] = [];
      const knownApplicantRefs = new Set(
        caseRecord.applicants.map((applicant) => applicant.applicantRef),
      );
      try {
        if (Object.keys(caseDetailsPatch).length > 0) {
          const updatedCase = await crmClient.updateCaseDetails(
            idToken!,
            caseRecord.caseId,
            caseDetailsPatch,
          );
          completedSteps.push("case details");
          const bookedAppointmentDate =
            typeof caseDetailsPatch.appointmentDate === "string" &&
            caseDetailsPatch.appointmentDate.length > 0
              ? caseDetailsPatch.appointmentDate
              : undefined;
          if (
            bookedAppointmentDate !== undefined &&
            updatedCase.caseStatus !== "APPOINTMENT_SET" &&
            crm.canTransitionCaseStatus(updatedCase.caseStatus, "APPOINTMENT_SET")
          ) {
            await crmClient.setCaseStatus(idToken!, caseRecord.caseId, "APPOINTMENT_SET");
            completedSteps.push("appointment status");
          }
        }
        for (const applicantUpdate of applicantPlan.updates) {
          await crmClient.updateApplicant(idToken!, caseRecord.caseId, applicantUpdate.applicantRef, applicantUpdate.body);
          completedSteps.push(`applicant ${applicantUpdate.applicantRef}`);
        }
        // Additions before removals: removing everyone first would hit the
        // "a case needs at least one applicant" refusal.
        for (const newApplicantRow of applicantPlan.additions) {
          const passportNumber = newApplicantRow.passportNumber.trim().toUpperCase() || undefined;
          const existingTraveller =
            passportNumber === undefined ? undefined : await crmClient.findTravellerByPassport(idToken!, passportNumber);
          const traveller =
            existingTraveller ??
            (await crmClient.upsertTraveller(idToken!, {
              fullName: newApplicantRow.fullName.trim(),
              ...(passportNumber === undefined ? {} : { passportNumber }),
            }));
          const refNo = newApplicantRow.refNo.trim();
          const caseWithNewApplicant = await crmClient.addApplicant(idToken!, caseRecord.caseId, {
            travellerId: traveller.travellerId,
            ...(passportNumber === undefined ? {} : { passportNumber }),
            ...(refNo === "" ? {} : { refNo }),
          });
          // The row is no longer "new": give it the ref the server assigned, so a
          // retry after a later step fails updates this person instead of adding them again.
          const addedApplicant = caseWithNewApplicant.applicants.find(
            (applicant) =>
              applicant.travellerId === traveller.travellerId && !knownApplicantRefs.has(applicant.applicantRef),
          );
          if (addedApplicant !== undefined) {
            knownApplicantRefs.add(addedApplicant.applicantRef);
            setCaseDraft((currentDraft) => ({
              ...currentDraft,
              applicants: currentDraft.applicants.map((applicantRow) =>
                applicantRow === newApplicantRow
                  ? { ...applicantRow, applicantRef: addedApplicant.applicantRef }
                  : applicantRow,
              ),
            }));
          }
          completedSteps.push(`new applicant ${newApplicantRow.fullName.trim()}`);
        }
        for (const removedApplicantRef of applicantPlan.removals) {
          await crmClient.removeApplicant(idToken!, caseRecord.caseId, removedApplicantRef);
          completedSteps.push(`removed ${removedApplicantRef}`);
        }
      } catch (error) {
        setPartialSaveMessage(completedSteps.length === 0 ? null : `Saved: ${completedSteps.join(", ")}.`);
        throw error;
      }
    },
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.case(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: crmQueryKeys.caseEvents(caseRecord.caseId) });
      void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
    },
    onSuccess() {
      onClose();
    },
  });

  function updateField<FieldName extends keyof Omit<CaseDraft, "applicants">>(
    fieldName: FieldName,
    value: CaseDraft[FieldName],
  ) {
    setCaseDraft((currentDraft) => ({ ...currentDraft, [fieldName]: value }));
  }

  function updateApplicant(applicantIndex: number, patch: Partial<ApplicantDraftRow>) {
    setCaseDraft((currentDraft) => ({
      ...currentDraft,
      applicants: currentDraft.applicants.map((applicantRow, index) =>
        index === applicantIndex ? { ...applicantRow, ...patch } : applicantRow,
      ),
    }));
  }

  function changeCaseType(nextCaseType: crm.CaseType) {
    setCaseDraft((currentDraft) => ({
      ...currentDraft,
      caseType: nextCaseType,
      // Visa type and entry type only exist on a visa case; leaving VISA clears them.
      ...(nextCaseType === "VISA" ? {} : { visaType: "" as const, entryType: "" as const }),
    }));
  }

  function describeValidationProblem(): string | null {
    if (caseDraft.caseRef.trim() === "") return "Give the case a REF.";
    if (caseDraft.partnerId === "") return "Choose the partner who sent this case.";
    if (caseDraft.destinationCountry === "") return "Choose the destination country.";
    if (caseDraft.caseType === "VISA" && caseDraft.visaType === "") return "Choose the visa type for a visa case.";
    if (!FULL_DATE_PATTERN.test(caseDraft.receivedDate)) return "Enter the received date as a full date.";
    if (caseDraft.submissionDate !== "" && !FULL_DATE_PATTERN.test(caseDraft.submissionDate)) {
      return "Enter the submission date as a full date.";
    }
    if (caseDraft.appointmentDate !== "" && !FULL_DATE_PATTERN.test(caseDraft.appointmentDate)) {
      return "Enter the appointment date as a full date.";
    }
    if (caseDraft.expectedCollectionDate !== "" && !FULL_DATE_PATTERN.test(caseDraft.expectedCollectionDate)) {
      return "Enter the collection date as a full date.";
    }
    if (caseDraft.expectedCollectionDate !== "" && caseDraft.expectedCollectionDate < caseDraft.receivedDate) {
      return "Collection date cannot be before the received date.";
    }
    const trimmedClientEmail = caseDraft.clientEmail.trim();
    if (trimmedClientEmail !== "" && !EMAIL_PATTERN.test(trimmedClientEmail)) {
      return "Enter the client email as a full address.";
    }
    const nameMissingIndex = caseDraft.applicants.findIndex((applicantRow) => applicantRow.fullName.trim() === "");
    if (nameMissingIndex !== -1) return `Applicant ${nameMissingIndex + 1} needs a name.`;
    return null;
  }

  function submit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const problem = describeValidationProblem();
    if (problem !== null) {
      setValidationMessage(problem);
      return;
    }
    const applicantPlan = planApplicantChanges(originalDraft, caseDraft);
    const nothingChanged =
      Object.keys(buildCaseDetailsPatch(originalDraft, caseDraft)).length === 0 &&
      applicantPlan.updates.length + applicantPlan.additions.length + applicantPlan.removals.length === 0;
    if (nothingChanged) {
      setValidationMessage("Nothing changed.");
      return;
    }
    setValidationMessage(null);
    setPartialSaveMessage(null);
    saveChangesMutation.mutate();
  }

  const isSubmitting = saveChangesMutation.isPending;
  const partnerKnown = (partnersQuery.data ?? []).some((partner) => partner.partnerId === caseDraft.partnerId);
  const countryKnown = (countriesQuery.data ?? []).some(
    (country) => country.countryCode === caseDraft.destinationCountry,
  );

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/30" onClick={onClose} aria-hidden="true" />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-case-title"
        onSubmit={submit}
        noValidate
        className="crm-root fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-paper shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h2 id="edit-case-title" className="text-xl font-bold text-ink">
              Edit case
            </h2>
            <p className="mt-0.5 text-sm text-ink-soft">
              Every field can be changed at any stage. Status, billing and custody keep their own controls on the case
              page.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={COMPACT_BUTTON_CLASS}>
            Close
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>REF</span>
              <input
                autoFocus
                value={caseDraft.caseRef}
                onChange={(changeEvent) => updateField("caseRef", changeEvent.target.value)}
                className={`${FIELD_CLASS} mrz`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Type</span>
              <select
                value={caseDraft.caseType}
                onChange={(changeEvent) => changeCaseType(changeEvent.target.value as crm.CaseType)}
                className={FIELD_CLASS}
              >
                {crm.CASE_TYPES.map((caseTypeOption) => (
                  <option key={caseTypeOption} value={caseTypeOption}>
                    {CASE_TYPE_LABELS[caseTypeOption]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Partner</span>
            <select
              value={caseDraft.partnerId}
              onChange={(changeEvent) => updateField("partnerId", changeEvent.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Choose a partner</option>
              {!partnerKnown && caseDraft.partnerId !== "" && (
                <option value={caseDraft.partnerId}>{caseDraft.partnerId}</option>
              )}
              {(partnersQuery.data ?? []).map((partner) => (
                <option key={partner.partnerId} value={partner.partnerId}>
                  {partner.canonicalName}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Destination</span>
              <select
                value={caseDraft.destinationCountry}
                onChange={(changeEvent) => updateField("destinationCountry", changeEvent.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">Choose a country</option>
                {!countryKnown && caseDraft.destinationCountry !== "" && (
                  <option value={caseDraft.destinationCountry}>{caseDraft.destinationCountry}</option>
                )}
                {(countriesQuery.data ?? []).map((country) => (
                  <option key={country.countryCode} value={country.countryCode}>
                    {country.countryName}
                  </option>
                ))}
              </select>
            </label>
            {caseDraft.caseType === "VISA" && (
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Visa type</span>
                <select
                  value={caseDraft.visaType}
                  onChange={(changeEvent) => updateField("visaType", changeEvent.target.value as crm.VisaType | "")}
                  className={FIELD_CLASS}
                >
                  <option value="">Not decided yet</option>
                  {crm.VISA_TYPES.map((visaTypeOption) => (
                    <option key={visaTypeOption} value={visaTypeOption}>
                      {VISA_TYPE_LABELS[visaTypeOption]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {caseDraft.caseType === "VISA" && (
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Entry type</span>
                <select
                  value={caseDraft.entryType}
                  onChange={(changeEvent) => updateField("entryType", changeEvent.target.value as crm.EntryType | "")}
                  className={FIELD_CLASS}
                >
                  <option value="">Not set</option>
                  {crm.ENTRY_TYPES.map((entryTypeOption) => (
                    <option key={entryTypeOption} value={entryTypeOption}>
                      {ENTRY_TYPE_LABELS[entryTypeOption]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Processing</span>
              <select
                value={caseDraft.processing}
                onChange={(changeEvent) => updateField("processing", changeEvent.target.value as crm.ProcessingSpeed | "")}
                className={FIELD_CLASS}
              >
                <option value="">Not set</option>
                {crm.PROCESSING_SPEEDS.map((processingOption) => (
                  <option key={processingOption} value={processingOption}>
                    {PROCESSING_LABELS[processingOption]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Received</span>
              <input
                type="date"
                value={caseDraft.receivedDate}
                onChange={(changeEvent) => updateField("receivedDate", changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Submission date</span>
              <input
                type="date"
                value={caseDraft.submissionDate}
                onChange={(changeEvent) => updateField("submissionDate", changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Appointment date</span>
              <input
                type="date"
                value={caseDraft.appointmentDate}
                onChange={(changeEvent) => updateField("appointmentDate", changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Collection date</span>
              <input
                type="date"
                value={caseDraft.expectedCollectionDate}
                onChange={(changeEvent) => updateField("expectedCollectionDate", changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL_CLASS}>Remarks</span>
            <textarea
              value={caseDraft.remarks}
              onChange={(changeEvent) => updateField("remarks", changeEvent.target.value)}
              rows={3}
              placeholder="Optional"
              className={FIELD_CLASS}
            />
          </label>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold text-ink">Group &amp; client</legend>
            <p className="text-xs text-ink-soft">
              Optional. One name over every applicant, and the address status updates go to.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Group name</span>
                <input
                  value={caseDraft.groupName}
                  onChange={(changeEvent) => updateField("groupName", changeEvent.target.value)}
                  placeholder="e.g. Sharma Family"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Client email</span>
                <input
                  type="email"
                  value={caseDraft.clientEmail}
                  onChange={(changeEvent) => updateField("clientEmail", changeEvent.target.value)}
                  placeholder="name@example.com"
                  className={FIELD_CLASS}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold text-ink">Applicants</legend>
            <p className="text-xs text-ink-soft">A name change applies to this person on every case they are on.</p>
            {caseDraft.applicants.map((applicantRow, applicantIndex) => (
              <div
                key={applicantRow.applicantRef ?? `new-${applicantIndex}`}
                className="flex flex-col gap-3 rounded-xl border border-line bg-mist/50 p-3"
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL_CLASS}>Applicant {applicantIndex + 1} name</span>
                    <input
                      value={applicantRow.fullName}
                      onChange={(changeEvent) => updateApplicant(applicantIndex, { fullName: changeEvent.target.value })}
                      placeholder="As printed in the passport"
                      className={FIELD_CLASS}
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      type="button"
                      disabled={caseDraft.applicants.length === 1}
                      aria-label={`Remove applicant ${applicantIndex + 1}`}
                      onClick={() =>
                        setCaseDraft((currentDraft) => ({
                          ...currentDraft,
                          applicants: currentDraft.applicants.filter((_, index) => index !== applicantIndex),
                        }))
                      }
                      className={COMPACT_BUTTON_CLASS}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL_CLASS}>Passport</span>
                    <input
                      value={applicantRow.passportNumber}
                      onChange={(changeEvent) =>
                        updateApplicant(applicantIndex, { passportNumber: changeEvent.target.value })
                      }
                      placeholder="Optional"
                      className={`${FIELD_CLASS} mrz`}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL_CLASS}>Applicant {applicantIndex + 1} REF NO</span>
                    <input
                      value={applicantRow.refNo}
                      onChange={(changeEvent) => updateApplicant(applicantIndex, { refNo: changeEvent.target.value })}
                      placeholder="Optional, this person's own REF"
                      className={`${FIELD_CLASS} mrz`}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setCaseDraft((currentDraft) => ({
                  ...currentDraft,
                  applicants: [...currentDraft.applicants, { fullName: "", passportNumber: "", refNo: "" }],
                }))
              }
              className={`${COMPACT_BUTTON_CLASS} self-start border-dashed`}
            >
              Add another applicant
            </button>
          </fieldset>
        </div>

        <footer className="flex flex-col gap-3 border-t border-line px-6 py-4">
          {validationMessage !== null && (
            <p role="alert" className="text-sm text-rgs-red-deep">
              {validationMessage}
            </p>
          )}
          {saveChangesMutation.isError && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              <p>Not saved: {saveChangesMutation.error.message}</p>
              {partialSaveMessage !== null && <p>{partialSaveMessage}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className={PRIMARY_BUTTON_CLASS}>
              {isSubmitting ? "Saving…" : "Save changes"}
            </button>
          </div>
        </footer>
      </form>
    </>
  );
}
