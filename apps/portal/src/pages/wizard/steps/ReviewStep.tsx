import type { Application, ApplicationDocument } from "@rgs/shared";

export interface ReviewStepProps {
  application: Application;
  documents: ApplicationDocument[];
}

/** Placeholder — Task 5 fills in review + submit. */
export function ReviewStep(_props: ReviewStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Review & submit</h2>
        <p className="mt-1 text-ink-soft">Check everything looks right before submitting.</p>
      </div>
    </div>
  );
}
