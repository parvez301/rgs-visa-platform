import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DOC_TYPES, type CountryProduct, type DocType } from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

const DOC_TYPE_LABELS: Record<DocType, string> = {
  PASSPORT_BIO: "Passport bio page",
  PHOTO: "Passport-size photo",
  BANK_STATEMENT: "Bank statements",
  FLIGHT_ITINERARY: "Flight itinerary",
  HOTEL_BOOKING: "Hotel booking",
  YELLOW_FEVER_CERT: "Yellow fever cert",
  ITR: "ITR",
  EMPLOYMENT_PROOF: "Employment proof",
  COVER_LETTER: "Cover letter",
};

function parsePositiveInt(rawValue: string, fieldLabel: string): number | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  // reject floats that parseInt truncates silently if user typed decimals with trailing junk
  if (String(parsed) !== trimmed && !trimmed.match(/^\d+$/)) {
    void fieldLabel;
    return null;
  }
  return parsed;
}

export function ConfigPage() {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [editingProduct, setEditingProduct] = useState<CountryProduct | null>(null);
  const [hasSuccessfulPut, setHasSuccessfulPut] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const countriesQuery = useQuery({
    queryKey: ["admin-countries"],
    queryFn: () => adminApi.listCountries(idToken!),
    enabled: idToken !== null,
  });

  const products = countriesQuery.data ?? [];
  const showSeedButton = !hasSuccessfulPut;

  const putMutation = useMutation({
    mutationFn: (countryProduct: CountryProduct) =>
      adminApi.putCountry(idToken!, countryProduct),
    onSuccess: () => {
      setHasSuccessfulPut(true);
      setEditingProduct(null);
      setToastMessage("Live immediately for new applications");
      void queryClient.invalidateQueries({ queryKey: ["admin-countries"] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : "Save failed"),
  });

  const seedMutation = useMutation({
    mutationFn: () => adminApi.seedCountries(idToken!),
    onSuccess: (result) => {
      setToastMessage(`Seeded ${result.seededCount} country products`);
      void queryClient.invalidateQueries({ queryKey: ["admin-countries"] });
    },
  });

  useEffect(() => {
    if (!toastMessage) return;
    const timeoutId = window.setTimeout(() => setToastMessage(null), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  return (
    <AdminShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Country config</h1>
          <p className="mt-1 text-ink-soft">Fees, timelines, and required documents.</p>
        </div>
        {showSeedButton && (
          <button
            type="button"
            disabled={seedMutation.isPending}
            onClick={() => seedMutation.mutate()}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:border-ink transition-colors disabled:opacity-60"
          >
            Seed catalog
          </button>
        )}
      </div>

      {toastMessage && (
        <p className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {toastMessage}
        </p>
      )}

      {countriesQuery.isLoading ? (
        <p className="text-ink-soft">Loading config…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-mist text-ink-soft">
              <tr>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Govt fee</th>
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Days</th>
                <th className="px-4 py-3 font-medium">Stay/Validity</th>
                <th className="px-4 py-3 font-medium">Docs</th>
                <th className="px-4 py-3 font-medium">Active</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {products.map((countryProduct) => (
                <tr key={countryProduct.productCode} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">
                    {countryProduct.countryName}
                    <span className="ml-2 mrz text-[10px] text-ink-soft">
                      {countryProduct.countryCode}
                    </span>
                  </td>
                  <td className="px-4 py-3">₹{countryProduct.governmentFeeInr}</td>
                  <td className="px-4 py-3">₹{countryProduct.serviceFeeInr}</td>
                  <td className="px-4 py-3">{countryProduct.processingDays}</td>
                  <td className="px-4 py-3">
                    {countryProduct.stayDays}/{countryProduct.validityDays}
                  </td>
                  <td className="px-4 py-3">{countryProduct.docsRequired.length}</td>
                  <td className="px-4 py-3">
                    {countryProduct.active ? (
                      <span className="text-emerald-700 font-medium">On</span>
                    ) : (
                      <span className="text-ink-soft">Off</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setFormError(null);
                        setEditingProduct({
                          ...countryProduct,
                          docsRequired: [...countryProduct.docsRequired],
                        });
                      }}
                      className="text-sm font-semibold text-rgs-red hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingProduct && (
        <ConfigEditDrawer
          countryProduct={editingProduct}
          formError={formError}
          isSaving={putMutation.isPending}
          onClose={() => setEditingProduct(null)}
          onChange={setEditingProduct}
          onSave={() => {
            setFormError(null);
            const governmentFeeInr = editingProduct.governmentFeeInr;
            const serviceFeeInr = editingProduct.serviceFeeInr;
            const processingDays = editingProduct.processingDays;
            const stayDays = editingProduct.stayDays;
            const validityDays = editingProduct.validityDays;
            if (
              [governmentFeeInr, serviceFeeInr, processingDays, stayDays, validityDays].some(
                (value) => !Number.isFinite(value) || Number.isNaN(value) || value <= 0,
              )
            ) {
              setFormError("All fee and day fields must be positive whole numbers.");
              return;
            }
            if (editingProduct.docsRequired.length === 0) {
              setFormError("Select at least one required document.");
              return;
            }
            putMutation.mutate(editingProduct);
          }}
        />
      )}
    </AdminShell>
  );
}

function ConfigEditDrawer({
  countryProduct,
  formError,
  isSaving,
  onClose,
  onChange,
  onSave,
}: {
  countryProduct: CountryProduct;
  formError: string | null;
  isSaving: boolean;
  onClose: () => void;
  onChange: (countryProduct: CountryProduct) => void;
  onSave: () => void;
}) {
  function updateNumberField(
    fieldName:
      | "governmentFeeInr"
      | "serviceFeeInr"
      | "processingDays"
      | "stayDays"
      | "validityDays",
    rawValue: string,
  ): void {
    const parsedValue = parsePositiveInt(rawValue, fieldName);
    if (parsedValue === null) {
      // keep previous valid number; surface via empty input still allowed while typing
      onChange({ ...countryProduct, [fieldName]: Number.parseInt(rawValue, 10) || 0 });
      return;
    }
    onChange({ ...countryProduct, [fieldName]: parsedValue });
  }

  function toggleDocType(docType: DocType): void {
    const isSelected = countryProduct.docsRequired.includes(docType);
    const nextDocs = isSelected
      ? countryProduct.docsRequired.filter((requiredDoc) => requiredDoc !== docType)
      : [...countryProduct.docsRequired, docType];
    onChange({ ...countryProduct, docsRequired: nextDocs });
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm focus:border-ink/30";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40">
      <div className="flex h-full w-full max-w-md flex-col bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-bold">{countryProduct.countryName}</h2>
          <button type="button" onClick={onClose} className="text-sm text-ink-soft">
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {(
            [
              ["governmentFeeInr", "Government fee (INR)"],
              ["serviceFeeInr", "Service fee (INR)"],
              ["processingDays", "Processing days"],
              ["stayDays", "Stay days"],
              ["validityDays", "Validity days"],
            ] as const
          ).map(([fieldName, fieldLabel]) => (
            <label key={fieldName} className="block">
              <span className="mb-1 block text-sm font-medium">{fieldLabel}</span>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClasses}
                value={countryProduct[fieldName]}
                onChange={(changeEvent) =>
                  updateNumberField(fieldName, changeEvent.target.value)
                }
              />
            </label>
          ))}

          <div>
            <p className="mb-2 text-sm font-medium">Required documents</p>
            <div className="space-y-2">
              {DOC_TYPES.map((docType) => (
                <label key={docType} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={countryProduct.docsRequired.includes(docType)}
                    onChange={() => toggleDocType(docType)}
                  />
                  {DOC_TYPE_LABELS[docType]}
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={countryProduct.active}
              onChange={(changeEvent) =>
                onChange({ ...countryProduct, active: changeEvent.target.checked })
              }
            />
            Active (shown on marketing / portal)
          </label>

          {formError && (
            <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-3 py-2 text-sm text-rgs-red">
              {formError}
            </p>
          )}
        </div>
        <div className="border-t border-line px-5 py-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className="w-full rounded-full bg-ink px-4 py-3 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
