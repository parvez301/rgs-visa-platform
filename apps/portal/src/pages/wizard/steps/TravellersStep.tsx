import { useState } from "react";
import {
  CompleteTravellerSchema,
  DRAFT_PLACEHOLDER_DATE,
  DRAFT_PLACEHOLDER_PASSPORT,
  type Application,
  type Traveller,
} from "@rgs/shared";
import { portalApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

export interface TravellersStepProps {
  application: Application;
  onAdvance: () => Promise<void>;
}

const EMPTY_TRAVELLER: Traveller = {
  fullName: "",
  dateOfBirth: "",
  nationality: "IN",
  passportNumber: "",
  passportIssueDate: "",
  passportExpiryDate: "",
};

const FIELD_LABELS: Record<keyof Omit<Traveller, "photoKey" | "passportKey">, string> = {
  fullName: "Full name (as in passport)",
  dateOfBirth: "Date of birth",
  nationality: "Nationality (ISO code)",
  passportNumber: "Passport number",
  passportIssueDate: "Passport issue date",
  passportExpiryDate: "Passport expiry date",
};

function displayFieldError(message: string): string {
  if (message.includes("expected YYYY-MM-DD")) return "Enter the date";
  return message;
}

function monthsBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) -
    (to.getUTCDate() < from.getUTCDate() ? 1 : 0)
  );
}

function addMonthsIso(isoDate: string, monthsToAdd: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + monthsToAdd);
  return date.toISOString().slice(0, 10);
}

export function TravellersStep({ application, onAdvance }: TravellersStepProps) {
  const { idToken } = useAuth();
  // Draft placeholders (PENDING / 1900-01-01) must show as blank fields,
  // never as prefilled values the traveller might mistake for real input.
  const [travellers, setTravellers] = useState<Traveller[]>(() =>
    application.travellers.length > 0
      ? application.travellers.map((traveller) => ({
          ...traveller,
          passportNumber:
            traveller.passportNumber === DRAFT_PLACEHOLDER_PASSPORT
              ? ""
              : traveller.passportNumber,
          dateOfBirth:
            traveller.dateOfBirth === DRAFT_PLACEHOLDER_DATE ? "" : traveller.dateOfBirth,
          passportIssueDate:
            traveller.passportIssueDate === DRAFT_PLACEHOLDER_DATE
              ? ""
              : traveller.passportIssueDate,
          passportExpiryDate:
            traveller.passportExpiryDate === DRAFT_PLACEHOLDER_DATE
              ? ""
              : traveller.passportExpiryDate,
        }))
      : [{ ...EMPTY_TRAVELLER }],
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const travelDate = application.essentials?.intendedTravelDate;
  const passportWarnings = travellers.flatMap((traveller, travellerIndex) => {
    if (!travelDate || !traveller.passportExpiryDate) return [];
    const requiredExpiry = addMonthsIso(travelDate, 6);
    if (traveller.passportExpiryDate >= requiredExpiry) return [];
    const monthsLeft = monthsBetween(travelDate, traveller.passportExpiryDate);
    return [
      `Traveller ${travellerIndex + 1}: passport expires less than 6 months after travel (${monthsLeft} months of validity). Most embassies require 6+ months.`,
    ];
  });

  function updateTraveller(
    travellerIndex: number,
    fieldName: keyof Traveller,
    fieldValue: string,
  ): void {
    setTravellers((previousTravellers) =>
      previousTravellers.map((traveller, currentIndex) =>
        currentIndex === travellerIndex
          ? { ...traveller, [fieldName]: fieldValue }
          : traveller,
      ),
    );
  }

  function addTraveller(): void {
    if (travellers.length >= 9) return;
    setTravellers((previousTravellers) => [...previousTravellers, { ...EMPTY_TRAVELLER }]);
  }

  function removeTraveller(travellerIndex: number): void {
    if (travellers.length <= 1) return;
    setTravellers((previousTravellers) =>
      previousTravellers.filter((_, currentIndex) => currentIndex !== travellerIndex),
    );
  }

  async function handleContinue(): Promise<void> {
    setFormError(null);
    const nextFieldErrors: Record<string, string> = {};

    travellers.forEach((traveller, travellerIndex) => {
      const parseResult = CompleteTravellerSchema.safeParse(traveller);
      if (!parseResult.success) {
        for (const issue of parseResult.error.issues) {
          const fieldName = String(issue.path[0] ?? "fullName");
          nextFieldErrors[`${travellerIndex}.${fieldName}`] = displayFieldError(
            issue.message,
          );
        }
      }
      if (!traveller.fullName.trim()) {
        nextFieldErrors[`${travellerIndex}.fullName`] = "Full name is required";
      }
      if (!traveller.passportNumber.trim()) {
        nextFieldErrors[`${travellerIndex}.passportNumber`] = "Passport number is required";
      }
    });

    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFormError("Please fix the highlighted fields before continuing.");
      return;
    }

    setIsSaving(true);
    try {
      await portalApi.patchDraft(idToken!, application.applicationId, {
        travellers,
        stepReached: "docs",
      });
      await onAdvance();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save travellers");
    } finally {
      setIsSaving(false);
    }
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-ink/30";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Travellers</h2>
        <p className="mt-1 text-ink-soft">
          Add everyone travelling on this application (1–9 travellers).
        </p>
      </div>

      <div className="space-y-8">
        {travellers.map((traveller, travellerIndex) => (
          <fieldset
            key={travellerIndex}
            className="rounded-2xl border border-line bg-paper p-5 space-y-4"
          >
            <legend className="px-1 text-sm font-semibold">
              Traveller {travellerIndex + 1}
            </legend>

            {(
              [
                "fullName",
                "dateOfBirth",
                "nationality",
                "passportNumber",
                "passportIssueDate",
                "passportExpiryDate",
              ] as const
            ).map((fieldName) => {
              const errorKey = `${travellerIndex}.${fieldName}`;
              const isDateField =
                fieldName === "dateOfBirth" ||
                fieldName === "passportIssueDate" ||
                fieldName === "passportExpiryDate";
              return (
                <label key={fieldName} className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    {FIELD_LABELS[fieldName]}
                  </span>
                  <input
                    className={`${inputClasses} ${
                      fieldErrors[errorKey] ? "border-rgs-red" : ""
                    }`}
                    type={isDateField ? "date" : "text"}
                    value={traveller[fieldName]}
                    onChange={(changeEvent) =>
                      updateTraveller(
                        travellerIndex,
                        fieldName,
                        fieldName === "nationality"
                          ? changeEvent.target.value.toUpperCase()
                          : changeEvent.target.value,
                      )
                    }
                    maxLength={fieldName === "nationality" ? 2 : undefined}
                  />
                  {fieldErrors[errorKey] && (
                    <span className="mt-1 block text-xs text-rgs-red">
                      {fieldErrors[errorKey]}
                    </span>
                  )}
                </label>
              );
            })}

            {travellers.length > 1 && (
              <button
                type="button"
                onClick={() => removeTraveller(travellerIndex)}
                className="text-sm font-medium text-ink-soft hover:text-rgs-red"
              >
                Remove traveller
              </button>
            )}
          </fieldset>
        ))}
      </div>

      {travellers.length < 9 && (
        <button
          type="button"
          onClick={addTraveller}
          className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold hover:border-rgs-red transition-colors"
        >
          + Add traveller
        </button>
      )}

      {passportWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
          {passportWarnings.map((warningText) => (
            <p key={warningText}>{warningText}</p>
          ))}
        </div>
      )}

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
