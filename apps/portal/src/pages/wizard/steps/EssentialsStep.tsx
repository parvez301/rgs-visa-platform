import type { Application } from "@rgs/shared";

export interface EssentialsStepProps {
  application: Application;
  onAdvance: () => Promise<void>;
}

/** Placeholder — Task 4 fills in travel essentials. */
export function EssentialsStep({ onAdvance }: EssentialsStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Essentials</h2>
        <p className="mt-1 text-ink-soft">Travel dates, purpose, and contact details.</p>
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
