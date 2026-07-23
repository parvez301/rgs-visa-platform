import { useState } from "react";
import type { Application } from "@rgs/shared";
import { portalApi } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

export interface EssentialsStepProps {
  application: Application;
  onAdvance: () => Promise<void>;
}

/** Placeholder — Task 4 fills in travel essentials. */
export function EssentialsStep({ application, onAdvance }: EssentialsStepProps) {
  const { idToken } = useAuth();
  const [isSaving, setIsSaving] = useState(false);

  async function handleContinue(): Promise<void> {
    setIsSaving(true);
    try {
      await portalApi.patchDraft(idToken!, application.applicationId, {
        stepReached: "review",
      });
      await onAdvance();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Essentials</h2>
        <p className="mt-1 text-ink-soft">Travel dates, purpose, and contact details.</p>
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
