import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import type { Application, ApplicationStatus } from "@rgs/shared";
import { APPLICATION_STATUSES } from "@rgs/shared";
import { portalApi } from "../lib/api";
import { useAuth } from "../lib/auth";

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  DRAFT: "Draft — continue where you left off",
  SUBMITTED: "Submitted — documents under review",
  DOCS_VERIFIED: "Documents verified",
  SENT_TO_IMMIGRATION: "With immigration",
  APPROVED: "Approved!",
  REJECTED: "Not approved",
  DELIVERED: "Visa delivered",
};

function StatusTimeline({ currentStatus }: { currentStatus: ApplicationStatus }) {
  const mainlineStatuses = APPLICATION_STATUSES.filter(
    (status) => status !== "REJECTED",
  );
  const currentIndex = mainlineStatuses.indexOf(
    currentStatus === "REJECTED" ? "SENT_TO_IMMIGRATION" : currentStatus,
  );
  return (
    <ol className="flex items-center gap-1.5" aria-label="Application progress">
      {mainlineStatuses.map((status, statusIndex) => (
        <li
          key={status}
          className={`h-1.5 flex-1 rounded-full ${
            statusIndex <= currentIndex
              ? currentStatus === "REJECTED"
                ? "bg-ink-soft"
                : "bg-rgs-red"
              : "bg-line"
          }`}
          title={STATUS_LABELS[status]}
        />
      ))}
    </ol>
  );
}

export function DashboardPage() {
  const { idToken, email, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [isPickingCountry, setIsPickingCountry] = useState(false);

  const applicationsQuery = useQuery({
    queryKey: ["applications"],
    queryFn: () => portalApi.listMyApplications(idToken!),
    enabled: idToken !== null,
  });

  const countriesQuery = useQuery({
    queryKey: ["countries"],
    queryFn: portalApi.listCountries,
  });

  const createDraftMutation = useMutation({
    mutationFn: (countryCode: string) => portalApi.createDraft(idToken!, countryCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      setIsPickingCountry(false);
    },
  });

  const applications = applicationsQuery.data ?? [];
  const submittedApplicationIds = applications
    .filter((application) => application.status === "SUBMITTED")
    .map((application) => application.applicationId);

  const submittedDetailQueries = useQueries({
    queries: submittedApplicationIds.map((applicationId) => ({
      queryKey: ["application", applicationId],
      queryFn: () => portalApi.getApplication(idToken!, applicationId),
      enabled: idToken !== null,
    })),
  });

  const applicationIdsNeedingReupload = new Set(
    submittedDetailQueries
      .filter((detailQuery) =>
        (detailQuery.data?.documents ?? []).some(
          (document) => document.reviewStatus === "REJECTED",
        ),
      )
      .map((detailQuery) => detailQuery.data!.application.applicationId),
  );

  const ongoingApplications = applications.filter(
    (application) => !["DELIVERED", "REJECTED"].includes(application.status),
  );
  const completedApplications = applications.filter((application) =>
    ["DELIVERED", "REJECTED"].includes(application.status),
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <p className="mrz text-xs text-rgs-red">RGS Visa Portal</p>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-ink-soft hidden sm:inline">{email}</span>
            <button onClick={signOut} className="font-medium hover:text-rgs-red">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-bold">Your applications</h1>
          <button
            onClick={() => setIsPickingCountry((current) => !current)}
            className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors"
          >
            Start new application
          </button>
        </div>

        {isPickingCountry && (
          <div className="mb-8 rounded-2xl border border-line bg-paper p-6">
            <h2 className="font-bold mb-4">Where are you travelling?</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(countriesQuery.data ?? []).map((countryProduct) => (
                <button
                  key={countryProduct.productCode}
                  disabled={createDraftMutation.isPending}
                  onClick={() => createDraftMutation.mutate(countryProduct.countryCode)}
                  className="rounded-xl border border-line px-4 py-3 text-left text-sm font-medium hover:border-rgs-red transition-colors disabled:opacity-60"
                >
                  {countryProduct.countryName}
                  <span className="mt-1 block text-xs text-ink-soft">
                    ₹
                    {new Intl.NumberFormat("en-IN").format(
                      countryProduct.governmentFeeInr + countryProduct.serviceFeeInr,
                    )}{" "}
                    · {countryProduct.processingDays} working days
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {applicationsQuery.isLoading && <p className="text-ink-soft">Loading…</p>}

        {!applicationsQuery.isLoading && applications.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-line bg-paper/60 p-12 text-center">
            <p className="text-lg font-semibold mb-1">No applications yet</p>
            <p className="text-ink-soft">
              Start your first visa application — it takes about 10 minutes.
            </p>
          </div>
        )}

        {ongoingApplications.length > 0 && (
          <section className="mb-10">
            <h2 className="mrz text-xs text-ink-soft mb-3">Ongoing</h2>
            <div className="space-y-4">
              {ongoingApplications.map((application) => (
                <ApplicationCard
                  key={application.applicationId}
                  application={application}
                  needsDocumentReupload={applicationIdsNeedingReupload.has(
                    application.applicationId,
                  )}
                />
              ))}
            </div>
          </section>
        )}

        {completedApplications.length > 0 && (
          <section>
            <h2 className="mrz text-xs text-ink-soft mb-3">Completed</h2>
            <div className="space-y-4">
              {completedApplications.map((application) => (
                <ApplicationCard key={application.applicationId} application={application} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function ApplicationCard({
  application,
  needsDocumentReupload = false,
}: {
  application: Application;
  needsDocumentReupload?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="font-display text-lg font-bold">
            {application.countryCode} visa · {application.travellers.length}{" "}
            {application.travellers.length === 1 ? "traveller" : "travellers"}
          </p>
          <p className="text-sm text-ink-soft">{STATUS_LABELS[application.status]}</p>
          {needsDocumentReupload && (
            <Link
              to={`/apply/${application.applicationId}`}
              className="mt-2 inline-flex rounded-full bg-rgs-red/10 px-3 py-1 text-xs font-semibold text-rgs-red hover:bg-rgs-red hover:text-white transition-colors"
            >
              Action needed — re-upload document
            </Link>
          )}
        </div>
        {application.status === "DRAFT" ? (
          <Link
            to={`/apply/${application.applicationId}`}
            className="rounded-full border border-rgs-red px-5 py-2 text-sm font-semibold text-rgs-red hover:bg-rgs-red hover:text-white transition-colors"
          >
            Resume
          </Link>
        ) : (
          <span className="mrz text-[10px] text-ink-soft">
            {application.applicationId.slice(0, 12)}
          </span>
        )}
      </div>
      <StatusTimeline currentStatus={application.status} />
    </div>
  );
}
