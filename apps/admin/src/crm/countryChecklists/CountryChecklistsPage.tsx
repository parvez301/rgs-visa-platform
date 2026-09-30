import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminShell } from "../../components/AdminShell";
import { ApiRequestError } from "../../lib/adminApi";
import { useAdminAccess } from "../../lib/adminAccess";
import { useAuth } from "../../lib/auth";
import { crmClient } from "../api/crmClient";
import {
  CARD_CLASS,
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";

const FIELD_CLASS = `${INPUT_CLASS} w-full`;

interface StoredChecklist {
  requiredDocuments: string[];
  notes?: string;
}

/**
 * CRM-owned required documents per destination country.
 * New cases stamp from these rows — not from portal Config docsRequired.
 *
 * Master-detail: destinations on the left, the selected country's checklist on
 * the right as removable chips plus an add field.
 */
export function CountryChecklistsPage() {
  const { idToken } = useAuth();

  const destinationsQuery = useQuery({
    queryKey: ["crm", "destination-countries"],
    queryFn: async () => (await crmClient.listDestinationCountries(idToken!)).countries,
    enabled: idToken !== null,
  });
  const checklistsQuery = useQuery({
    queryKey: ["crm", "country-checklists"],
    queryFn: async () => (await crmClient.listCountryChecklists(idToken!)).checklists,
    enabled: idToken !== null,
  });

  const checklistByCode = useMemo(() => {
    const map = new Map<string, StoredChecklist>();
    for (const checklist of checklistsQuery.data ?? []) {
      map.set(checklist.countryCode, {
        requiredDocuments: checklist.requiredDocuments,
        ...(checklist.notes !== undefined ? { notes: checklist.notes } : {}),
      });
    }
    return map;
  }, [checklistsQuery.data]);

  const [selectedCountryCode, setSelectedCountryCode] = useState<string | null>(null);
  const destinations = destinationsQuery.data ?? [];
  const selectedCountry = destinations.find((country) => country.countryCode === selectedCountryCode);

  return (
    <AdminShell contentWidth="wide">
      <div className="crm-root flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Doc checklists</h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            Required documents stamped onto new CRM cases for each destination.
          </p>
        </div>

        {(destinationsQuery.isError || checklistsQuery.isError) && (
          <p role="alert" className="text-sm text-rgs-red-deep">
            Could not load destinations or checklists.
          </p>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
          <section aria-label="Destinations" className={`${CARD_CLASS} overflow-hidden`}>
            {destinationsQuery.isLoading && <p className="px-4 py-3 text-sm text-ink-soft">Loading…</p>}
            <ul>
              {destinations.map((country) => {
                const documentCount = checklistByCode.get(country.countryCode)?.requiredDocuments.length ?? 0;
                const isActive = country.countryCode === selectedCountryCode;
                return (
                  <li
                    key={country.countryCode}
                    data-testid="checklist-country-row"
                    className="border-b border-line last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedCountryCode(country.countryCode)}
                      aria-current={isActive ? "true" : undefined}
                      className={`flex w-full items-center justify-between gap-2 border-l-4 px-4 py-2.5 text-left text-sm ${
                        isActive ? "border-rgs-red bg-mist" : "border-transparent hover:bg-mist/60"
                      }`}
                    >
                      <span className="font-medium text-ink">{country.countryName}</span>
                      <span className="text-xs text-ink-soft">
                        {documentCount === 0 ? "Not configured" : `${documentCount} docs`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selectedCountry !== undefined ? (
            <ChecklistEditor
              key={selectedCountry.countryCode}
              countryCode={selectedCountry.countryCode}
              countryName={selectedCountry.countryName}
              stored={checklistByCode.get(selectedCountry.countryCode)}
            />
          ) : (
            <section className={`${CARD_CLASS} px-6 py-10 text-center text-sm text-ink-soft`}>
              Select a country to edit its document checklist.
            </section>
          )}
        </div>
      </div>
    </AdminShell>
  );
}

interface ChecklistEditorProps {
  countryCode: string;
  countryName: string;
  stored: StoredChecklist | undefined;
}

function ChecklistEditor({ countryCode, countryName, stored }: ChecklistEditorProps) {
  const { idToken } = useAuth();
  const { canWrite } = useAdminAccess();
  const queryClient = useQueryClient();
  const canEdit = canWrite("crm");

  const [documents, setDocuments] = useState<string[]>(stored?.requiredDocuments ?? []);
  const [newDocument, setNewDocument] = useState("");
  const [notesText, setNotesText] = useState(stored?.notes ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  function addDocument() {
    const label = newDocument.trim();
    if (label === "") return;
    setFormError(null);
    setNewDocument("");
    // A repeated label would stamp the same case check twice.
    setDocuments((current) => (current.includes(label) ? current : [...current, label]));
  }

  function clearDocuments() {
    setDocuments([]);
  }

  function removeDocument(label: string) {
    setDocuments((current) => current.filter((document) => document !== label));
  }

  const saveMutation = useMutation({
    mutationFn() {
      const trimmedNotes = notesText.trim();
      return crmClient.putCountryChecklist(idToken!, countryCode, {
        requiredDocuments: documents,
        ...(trimmedNotes !== "" ? { notes: trimmedNotes } : {}),
      });
    },
    onSuccess: async () => {
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["crm", "country-checklists"] });
    },
    onError: (error: unknown) => {
      setFormError(error instanceof ApiRequestError ? error.message : "The change did not save. Try again.");
    },
  });

  function save() {
    setFormError(null);
    saveMutation.mutate();
  }

  return (
    <section aria-labelledby="country-checklist-title" className={`${CARD_CLASS} flex min-w-0 flex-col`}>
      <header className="border-b border-line px-6 py-5">
        <h2 id="country-checklist-title" className="text-xl font-bold text-ink">
          {countryName}
        </h2>
        <p className="mt-0.5 text-sm text-ink-soft">
          {canEdit ? "Each chip is one document stamped onto new cases." : "Documents stamped onto new cases."}
        </p>
      </header>

      <div className="flex flex-col gap-4 px-6 py-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className={FIELD_LABEL_CLASS}>Required documents</span>
            {canEdit && documents.length > 0 && (
              <button type="button" onClick={clearDocuments} className="text-xs text-ink-soft underline">
                Clear all
              </button>
            )}
          </div>
          {documents.length === 0 ? (
            <p className="text-sm text-ink-soft">No documents — this country is Not configured.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {documents.map((label) => (
                <li
                  key={label}
                  className="flex items-center gap-1.5 rounded-full border border-line bg-mist py-1 pl-3 pr-2 text-sm text-ink"
                >
                  <span data-testid="checklist-doc-chip">{label}</span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeDocument(label)}
                      aria-label={`Remove ${label}`}
                      className="rounded-full px-1.5 text-ink-soft hover:text-rgs-red-deep"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canEdit && (
          <>
            <div className="flex gap-2">
              <input
                aria-label="Add document"
                placeholder="Add a document, e.g. Passport bio page"
                value={newDocument}
                onChange={(changeEvent) => setNewDocument(changeEvent.target.value)}
                onKeyDown={(keyboardEvent) => {
                  if (keyboardEvent.key === "Enter") {
                    keyboardEvent.preventDefault();
                    addDocument();
                  }
                }}
                className={FIELD_CLASS}
              />
              <button type="button" onClick={addDocument} className={SECONDARY_BUTTON_CLASS}>
                Add
              </button>
            </div>

            <label className="flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Notes (optional)</span>
              <input
                value={notesText}
                onChange={(changeEvent) => setNotesText(changeEvent.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </>
        )}

        {formError !== null && (
          <p role="alert" className="text-sm text-rgs-red-deep">
            {formError}
          </p>
        )}
        {saveMutation.isSuccess && (
          <p role="status" className="text-sm text-ink-soft">
            Saved.
          </p>
        )}
      </div>

      {canEdit && (
        <footer className="flex justify-end border-t border-line px-6 py-4">
          <button type="button" disabled={saveMutation.isPending} onClick={save} className={PRIMARY_BUTTON_CLASS}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        </footer>
      )}
    </section>
  );
}
