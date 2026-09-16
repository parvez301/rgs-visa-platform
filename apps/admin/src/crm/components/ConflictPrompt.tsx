import { SECONDARY_BUTTON_CLASS } from "./controls";

interface ConflictPromptProps {
  /** The API's own words (rule 4): the server is the one that knows why the stored state refuses this move. */
  serverMessage: string;
  /** The human's value, already through its label map -- never a raw enum. */
  yourValue: string;
  onKeepTheirs: () => void;
  onKeepMine: () => void;
}

/**
 * The 409 prompt, shared by the Ledger and the Case screen.
 *
 * Rule 4: a conflict shows both values and asks -- it never picks. Extracted
 * from `LedgerTable` when the Case screen grew its own two conflict sources
 * (a case-level edit and a per-applicant one): three copies of a dialog whose
 * whole job is to not decide for the human is three chances for one of them to
 * quietly start deciding.
 *
 * Both buttons are secondary on purpose: a prompt whose job is to not decide
 * for the human must not make one answer look like the right one.
 */
export function ConflictPrompt({
  serverMessage,
  yourValue,
  onKeepTheirs,
  onKeepMine,
}: ConflictPromptProps) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="This case changed underneath your edit"
      className="absolute inset-0 z-40 flex items-center justify-center bg-ink/40"
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-paper p-5 text-sm text-ink shadow-xl">
        <p className="text-base font-semibold">This case changed underneath your edit.</p>
        <p className="mt-2 text-ink-soft">{serverMessage}</p>
        <p className="mt-2">Your value: {yourValue}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onKeepTheirs}
            className={SECONDARY_BUTTON_CLASS}
          >
            Keep theirs
          </button>
          <button
            type="button"
            onClick={onKeepMine}
            className={SECONDARY_BUTTON_CLASS}
          >
            Keep mine
          </button>
        </div>
      </div>
    </div>
  );
}
