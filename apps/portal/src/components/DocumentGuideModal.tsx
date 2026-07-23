import { useEffect } from "react";
import type { DocType } from "@rgs/shared";
import { DOC_TYPE_LABELS } from "../lib/docLabels";
import { DOC_GUIDANCE, DOC_GUIDE_DETAILS } from "../lib/uploadChecks";

/** CSS-drawn example: passport bio page with readable MRZ. */
function PassportExample({ isBad = false }: { isBad?: boolean }) {
  return (
    <div
      className={`relative aspect-[7/5] w-full overflow-hidden rounded-lg border bg-[#f7f4ec] p-2.5 ${
        isBad ? "border-rgs-red/40 rotate-3" : "border-line"
      }`}
    >
      <div className="flex gap-2">
        <div className="h-14 w-11 rounded bg-ink/15" />
        <div className="flex-1 space-y-1.5 pt-1">
          <div className="h-1.5 w-3/4 rounded bg-ink/20" />
          <div className="h-1.5 w-1/2 rounded bg-ink/20" />
          <div className="h-1.5 w-2/3 rounded bg-ink/20" />
        </div>
      </div>
      <p className="mrz absolute bottom-1.5 left-2.5 right-2.5 truncate text-[8px] leading-tight text-ink/50">
        P&lt;INDVERMA&lt;&lt;ASHA&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
        <br />
        N1234567&lt;8IND9204182F3001099&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
      </p>
      {isBad && (
        <>
          <div
            className="pointer-events-none absolute -right-4 bottom-0 h-16 w-24 bg-[radial-gradient(closest-side,rgb(255_255_255/0.95),transparent)]"
            aria-hidden="true"
          />
          <div className="absolute right-0 top-0 h-full w-3 bg-mist" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

/** CSS-drawn example: head-and-shoulders photo. */
function PhotoExample({ isBad = false }: { isBad?: boolean }) {
  return (
    <div
      className={`relative aspect-[4/5] w-full overflow-hidden rounded-lg border ${
        isBad ? "border-rgs-red/40 bg-slate-300" : "border-line bg-white"
      }`}
    >
      <div className="absolute left-1/2 top-[22%] h-[34%] w-[52%] -translate-x-1/2 rounded-full bg-ink/25" />
      <div className="absolute left-1/2 top-[52%] h-[55%] w-[85%] -translate-x-1/2 rounded-t-[45%] bg-ink/25" />
      {isBad && (
        <div className="absolute left-1/2 top-[30%] h-[7%] w-[44%] -translate-x-1/2 rounded-sm bg-ink/70" />
      )}
    </div>
  );
}

/** Generic document sheet for the remaining types. */
function SheetExample() {
  return (
    <div className="relative aspect-[7/5] w-full overflow-hidden rounded-lg border border-line bg-white p-3">
      <div className="space-y-1.5">
        <div className="h-2 w-1/3 rounded bg-ink/25" />
        <div className="h-1.5 w-full rounded bg-ink/10" />
        <div className="h-1.5 w-full rounded bg-ink/10" />
        <div className="h-1.5 w-5/6 rounded bg-ink/10" />
        <div className="h-1.5 w-full rounded bg-ink/10" />
      </div>
      <div className="mrz absolute bottom-2 right-2 rounded border border-rgs-red/50 px-1.5 py-0.5 text-[8px] text-rgs-red/70 -rotate-6">
        Verified by RGS
      </div>
    </div>
  );
}

export function DocumentGuideModal({
  docType,
  onClose,
}: {
  docType: DocType;
  onClose: () => void;
}) {
  const guideDetails = DOC_GUIDE_DETAILS[docType];
  const hasVisualPair = docType === "PASSPORT_BIO" || docType === "PHOTO";

  useEffect(() => {
    function handleEscape(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${DOC_TYPE_LABELS[docType]} guide`}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-paper p-6 sm:rounded-2xl"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="mrz text-xs text-rgs-red">Document guide</p>
            <h2 className="text-xl font-bold">{DOC_TYPE_LABELS[docType]}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close guide"
            className="rounded-full border border-line px-3 py-1 text-sm hover:border-ink transition-colors"
          >
            ✕
          </button>
        </div>

        {hasVisualPair && (
          <div className="mb-5 grid grid-cols-2 gap-4">
            <figure>
              {docType === "PASSPORT_BIO" ? <PassportExample /> : <PhotoExample />}
              <figcaption className="mt-1.5 text-center text-xs font-semibold text-emerald-700">
                ✓ Like this
              </figcaption>
            </figure>
            <figure>
              {docType === "PASSPORT_BIO" ? (
                <PassportExample isBad />
              ) : (
                <PhotoExample isBad />
              )}
              <figcaption className="mt-1.5 text-center text-xs font-semibold text-rgs-red">
                ✗ Not like this
              </figcaption>
            </figure>
          </div>
        )}
        {!hasVisualPair && (
          <div className="mb-5 w-2/3 mx-auto">
            <SheetExample />
          </div>
        )}

        <section className="mb-4">
          <h3 className="mb-2 text-sm font-bold">Do</h3>
          <ul className="space-y-1.5">
            {DOC_GUIDANCE[docType].map((guidanceTip) => (
              <li key={guidanceTip} className="flex items-start gap-2 text-sm text-ink-soft">
                <span className="mt-0.5 text-emerald-600" aria-hidden="true">
                  ✓
                </span>
                {guidanceTip}
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-4">
          <h3 className="mb-2 text-sm font-bold">Don&apos;t</h3>
          <ul className="space-y-1.5">
            {guideDetails.donts.map((dontTip) => (
              <li key={dontTip} className="flex items-start gap-2 text-sm text-ink-soft">
                <span className="mt-0.5 text-rgs-red" aria-hidden="true">
                  ✗
                </span>
                {dontTip}
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-5 rounded-xl bg-mist p-4">
          <h3 className="mb-2 text-sm font-bold">Why documents get rejected</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {guideDetails.commonRejections.map((rejectionReason) => (
              <li key={rejectionReason}>{rejectionReason}</li>
            ))}
          </ul>
        </section>

        <p className="mrz text-[10px] text-ink-soft">{guideDetails.fileSpec}</p>
      </div>
    </div>
  );
}
