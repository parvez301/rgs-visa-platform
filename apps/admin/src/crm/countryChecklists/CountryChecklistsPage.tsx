import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { useAdminAccess } from "../../lib/adminAccess";
import { crmClient } from "../api/crmClient";
import {
  FIELD_LABEL_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/controls";

const FIELD_CLASS = `${INPUT_CLASS} w-full`;

/**
 * CRM-owned required documents per destination country.
 * New cases stamp from these rows — not from portal Config docsRequired.
 */
export function CountryChecklistsPage() {
  const { idToken } = useAuth();
  const { canWrite } = useAdminAccess();
  const queryClient = useQueryClient();
  const canEdit = canWrite("crm");

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
    const map = new Map<string, { requiredDocuments: string[]; notes?: string }>();
    for (const checklist of checklistsQuery.data ?? []) {
      map.set(checklist.countryCode, {
        requiredDocuments: checklist.requiredDocuments,
        ...(checklist.notes !== undefined ? { notes: checklist.notes } : {}),
      });
    }
    return map;
  }, [checklistsQuery.data]);

  const [selectedCountryCode, setSelectedCountryCode] = useState<string | null>(null);
  const [documentsText, setDocumentsText] = useState("");
  const [notesText, setNotesText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const selectedCountryName =
    destinationsQuery.data?.find((country) => country.countryCode === selectedCountryCode)?.countryName ??
    selectedCountryCode;

  function openEditor(countryCode: string) {
    const stored = checklistByCode.get(countryCode);
    setSelectedCountryCode(countryCode);
    setDocumentsText((stored?.requiredDocuments ?? []).join("\n"));
    setNotesText(stored?.notes ?? "");
    setFormError(null);
  }

  const saveMutation = useMutation({
    async mutationFn() {
      if (selectedCountryCode === null) throw new Error("No country selected");
      const requiredDocuments = documentsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (requiredDocuments.length === 0) {
        throw new Error("Add at least one document (one per line).");
      }
      const trimmedNotes = notesText.trim();
      return crmClient.putCountryChecklist(idToken!, selectedCountryCode, {
        requiredDocuments,
        ...(trimmedNotes !== "" ? { notes: trimmedNotes } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["crm", "country-checklists"] });
      setSelectedCountryCode(null);
      setFormError(null);
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Country document checklists</h1>
          <p className="text-sm text-ink-soft">
            Required documents stamped onto new CRM cases for each destination.
          </p>
        </div>
        <Link to="/crm" className={SECONDARY_BUTTON_CLASS}>
          Back to Ledger
        </Link>
      </div>

      {(destinationsQuery.isError || checklistsQuery.isError) && (
        <p role="alert" className="text-sm text-rgs-red-deep">
          Could not load destinations or checklists.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-line bg-surface-soft text-xs uppercase tracking-wide text-ink-soft">
            <tr>
              <th className="px-3 py-2">Country</th>
              <th className="px-3 py-2">Documents</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(destinationsQuery.data ?? []).map((country) => {
              const documents = checklistByCode.get(country.countryCode)?.requiredDocuments ?? [];
              return (
                <tr key={country.countryCode} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium text-ink">{country.countryName}</td>
                  <td className="px-3 py-2 text-ink-soft">
                    {documents.length === 0 ? "Not configured" : documents.join(", ")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON_CLASS}
                      onClick={() => openEditor(country.countryCode)}
                    >
                      {canEdit ? "Edit" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedCountryCode !== null && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-4 sm:items-center">
          <div
            role="dialog"
            aria-labelledby="country-checklist-title"
            className="w-full max-w-lg rounded-lg bg-surface p-5 shadow-lg"
          >
            <h2 id="country-checklist-title" className="text-lg font-semibold text-ink">
              {selectedCountryName}
            </h2>
            <p className="mt-1 text-xs text-ink-soft">One document label per line.</p>
            <label className="mt-4 flex flex-col gap-1">
              <span className={FIELD_LABEL_CLASS}>Required documents</span>
              <textarea
                value={documentsText}
                onChange={(changeEvent) => setDocumentsText(changeEvent.target.value)}
                rows={8}
                readOnly={!canEdit}
                className={FIELD_CLASS}
              />
            </label>
            {canEdit && (
              <label className="mt-3 flex flex-col gap-1">
                <span className={FIELD_LABEL_CLASS}>Notes (optional)</span>
                <input
                  value={notesText}
                  onChange={(changeEvent) => setNotesText(changeEvent.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            )}
            {formError !== null && (
              <p role="alert" className="mt-2 text-sm text-rgs-red-deep">
                {formError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => setSelectedCountryCode(null)}
              >
                Close
              </button>
              {canEdit && (
                <button
                  type="button"
                  className={PRIMARY_BUTTON_CLASS}
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
