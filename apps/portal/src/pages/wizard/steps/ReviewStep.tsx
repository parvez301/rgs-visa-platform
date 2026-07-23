import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationDocument,
  type ApplicationStatus,
} from "@rgs/shared";
import { ApiRequestError, portalApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { DOC_TYPE_LABELS } from "../../../lib/docLabels";

export interface ReviewStepProps {
  application: Application;
  documents: ApplicationDocument[];
}

const STATUS_TIMELINE_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  DOCS_VERIFIED: "Docs verified",
  SENT_TO_IMMIGRATION: "With immigration",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DELIVERED: "Delivered",
};

function formatInr(amountInr: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amountInr);
}

export function ReviewStep({ application, documents }: ReviewStepProps) {
  const { idToken } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedApplication, setSubmittedApplication] = useState<Application | null>(
    null,
  );

  const countriesQuery = useQuery({
    queryKey: ["countries"],
    queryFn: portalApi.listCountries,
  });
  const countryProduct = (countriesQuery.data ?? []).find(
    (product) => product.countryCode === application.countryCode,
  );

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const result = await portalApi.submitApplication(
        idToken!,
        application.applicationId,
      );
      setSubmittedApplication(result);
    } catch (error) {
      if (error instanceof ApiRequestError && error.statusCode === 400) {
        setSubmitError(
          error.message ||
            "Some documents are missing or incomplete. Go back to Docs and fix them.",
        );
      } else {
        setSubmitError(
          error instanceof Error ? error.message : "Submit failed. Please try again.",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (submittedApplication) {
    const mainlineStatuses = APPLICATION_STATUSES.filter(
      (status) => status !== "REJECTED",
    );
    const currentIndex =
      submittedApplication.status === "REJECTED"
        ? mainlineStatuses.indexOf("SENT_TO_IMMIGRATION")
        : mainlineStatuses.indexOf(submittedApplication.status);

    return (
      <div className="speedlines fixed inset-0 z-50 flex flex-col items-center justify-center bg-mist text-center px-4">
        <div
          className="stamp mb-6 rounded-lg border-[3px] border-rgs-red bg-paper/90 px-6 py-3"
          aria-hidden="true"
        >
          <p className="mrz text-lg font-semibold text-rgs-red leading-tight">
            Submitted
            <br />
            <span className="text-[10px]">RGS · Visas on time</span>
          </p>
        </div>
        <p className="mrz text-xs text-rgs-red mb-3">Application submitted</p>
        <h2 className="text-3xl font-bold mb-2">We've got it</h2>
        <p className="text-ink-soft mb-6 max-w-md">
          Our team will review your documents and contact you about payment. Track
          progress anytime from your dashboard.
        </p>
        <p className="mrz text-xs text-ink-soft mb-8">
          {submittedApplication.applicationId}
        </p>

        <ol className="mb-10 flex w-full max-w-md items-center gap-1.5" aria-label="Status timeline">
          {mainlineStatuses.map((status, statusIndex) => (
            <li key={status} className="flex-1">
              <div
                className={`h-1.5 rounded-full ${
                  statusIndex <= currentIndex ? "bg-rgs-red" : "bg-line"
                }`}
                title={STATUS_TIMELINE_LABELS[status]}
              />
              <p className="mt-1 truncate text-[10px] text-ink-soft">
                {STATUS_TIMELINE_LABELS[status]}
              </p>
            </li>
          ))}
        </ol>

        <Link
          to="/"
          className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors"
        >
          Track on dashboard
        </Link>
      </div>
    );
  }

  const governmentFee =
    countryProduct?.governmentFeeInr ?? application.amounts.governmentFeeInr;
  const serviceFee = countryProduct?.serviceFeeInr ?? application.amounts.serviceFeeInr;
  const totalFee = governmentFee + serviceFee;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold">Review & submit</h2>
        <p className="mt-1 text-ink-soft">
          Check everything looks right before sending it to our team.
        </p>
      </div>

      <section className="rounded-2xl border border-line bg-paper p-5 space-y-3">
        <h3 className="font-semibold">Travellers</h3>
        <ul className="space-y-2 text-sm">
          {application.travellers.map((traveller, travellerIndex) => (
            <li key={travellerIndex} className="flex justify-between gap-4 border-b border-line pb-2 last:border-0">
              <span className="font-medium">{traveller.fullName || `Traveller ${travellerIndex + 1}`}</span>
              <span className="text-ink-soft mrz text-xs">{traveller.passportNumber}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-line bg-paper p-5 space-y-3">
        <h3 className="font-semibold">Documents</h3>
        <ul className="space-y-2 text-sm">
          {documents.map((document) => (
            <li
              key={`${document.travellerIndex}-${document.docType}`}
              className="flex items-center justify-between gap-3"
            >
              <span>
                Traveller {document.travellerIndex + 1} · {DOC_TYPE_LABELS[document.docType]}
              </span>
              <span className="text-emerald-700 font-medium">✓</span>
            </li>
          ))}
          {documents.length === 0 && (
            <li className="text-ink-soft">No documents uploaded yet.</li>
          )}
        </ul>
      </section>

      <section className="rounded-2xl border border-line bg-paper p-5 space-y-2 text-sm">
        <h3 className="font-semibold mb-3">Travel essentials</h3>
        <p>
          <span className="text-ink-soft">Travel date:</span>{" "}
          {application.essentials?.intendedTravelDate ?? "—"}
        </p>
        <p>
          <span className="text-ink-soft">Purpose:</span>{" "}
          {application.essentials?.purposeOfTravel ?? "—"}
        </p>
        <p>
          <span className="text-ink-soft">Phone:</span>{" "}
          {application.essentials?.contactPhone ?? "—"}
        </p>
        <p>
          <span className="text-ink-soft">Address:</span>{" "}
          {application.essentials?.residentialAddress ?? "—"}
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-paper p-5">
        <h3 className="font-semibold mb-3">Fees</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-soft">Government fee</dt>
            <dd>{formatInr(governmentFee)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-soft">Service fee</dt>
            <dd>{formatInr(serviceFee)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-2 font-semibold text-base">
            <dt>Total</dt>
            <dd>{formatInr(totalFee)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-ink-soft">
          No payment now — our team contacts you after review.
        </p>
      </section>

      {submitError && (
        <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red">
          {submitError}
        </p>
      )}

      <button
        type="button"
        disabled={isSubmitting}
        onClick={() => void handleSubmit()}
        className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60"
      >
        {isSubmitting ? "Submitting…" : "Submit application"}
      </button>
    </div>
  );
}
