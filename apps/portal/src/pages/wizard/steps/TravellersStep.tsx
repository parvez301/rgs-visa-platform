import type { Application } from "@rgs/shared";

export interface TravellersStepProps {
  application: Application;
  onAdvance: () => Promise<void>;
}

/** Placeholder — Task 2 fills in the travellers form. */
export function TravellersStep({ onAdvance }: TravellersStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Travellers</h2>
        <p className="mt-1 text-ink-soft">Who is travelling on this visa?</p>
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
