import { useState } from "react";
import {
  ApplicationEssentialsSchema,
  type Application,
  type ApplicationEssentials,
} from "@rgs/shared";
import { portalApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

export interface EssentialsStepProps {
  application: Application;
  onAdvance: () => Promise<void>;
}

const PURPOSE_OPTIONS = [
  "Tourism",
  "Business",
  "Family visit",
  "Transit",
  "Other",
] as const;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function EssentialsStep({ application, onAdvance }: EssentialsStepProps) {
  const { idToken } = useAuth();
  const existingEssentials = application.essentials;
  const [essentials, setEssentials] = useState<ApplicationEssentials>({
    intendedTravelDate: existingEssentials?.intendedTravelDate ?? "",
    purposeOfTravel: existingEssentials?.purposeOfTravel ?? "",
    contactPhone: existingEssentials?.contactPhone ?? "",
    residentialAddress: existingEssentials?.residentialAddress ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function updateField<FieldName extends keyof ApplicationEssentials>(
    fieldName: FieldName,
    fieldValue: ApplicationEssentials[FieldName],
  ): void {
    setEssentials((previous) => ({ ...previous, [fieldName]: fieldValue }));
  }

  async function handleContinue(): Promise<void> {
    setFormError(null);
    const parseResult = ApplicationEssentialsSchema.safeParse(essentials);
    if (!parseResult.success) {
      const nextFieldErrors: Record<string, string> = {};
      for (const issue of parseResult.error.issues) {
        const fieldName = String(issue.path[0] ?? "intendedTravelDate");
        nextFieldErrors[fieldName] = issue.message;
      }
      setFieldErrors(nextFieldErrors);
      setFormError("Please fix the highlighted fields before continuing.");
      return;
    }
    setFieldErrors({});
    setIsSaving(true);
    try {
      await portalApi.patchDraft(idToken!, application.applicationId, {
        essentials: parseResult.data,
        stepReached: "review",
      });
      await onAdvance();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save essentials");
    } finally {
      setIsSaving(false);
    }
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-ink/30";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Essentials</h2>
        <p className="mt-1 text-ink-soft">Travel dates, purpose, and how we reach you.</p>
      </div>

      <div className="space-y-4 rounded-2xl border border-line bg-paper p-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Intended travel date</span>
          <input
            type="date"
            min={todayIsoDate()}
            className={`${inputClasses} ${fieldErrors.intendedTravelDate ? "border-rgs-red" : ""}`}
            value={essentials.intendedTravelDate}
            onChange={(changeEvent) =>
              updateField("intendedTravelDate", changeEvent.target.value)
            }
          />
          {fieldErrors.intendedTravelDate && (
            <span className="mt-1 block text-xs text-rgs-red">
              {fieldErrors.intendedTravelDate}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Purpose of travel</span>
          <select
            className={`${inputClasses} ${fieldErrors.purposeOfTravel ? "border-rgs-red" : ""}`}
            value={essentials.purposeOfTravel}
            onChange={(changeEvent) =>
              updateField("purposeOfTravel", changeEvent.target.value)
            }
          >
            <option value="">Select purpose</option>
            {PURPOSE_OPTIONS.map((purposeOption) => (
              <option key={purposeOption} value={purposeOption}>
                {purposeOption}
              </option>
            ))}
          </select>
          {fieldErrors.purposeOfTravel && (
            <span className="mt-1 block text-xs text-rgs-red">
              {fieldErrors.purposeOfTravel}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Contact phone</span>
          <input
            type="tel"
            className={`${inputClasses} ${fieldErrors.contactPhone ? "border-rgs-red" : ""}`}
            value={essentials.contactPhone}
            onChange={(changeEvent) => updateField("contactPhone", changeEvent.target.value)}
            placeholder="+91…"
          />
          {fieldErrors.contactPhone && (
            <span className="mt-1 block text-xs text-rgs-red">{fieldErrors.contactPhone}</span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Residential address</span>
          <textarea
            rows={3}
            className={`${inputClasses} ${fieldErrors.residentialAddress ? "border-rgs-red" : ""}`}
            value={essentials.residentialAddress}
            onChange={(changeEvent) =>
              updateField("residentialAddress", changeEvent.target.value)
            }
          />
          {fieldErrors.residentialAddress && (
            <span className="mt-1 block text-xs text-rgs-red">
              {fieldErrors.residentialAddress}
            </span>
          )}
        </label>
      </div>

      {formError && (
        <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red">
          {formError}
        </p>
      )}

      <button
        type="button"
        disabled={isSaving}
        onClick={() => void handleContinue()}
        className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60"
      >
        {isSaving ? "Saving…" : "Continue"}
      </button>
    </div>
  );
}
