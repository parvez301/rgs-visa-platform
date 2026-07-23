import type { Application, ApplicationDocument } from "@rgs/shared";

export interface DocsStepProps {
  application: Application;
  documents: ApplicationDocument[];
  onAdvance: () => Promise<void>;
  onDocumentsChanged: () => void;
}

/** Placeholder — Task 3 fills in document uploads. */
export function DocsStep({ onAdvance }: DocsStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Documents</h2>
        <p className="mt-1 text-ink-soft">Upload the required documents for each traveller.</p>
      </div>
      <button
        type="button"
        onClick={() => void onAdvance()}
        className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors"
      >
        Continue
      </button>
    </div>
  );
}
