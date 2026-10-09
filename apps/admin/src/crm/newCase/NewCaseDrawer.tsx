import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { crm } from "@rgs/shared";
import { useAuth } from "../../lib/auth";
import { crmClient, type CreateCaseInput } from "../api/crmClient";
import { crmQueryKeys, usePartners } from "../api/hooks";
import { LEDGER_CACHE_KEY_PREFIX } from "../api/mutations";
import {
  COMPACT_BUTTON_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";
import { CASE_TYPE_LABELS, ENTRY_TYPE_LABELS, VISA_TYPE_LABELS } from "../labels";

/** The `<select>` value that means "type a partner the ledger has not seen". */
const NEW_PARTNER_CHOICE = "__new_partner__";

/** A full email address, TLD of 2+ characters -- shared by every email field this drawer validates. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface ApplicantDraft {
  fullName: string;
  passportNumber: string;
  refNo: string;
}

const EMPTY_APPLICANT: ApplicantDraft = { fullName: "", passportNumber: "", refNo: "" };

/** Today in the desk's own calendar, not UTC's -- a case received at 1am IST is received today. */
function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const FIELD_CLASS = `${INPUT_CLASS} w-full`;

interface NewCaseDrawerProps {
  onClose(): void;
}

/**
 * The one way to open a case by hand. It runs the same four server calls a
 * desk agent would otherwise make in order -- partner, traveller per
 * applicant, then the case -- and lands on the new case's page.
 *
 * Passport numbers are the traveller key: an applicant whose passport is
 * already on file is attached to that traveller rather than duplicated.
 */
export function NewCaseDrawer({ onClose }: NewCaseDrawerProps) {
  const { idToken } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const partnersQuery = usePartners();
  const [caseRef, setCaseRef] = useState("");
  const [caseType, setCaseType] = useState<crm.CaseType>("VISA");
  const [partnerChoice, setPartnerChoice] = useState("");
  const [newPartnerName, setNewPartnerName] = useState("");
  const [newPartnerEmail, setNewPartnerEmail] = useState("");
  const [destinationCountry, setDestinationCountry] = useState("");
  const [visaType, setVisaType] = useState<crm.VisaType | "">("");
  const [entryType, setEntryType] = useState<crm.EntryType | "">("");
  const [receivedDate, setReceivedDate] = useState(todayIsoDate);
  const [submissionDate, setSubmissionDate] = useState("");
  const [expectedCollectionDate, setExpectedCollectionDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [groupName, setGroupName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [applicantDrafts, setApplicantDrafts] = useState<ApplicantDraft[]>([EMPTY_APPLICANT]);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  const countriesQuery = useQuery({
    queryKey: ["crm", "destination-countries"],
    queryFn: async () => {
      const response = await crmClient.listDestinationCountries(idToken!);
      return response.countries;
    },
    enabled: idToken !== null,
  });
  // The picker's own payload carries the stamp, so the preview needs no second
  // request — and in particular not the Config catalog route, which Ops and
  // Finance are not allowed to open.
  const previewLabels =
    (countriesQuery.data ?? []).find((country) => country.countryCode === destinationCountry)
      ?.requiredDocuments ?? [];

  useEffect(() => {
    function closeOnEscape(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const createCaseMutation = useMutation({
    async mutationFn(): Promise<crm.CrmCase> {
      const partnerId =
        partnerChoice === NEW_PARTNER_CHOICE
          ? (
              await crmClient.createPartner(idToken!, {
                canonicalName: newPartnerName.trim(),
                ...(newPartnerEmail.trim() !== "" ? { contactEmail: newPartnerEmail.trim() } : {}),
              })
            ).partnerId
          : partnerChoice;

      const applicants: CreateCaseInput["applicants"] = [];
      for (const [applicantIndex, applicantDraft] of applicantDrafts.entries()) {
        const passportNumber = applicantDraft.passportNumber.trim().toUpperCase() || undefined;
        const existingTraveller =
          passportNumber === undefined
            ? undefined
            : await crmClient.findTravellerByPassport(idToken!, passportNumber);
        const traveller =
          existingTraveller ??
          (await crmClient.upsertTraveller(idToken!, {
            fullName: applicantDraft.fullName.trim(),
            ...(passportNumber === undefined ? {} : { passportNumber }),
          }));
        const refNo = applicantDraft.refNo.trim();
        applicants.push({
          applicantRef: `A${applicantIndex + 1}`,
          travellerId: traveller.travellerId,
          ...(passportNumber === undefined ? {} : { passportNumber }),
          ...(refNo === "" ? {} : { refNo }),
        });
      }

      const trimmedRemarks = remarks.trim();
      return crmClient.createCase(idToken!, {
        caseRef: caseRef.trim(),
        caseType,
        partnerId,
        destinationCountry,
        ...(caseType === "VISA" && visaType !== "" ? { visaType } : {}),
        ...(caseType === "VISA" && entryType !== "" ? { entryType } : {}),
        receivedDate,
        ...(submissionDate !== "" ? { submissionDate } : {}),
        ...(expectedCollectionDate !== "" ? { expectedCollectionDate } : {}),
        ...(trimmedRemarks !== "" ? { remarks: trimmedRemarks } : {}),
        ...(groupName.trim() !== "" ? { groupName: groupName.trim() } : {}),
        ...(clientEmail.trim() !== "" ? { clientEmail: clientEmail.trim() } : {}),
        applicants,
      });
    },
    onSuccess(createdCase) {
      void queryClient.invalidateQueries({ queryKey: LEDGER_CACHE_KEY_PREFIX });
      if (partnerChoice === NEW_PARTNER_CHOICE) {
        void queryClient.invalidateQueries({ queryKey: crmQueryKeys.partners() });
      }
      onClose();
      void navigate(`/crm/cases/${encodeURIComponent(createdCase.caseId)}`);
    },
  });

  function describeValidationProblem(): string | null {
    if (caseRef.trim() === "") return "Give the case a REF.";
    if (partnerChoice === "") return "Choose the partner who sent this case.";
    if (partnerChoice === NEW_PARTNER_CHOICE && newPartnerName.trim() === "") {
      return "Type the new partner's name.";
    }
    const trimmedNewPartnerEmail = newPartnerEmail.trim();
    if (
      partnerChoice === NEW_PARTNER_CHOICE &&
      trimmedNewPartnerEmail !== "" &&
      !EMAIL_PATTERN.test(trimmedNewPartnerEmail)
    ) {
      return "Enter the partner email as a full address.";
    }
    if (destinationCountry === "") return "Choose the destination country.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) return "Enter the received date as a full date.";
    if (submissionDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(submissionDate)) {
      return "Enter the online submission date as a full date.";
    }
    if (expectedCollectionDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(expectedCollectionDate)) {
      return "Enter the collection date as a full date.";
    }
    if (expectedCollectionDate !== "" && expectedCollectionDate < receivedDate) {
      return "Collection date cannot be before the received date.";
    }
    const trimmedClientEmail = clientEmail.trim();
    if (trimmedClientEmail !== "" && !EMAIL_PATTERN.test(trimmedClientEmail)) {
      return "Enter the client email as a full address.";
    }
    const nameMissingIndex = applicantDrafts.findIndex((applicantDraft) => applicantDraft.fullName.trim() === "");
    if (nameMissingIndex !== -1) return `Applicant ${nameMissingIndex + 1} needs a name.`;
    return null;
  }

  function submit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const problem = describeValidationProblem();
    setValidationMessage(problem);
    if (problem === null) createCaseMutation.mutate();
  }

  function updateApplicant(applicantIndex: number, patch: Partial<ApplicantDraft>) {
    setApplicantDrafts((currentDrafts) =>
      currentDrafts.map((applicantDraft, index) =>
        index === applicantIndex ? { ...applicantDraft, ...patch } : applicantDraft,
      ),
    );
  }

  const isSubmitting = createCaseMutation.isPending;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/30" onClick={onClose} aria-hidden="true" />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-case-title"
        onSubmit={submit}
        noValidate
        className="crm-root fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-paper shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h2 id="new-case-title" className="text-xl font-bold text-ink">
              New case
            </h2>
            <p className="mt-0.5 text-sm text-ink-soft">
              Opens as New and Unbilled. Everything else can be edited on the case afterwards.
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
                value={caseRef}
                onChange={(changeEvent) => setCaseRef(changeEvent.target.value)}
                placeholder="e.g. RGS-2026-0912"
                className={`${FIELD_CLASS} mrz`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Type</span>
              <select
                value={caseType}
                onChange={(changeEvent) => setCaseType(changeEvent.target.value as crm.CaseType)}
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
              value={partnerChoice}
              onChange={(changeEvent) => setPartnerChoice(changeEvent.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Choose a partner</option>
              {(partnersQuery.data ?? []).map((partner) => (
                <option key={partner.partnerId} value={partner.partnerId}>
                  {partner.canonicalName}
                </option>
              ))}
              <option value={NEW_PARTNER_CHOICE}>Add a new partner…</option>
            </select>
          </label>
          {partnerChoice === NEW_PARTNER_CHOICE && (
            <>
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>New partner name</span>
                <input
                  value={newPartnerName}
                  onChange={(changeEvent) => setNewPartnerName(changeEvent.target.value)}
                  placeholder="Agency or walk-in name"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Partner email (optional)</span>
                <input
                  type="email"
                  value={newPartnerEmail}
                  onChange={(changeEvent) => setNewPartnerEmail(changeEvent.target.value)}
                  placeholder="For status updates"
                  className={FIELD_CLASS}
                />
              </label>
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Destination</span>
              <select
                value={destinationCountry}
                onChange={(changeEvent) => setDestinationCountry(changeEvent.target.value)}
                className={FIELD_CLASS}
              >
                <option value="">Choose a country</option>
                {(countriesQuery.data ?? []).map((country) => (
                  <option key={country.countryCode} value={country.countryCode}>
                    {country.countryName}
                  </option>
                ))}
              </select>
            </label>
            {destinationCountry !== "" && (
              <div className="sm:col-span-2 rounded-md border border-line bg-mist/50 px-3 py-2 text-sm text-ink">
                <p className={FIELD_LABEL_CLASS}>Documents stamped on this case</p>
                {previewLabels.length === 0 ? (
                  <p className="text-ink-soft">
                    No documents are configured for this country yet, so none will be stamped on the
                    case. Ask an admin to set the checklist.
                  </p>
                ) : (
                  <ul className="mt-1 list-disc pl-5">
                    {previewLabels.map((documentLabel) => (
                      <li key={documentLabel}>{documentLabel}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {caseType === "VISA" && (
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Visa type</span>
                <select
                  value={visaType}
                  onChange={(changeEvent) => setVisaType(changeEvent.target.value as crm.VisaType | "")}
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
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Received</span>
              <input
                type="date"
                value={receivedDate}
                onChange={(changeEvent) => setReceivedDate(changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Online submission date</span>
              <input
                type="date"
                value={submissionDate}
                onChange={(changeEvent) => setSubmissionDate(changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Collection date</span>
              <input
                type="date"
                value={expectedCollectionDate}
                onChange={(changeEvent) => setExpectedCollectionDate(changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </div>

          {caseType === "VISA" && (
            <label className="flex flex-col gap-1 sm:w-1/2">
              <span className={FIELD_LABEL_CLASS}>Entry type</span>
              <select
                value={entryType}
                onChange={(changeEvent) => setEntryType(changeEvent.target.value as crm.EntryType | "")}
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
            <span className={FIELD_LABEL_CLASS}>Remarks</span>
            <textarea
              value={remarks}
              onChange={(changeEvent) => setRemarks(changeEvent.target.value)}
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
                  value={groupName}
                  onChange={(changeEvent) => setGroupName(changeEvent.target.value)}
                  placeholder="e.g. Sharma Family"
                  className={FIELD_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Client email</span>
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(changeEvent) => setClientEmail(changeEvent.target.value)}
                  placeholder="name@example.com"
                  className={FIELD_CLASS}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold text-ink">Applicants</legend>
            {applicantDrafts.map((applicantDraft, applicantIndex) => (
              <div key={applicantIndex} className="flex flex-col gap-3 rounded-xl border border-line bg-mist/50 p-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <label className="flex flex-col gap-1">
                    <span className={FIELD_LABEL_CLASS}>Applicant {applicantIndex + 1} name</span>
                    <input
                      value={applicantDraft.fullName}
                      onChange={(changeEvent) => updateApplicant(applicantIndex, { fullName: changeEvent.target.value })}
                      placeholder="As printed in the passport"
                      className={FIELD_CLASS}
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      type="button"
                      disabled={applicantDrafts.length === 1}
                      aria-label={`Remove applicant ${applicantIndex + 1}`}
                      onClick={() =>
                        setApplicantDrafts((currentDrafts) => currentDrafts.filter((_, index) => index !== applicantIndex))
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
                      value={applicantDraft.passportNumber}
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
                      value={applicantDraft.refNo}
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
              onClick={() => setApplicantDrafts((currentDrafts) => [...currentDrafts, EMPTY_APPLICANT])}
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
          {createCaseMutation.isError && (
            <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              The case was not created: {createCaseMutation.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className={PRIMARY_BUTTON_CLASS}>
              {isSubmitting ? "Creating…" : "Create case"}
            </button>
          </div>
        </footer>
      </form>
    </>
  );
}
