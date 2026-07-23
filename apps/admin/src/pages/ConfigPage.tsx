import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  COUNTRY_TIERS,
  DOC_TYPES,
  REGIONS,
  VISA_TYPES,
  type CountryProduct,
  type CountryTier,
  type DocType,
  type Region,
  type VisaType,
} from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";
import {
  buildImportPreview,
  configCsvFilename,
  parseConfigCsv,
  serializeConfigCsv,
  type ImportPreviewRow,
} from "../lib/configCsv";

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

type TierFilter = "ALL" | "FULFILLED" | "INFO_ONLY" | "INACTIVE";

const TIER_FILTER_OPTIONS: Array<{ value: TierFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "INFO_ONLY", label: "Info only" },
  { value: "INACTIVE", label: "Inactive" },
];

const TIER_BADGE_CLASSES: Record<CountryTier, string> = {
  FULFILLED: "bg-emerald-100 text-emerald-900",
  INFO_ONLY: "bg-sky-100 text-sky-900",
};

function parseNonNegativeInt(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) return null;
  return parsed;
}

function parsePositiveInt(rawValue: string): number | null {
  const parsed = parseNonNegativeInt(rawValue);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function sortCatalog(products: CountryProduct[]): CountryProduct[] {
  return [...products].sort((leftProduct, rightProduct) => {
    if (leftProduct.active !== rightProduct.active) {
      return leftProduct.active ? -1 : 1;
    }
    return leftProduct.countryName.localeCompare(rightProduct.countryName);
  });
}

export function ConfigPage() {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [editingProduct, setEditingProduct] = useState<CountryProduct | null>(null);
  const [hasSuccessfulPut, setHasSuccessfulPut] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState<Region | "ALL">("ALL");
  const [selectedTierFilter, setSelectedTierFilter] = useState<TierFilter>("ALL");
  const [importPreviewRows, setImportPreviewRows] = useState<ImportPreviewRow[] | null>(
    null,
  );
  const [acceptedImportRowNumbers, setAcceptedImportRowNumbers] = useState<Set<number>>(
    new Set(),
  );
  const [importProgress, setImportProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [importFailures, setImportFailures] = useState<
    Array<{ rowNumber: number; countryName: string; message: string }>
  >([]);
  const [isImporting, setIsImporting] = useState(false);

  const countriesQuery = useQuery({
    queryKey: ["admin-countries"],
    queryFn: () => adminApi.listCountries(idToken!),
    enabled: idToken !== null,
  });

  const products = countriesQuery.data ?? [];
  const awaitingReviewCount = products.filter((product) => !product.active).length;
  const showSeedButton = !hasSuccessfulPut;

  const filteredProducts = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const matched = products.filter((countryProduct) => {
      if (selectedRegion !== "ALL" && countryProduct.region !== selectedRegion) {
        return false;
      }
      if (selectedTierFilter === "INACTIVE" && countryProduct.active) return false;
      if (selectedTierFilter === "FULFILLED") {
        if (!countryProduct.active || countryProduct.tier !== "FULFILLED") return false;
      }
      if (selectedTierFilter === "INFO_ONLY") {
        if (!countryProduct.active || countryProduct.tier !== "INFO_ONLY") return false;
      }
      if (normalizedQuery.length === 0) return true;
      return (
        countryProduct.countryName.toLowerCase().includes(normalizedQuery) ||
        countryProduct.countryCode.toLowerCase().includes(normalizedQuery)
      );
    });
    return sortCatalog(matched);
  }, [products, searchQuery, selectedRegion, selectedTierFilter]);

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
          <p className="mt-1 text-ink-soft">
            Fees, timelines, and required documents.
            {awaitingReviewCount > 0 && (
              <span className="ml-2 font-medium text-amber-800">
                {awaitingReviewCount} awaiting review
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              const csvText = serializeConfigCsv(products);
              const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
              const objectUrl = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = objectUrl;
              anchor.download = configCsvFilename();
              anchor.click();
              URL.revokeObjectURL(objectUrl);
            }}
            disabled={products.length === 0}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:border-ink transition-colors disabled:opacity-60"
          >
            Export CSV
          </button>
          <label className="cursor-pointer rounded-full border border-line px-4 py-2 text-sm font-semibold hover:border-ink transition-colors">
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(changeEvent) => {
                const file = changeEvent.target.files?.[0];
                changeEvent.target.value = "";
                if (!file) return;
                void file.text().then((csvText) => {
                  const parsedRows = parseConfigCsv(csvText);
                  const previewRows = buildImportPreview(parsedRows, products);
                  const defaultAccepted = new Set(
                    previewRows
                      .filter(
                        (previewRow) =>
                          previewRow.kind === "changed" || previewRow.kind === "new",
                      )
                      .map((previewRow) => previewRow.rowNumber),
                  );
                  setAcceptedImportRowNumbers(defaultAccepted);
                  setImportFailures([]);
                  setImportProgress(null);
                  setImportPreviewRows(previewRows);
                });
              }}
            />
          </label>
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
      </div>

      <div className="mb-4 flex flex-col gap-3">
        <input
          type="search"
          placeholder="Search by country name or code…"
          value={searchQuery}
          onChange={(changeEvent) => setSearchQuery(changeEvent.target.value)}
          className="w-full max-w-md rounded-xl border border-line bg-paper px-4 py-2.5 text-sm focus:border-ink/30"
        />

        <div className="flex flex-wrap gap-2">
          <FilterChip
            label="All regions"
            isActive={selectedRegion === "ALL"}
            onSelect={() => setSelectedRegion("ALL")}
          />
          {REGIONS.map((region) => (
            <FilterChip
              key={region}
              label={region}
              isActive={selectedRegion === region}
              onSelect={() => setSelectedRegion(region)}
            />
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {TIER_FILTER_OPTIONS.map((tierOption) => (
            <FilterChip
              key={tierOption.value}
              label={
                tierOption.value === "INACTIVE" && awaitingReviewCount > 0
                  ? `${tierOption.label} (${awaitingReviewCount} awaiting review)`
                  : tierOption.label
              }
              isActive={selectedTierFilter === tierOption.value}
              onSelect={() => setSelectedTierFilter(tierOption.value)}
            />
          ))}
        </div>
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
                <th className="px-4 py-3 font-medium">Region</th>
                <th className="px-4 py-3 font-medium">Tier</th>
                <th className="px-4 py-3 font-medium">Visa type</th>
                <th className="px-4 py-3 font-medium">Fees</th>
                <th className="px-4 py-3 font-medium">Processing</th>
                <th className="px-4 py-3 font-medium">Active</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((countryProduct) => (
                <tr
                  key={countryProduct.productCode}
                  className={`border-b border-line last:border-0 ${
                    countryProduct.active ? "" : "bg-amber-50/60"
                  }`}
                >
                  <td className="px-4 py-3 font-medium">
                    {countryProduct.countryName}
                    <span className="ml-2 mrz text-[10px] text-ink-soft">
                      {countryProduct.countryCode}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{countryProduct.region}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${TIER_BADGE_CLASSES[countryProduct.tier]}`}
                    >
                      {countryProduct.tier}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{countryProduct.visaType}</td>
                  <td className="px-4 py-3">
                    ₹{countryProduct.governmentFeeInr} + ₹{countryProduct.serviceFeeInr}
                  </td>
                  <td className="px-4 py-3">{countryProduct.processingDays}d</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        countryProduct.active ? "bg-emerald-500" : "bg-ink-soft/40"
                      }`}
                      title={countryProduct.active ? "Active" : "Inactive"}
                    />
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
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-ink-soft">
                    No countries match these filters.
                  </td>
                </tr>
              )}
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
            const feeValues = [
              editingProduct.governmentFeeInr,
              editingProduct.serviceFeeInr,
            ];
            const dayValues = [
              editingProduct.processingDays,
              editingProduct.stayDays,
              editingProduct.validityDays,
            ];
            if (
              feeValues.some(
                (value) => !Number.isFinite(value) || Number.isNaN(value) || value < 0,
              )
            ) {
              setFormError("Fee fields must be whole numbers ≥ 0.");
              return;
            }
            if (
              dayValues.some(
                (value) => !Number.isFinite(value) || Number.isNaN(value) || value <= 0,
              )
            ) {
              setFormError("Day fields must be positive whole numbers.");
              return;
            }
            if (
              editingProduct.active &&
              editingProduct.tier === "FULFILLED" &&
              editingProduct.docsRequired.length === 0
            ) {
              setFormError(
                "Cannot activate a Fulfilled country without a documents checklist. Add at least one required document, or switch tier to Info only.",
              );
              return;
            }
            putMutation.mutate(editingProduct);
          }}
        />
      )}

      {importPreviewRows && (
        <CsvImportDrawer
          previewRows={importPreviewRows}
          acceptedRowNumbers={acceptedImportRowNumbers}
          isImporting={isImporting}
          importProgress={importProgress}
          importFailures={importFailures}
          onClose={() => {
            if (isImporting) return;
            setImportPreviewRows(null);
            setImportFailures([]);
            setImportProgress(null);
          }}
          onToggleRow={(rowNumber, isAccepted) => {
            setAcceptedImportRowNumbers((previousAccepted) => {
              const nextAccepted = new Set(previousAccepted);
              if (isAccepted) nextAccepted.add(rowNumber);
              else nextAccepted.delete(rowNumber);
              return nextAccepted;
            });
          }}
          onConfirm={async () => {
            if (!idToken) return;
            const rowsToPut = importPreviewRows.filter(
              (previewRow) =>
                previewRow.product &&
                acceptedImportRowNumbers.has(previewRow.rowNumber) &&
                (previewRow.kind === "changed" || previewRow.kind === "new"),
            );
            if (rowsToPut.length === 0) return;
            setIsImporting(true);
            setImportFailures([]);
            setImportProgress({ completed: 0, total: rowsToPut.length });
            const failures: Array<{
              rowNumber: number;
              countryName: string;
              message: string;
            }> = [];
            for (let rowIndex = 0; rowIndex < rowsToPut.length; rowIndex += 1) {
              const previewRow = rowsToPut[rowIndex]!;
              try {
                await adminApi.putCountry(idToken, previewRow.product!);
              } catch (error) {
                failures.push({
                  rowNumber: previewRow.rowNumber,
                  countryName: previewRow.product!.countryName,
                  message: error instanceof Error ? error.message : "Save failed",
                });
              }
              setImportProgress({ completed: rowIndex + 1, total: rowsToPut.length });
            }
            setImportFailures(failures);
            setIsImporting(false);
            setHasSuccessfulPut(true);
            void queryClient.invalidateQueries({ queryKey: ["admin-countries"] });
            if (failures.length === 0) {
              setToastMessage(
                `Imported ${rowsToPut.length} countr${rowsToPut.length === 1 ? "y" : "ies"}`,
              );
              setImportPreviewRows(null);
              setImportProgress(null);
            }
          }}
        />
      )}
    </AdminShell>
  );
}

