import { useState } from "react";
import type { Application, ApplicationDocument } from "@rgs/shared";
import { portalApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

export interface DocsStepProps {
  application: Application;
  documents: ApplicationDocument[];
  onAdvance: () => Promise<void>;
  onDocumentsChanged: () => void;
}

/** Placeholder — Task 3 fills in document uploads. */
export function DocsStep({ application, onAdvance }: DocsStepProps) {
  const { idToken } = useAuth();
  const [isSaving, setIsSaving] = useState(false);

  async function handleContinue(): Promise<void> {
    setIsSaving(true);
    try {
      await portalApi.patchDraft(idToken!, application.applicationId, {
        stepReached: "essentials",
      });
      await onAdvance();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Documents</h2>
        <p className="mt-1 text-ink-soft">Upload the required documents for each traveller.</p>
      </div>
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
