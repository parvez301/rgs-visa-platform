import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { WIZARD_STEPS, type WizardStep } from "@rgs/shared";
import { portalApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { DocsStep } from "./steps/DocsStep";
import { EssentialsStep } from "./steps/EssentialsStep";
import { ReviewStep } from "./steps/ReviewStep";
import { TravellersStep } from "./steps/TravellersStep";

const STEP_LABELS: Record<WizardStep, string> = {
  travellers: "Travellers",
  docs: "Docs",
  essentials: "Essentials",
  review: "Review",
};

function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function WizardPage() {
  const { applicationId = "" } = useParams<{ applicationId: string }>();
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [activeStep, setActiveStep] = useState<WizardStep | null>(null);

  const applicationQuery = useQuery({
    queryKey: ["application", applicationId],
    queryFn: () => portalApi.getApplication(idToken!, applicationId),
    enabled: idToken !== null && applicationId.length > 0,
  });

  const application = applicationQuery.data?.application;
  const documents = applicationQuery.data?.documents ?? [];
  const hasRejectedDocuments = documents.some(
    (document) => document.reviewStatus === "REJECTED",
  );
  const isReuploadMode =
    application?.status === "SUBMITTED" && hasRejectedDocuments;

  useEffect(() => {
    if (!application || activeStep !== null) return;
    if (isReuploadMode) {
      setActiveStep("docs");
      return;
    }
    setActiveStep(application.stepReached);
  }, [application, activeStep, isReuploadMode]);

  const reachedStepIndex = application ? stepIndex(application.stepReached) : 0;
  const completedStepsCount = useMemo(() => {
    if (!application) return 0;
    return Math.min(reachedStepIndex, WIZARD_STEPS.length);
  }, [application, reachedStepIndex]);
  const progressPercent = Math.round((completedStepsCount / WIZARD_STEPS.length) * 100);

  /** Called by step components after they have already patchDraft'd stepReached. */
  async function handleStepAdvanced(nextStep: WizardStep): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["application", applicationId] });
    await queryClient.invalidateQueries({ queryKey: ["applications"] });
    setActiveStep(nextStep);
  }

  if (applicationQuery.isLoading || (activeStep === null && !applicationQuery.isError)) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-soft">
        Loading application…
      </div>
    );
  }

  if (applicationQuery.isError || !application) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
        <p className="text-ink-soft">We could not load this application.</p>
        <Link to="/" className="font-semibold text-rgs-red hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (application.status !== "DRAFT" && !isReuploadMode) {
    return <Navigate to="/" replace />;
  }

  if (activeStep === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-soft">
        Loading application…
      </div>
    );
  }

  const currentStepIndex = stepIndex(activeStep);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="border-b border-line bg-paper lg:w-72 lg:border-b-0 lg:border-r">
        <div className="px-6 py-5">
          <Link
            to="/"
            className="text-sm font-medium text-ink-soft hover:text-rgs-red transition-colors"
          >
            ← Back to dashboard
          </Link>
          <p className="mrz mt-4 text-xs text-rgs-red">RGS Visa Portal</p>
          <h1 className="mt-1 text-xl font-bold">
            {application.countryCode} application
          </h1>
          <p className="mt-3 text-sm text-ink-soft">
            {progressPercent}% complete
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-rgs-red transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

                <nav aria-label="Application steps" className="px-3 pb-6">
          <ol className="space-y-1">
            {WIZARD_STEPS.map((wizardStep, wizardStepIndex) => {
              const isReached = isReuploadMode
                ? wizardStep === "docs"
                : wizardStepIndex <= reachedStepIndex;
              const isActive = wizardStep === activeStep;
              return (
                <li key={wizardStep}>
                  <button
                    type="button"
                    disabled={!isReached || (isReuploadMode && wizardStep !== "docs")}
                    onClick={() => {
                      if (isReuploadMode && wizardStep !== "docs") return;
                      setActiveStep(wizardStep);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors ${
                      isActive
                        ? "bg-mist font-semibold text-ink"
                        : isReached
                          ? "text-ink hover:bg-mist"
                          : "cursor-not-allowed text-ink-soft/50"
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        wizardStepIndex < reachedStepIndex
                          ? "bg-rgs-red text-white"
                          : isActive
                            ? "border-2 border-rgs-red text-rgs-red"
                            : "border border-line text-ink-soft"
                      }`}
                    >
                      {wizardStepIndex + 1}
                    </span>
                    {STEP_LABELS[wizardStep]}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </aside>

      <main className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-2xl">
          {activeStep === "travellers" && !isReuploadMode && (
            <TravellersStep
              application={application}
              onAdvance={() => handleStepAdvanced("docs")}
            />
          )}
          {activeStep === "docs" && (
            <DocsStep
              application={application}
              documents={documents}
              reuploadOnly={isReuploadMode}
              onAdvance={() => handleStepAdvanced("essentials")}
              onDocumentsChanged={() => {
                void queryClient.invalidateQueries({
                  queryKey: ["application", applicationId],
                });
              }}
            />
          )}
          {activeStep === "essentials" && !isReuploadMode && (
            <EssentialsStep
              application={application}
              onAdvance={() => handleStepAdvanced("review")}
            />
          )}
          {activeStep === "review" && !isReuploadMode && (
            <ReviewStep application={application} documents={documents} />
          )}

          {currentStepIndex > 0 && !isReuploadMode && (
            <button
              type="button"
              onClick={() => setActiveStep(WIZARD_STEPS[currentStepIndex - 1]!)}
              className="mt-8 text-sm font-medium text-ink-soft hover:text-ink"
            >
              ← Previous step
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