function FilterChip({
  label,
  isActive,
  onSelect,
}: {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
        isActive
          ? "bg-ink text-paper"
          : "border border-line bg-paper text-ink-soft hover:border-ink/30"
      }`}
    >
      {label}
    </button>
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
  function updateFeeField(
    fieldName: "governmentFeeInr" | "serviceFeeInr",
    rawValue: string,
  ): void {
    const parsedValue = parseNonNegativeInt(rawValue);
    onChange({
      ...countryProduct,
      [fieldName]: parsedValue ?? (Number.parseInt(rawValue, 10) || 0),
    });
  }

  function updateDayField(
    fieldName: "processingDays" | "stayDays" | "validityDays",
    rawValue: string,
  ): void {
    const parsedValue = parsePositiveInt(rawValue);
    onChange({
      ...countryProduct,
      [fieldName]: parsedValue ?? (Number.parseInt(rawValue, 10) || 0),
    });
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
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Region</span>
            <select
              className={inputClasses}
              value={countryProduct.region}
              onChange={(changeEvent) =>
                onChange({
                  ...countryProduct,
                  region: changeEvent.target.value as Region,
                })
              }
            >
              {REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Tier</span>
            <select
              className={inputClasses}
              value={countryProduct.tier}
              onChange={(changeEvent) =>
                onChange({
                  ...countryProduct,
                  tier: changeEvent.target.value as CountryTier,
                })
              }
            >
              {COUNTRY_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Visa type</span>
            <select
              className={inputClasses}
              value={countryProduct.visaType}
              onChange={(changeEvent) =>
                onChange({
                  ...countryProduct,
                  visaType: changeEvent.target.value as VisaType,
                })
              }
            >
              {VISA_TYPES.map((visaType) => (
                <option key={visaType} value={visaType}>
                  {visaType}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Official URL</span>
            <input
              type="url"
              className={inputClasses}
              value={countryProduct.officialUrl ?? ""}
              placeholder="https://…"
              onChange={(changeEvent) =>
                onChange({
                  ...countryProduct,
                  officialUrl: changeEvent.target.value.trim() || undefined,
                })
              }
            />
            {countryProduct.officialUrl && (
              <a
                href={countryProduct.officialUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-block text-xs font-medium text-rgs-red hover:underline break-all"
              >
                {countryProduct.officialUrl}
              </a>
            )}
          </label>

          {(
            [
              ["governmentFeeInr", "Government fee (INR)", "fee"],
              ["serviceFeeInr", "Service fee (INR)", "fee"],
              ["processingDays", "Processing days", "day"],
              ["stayDays", "Stay days", "day"],
              ["validityDays", "Validity days", "day"],
            ] as const
          ).map(([fieldName, fieldLabel, fieldKind]) => (
            <label key={fieldName} className="block">
              <span className="mb-1 block text-sm font-medium">{fieldLabel}</span>
              <input
                type="number"
                min={fieldKind === "fee" ? 0 : 1}
                step={1}
                className={inputClasses}
                value={countryProduct[fieldName]}
                onChange={(changeEvent) =>
                  fieldKind === "fee"
                    ? updateFeeField(
                        fieldName as "governmentFeeInr" | "serviceFeeInr",
                        changeEvent.target.value,
                      )
                    : updateDayField(
                        fieldName as "processingDays" | "stayDays" | "validityDays",
                        changeEvent.target.value,
                      )
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

function CsvImportDrawer({
  previewRows,
  acceptedRowNumbers,
  isImporting,
  importProgress,
  importFailures,
  onClose,
  onToggleRow,
  onConfirm,
}: {
  previewRows: ImportPreviewRow[];
  acceptedRowNumbers: Set<number>;
  isImporting: boolean;
  importProgress: { completed: number; total: number } | null;
  importFailures: Array<{ rowNumber: number; countryName: string; message: string }>;
  onClose: () => void;
  onToggleRow: (rowNumber: number, isAccepted: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const actionableCount = previewRows.filter(
    (previewRow) =>
      (previewRow.kind === "changed" || previewRow.kind === "new") &&
      acceptedRowNumbers.has(previewRow.rowNumber),
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40">
      <div className="flex h-full w-full max-w-2xl flex-col bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-bold">Import CSV preview</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Validate with schema, accept rows, then PUT sequentially. No deletes.
            </p>
          </div>
          <button
            type="button"
            disabled={isImporting}
            onClick={onClose}
            className="text-sm text-ink-soft disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-ink-soft">
              <tr>
                <th className="py-2 pr-2 font-medium">Accept</th>
                <th className="py-2 pr-2 font-medium">Row</th>
                <th className="py-2 pr-2 font-medium">Country</th>
                <th className="py-2 pr-2 font-medium">Diff</th>
                <th className="py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((previewRow) => {
                const canAccept =
                  previewRow.kind === "changed" || previewRow.kind === "new";
                const rowHighlight =
                  previewRow.kind === "changed"
                    ? "bg-amber-50"
                    : previewRow.kind === "new"
                      ? "bg-emerald-50"
                      : previewRow.kind === "invalid"
                        ? "bg-rgs-red/5"
                        : "";
                return (
                  <tr
                    key={previewRow.rowNumber}
                    className={`border-b border-line last:border-0 ${rowHighlight}`}
                  >
                    <td className="py-2 pr-2">
                      {canAccept ? (
                        <input
                          type="checkbox"
                          disabled={isImporting}
                          checked={acceptedRowNumbers.has(previewRow.rowNumber)}
                          onChange={(changeEvent) =>
                            onToggleRow(previewRow.rowNumber, changeEvent.target.checked)
                          }
                        />
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 mrz text-xs">{previewRow.rowNumber}</td>
                    <td className="py-2 pr-2 font-medium">
                      {previewRow.product?.countryName ??
                        previewRow.existingProduct?.countryName ??
                        "—"}
                    </td>
                    <td className="py-2 pr-2 text-xs font-semibold uppercase tracking-wide">
                      {previewRow.kind}
                    </td>
                    <td className="py-2 text-xs text-ink-soft">
                      {previewRow.validationError ??
                        (previewRow.kind === "changed"
                          ? "Will overwrite existing row"
                          : previewRow.kind === "new"
                            ? "New product code"
                            : previewRow.kind === "unchanged"
                              ? "Identical — skipped"
                              : "")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {importProgress && (
            <p className="mt-4 text-sm text-ink-soft">
              Progress: {importProgress.completed} / {importProgress.total}
            </p>
          )}

          {importFailures.length > 0 && (
            <div className="mt-4 space-y-1 rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-3 py-2 text-sm text-rgs-red">
              <p className="font-semibold">Failures</p>
              {importFailures.map((failure) => (
                <p key={`${failure.rowNumber}-${failure.message}`}>
                  Row {failure.rowNumber} ({failure.countryName}): {failure.message}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-line px-5 py-4">
          <button
            type="button"
            disabled={isImporting || actionableCount === 0}
            onClick={() => void onConfirm()}
            className="w-full rounded-full bg-ink px-4 py-3 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
          >
            {isImporting
              ? `Saving ${importProgress?.completed ?? 0}/${importProgress?.total ?? 0}…`
              : `Apply ${actionableCount} accepted row${actionableCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

