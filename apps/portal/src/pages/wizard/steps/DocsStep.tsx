import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type {
  Application,
  ApplicationDocument,
  DocType,
} from "@rgs/shared";
import { portalApi, uploadFileToPresignedUrl } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { DOC_TYPE_LABELS } from "../../../lib/docLabels";

export interface DocsStepProps {
  application: Application;
  documents: ApplicationDocument[];
  onAdvance: () => Promise<void>;
  onDocumentsChanged: () => void;
  /** When true (Task 6), only REJECTED slots are editable; others are read-only. */
  reuploadOnly?: boolean;
}

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type UploadSlotState = "empty" | "uploading" | "uploaded" | "rejected";

function documentForSlot(
  documents: ApplicationDocument[],
  travellerIndex: number,
  docType: DocType,
): ApplicationDocument | undefined {
  return documents.find(
    (document) =>
      document.travellerIndex === travellerIndex && document.docType === docType,
  );
}

function slotState(existingDocument: ApplicationDocument | undefined): UploadSlotState {
  if (!existingDocument) return "empty";
  if (existingDocument.reviewStatus === "REJECTED") return "rejected";
  return "uploaded";
}

export function DocsStep({
  application,
  documents,
  onAdvance,
  onDocumentsChanged,
  reuploadOnly = false,
}: DocsStepProps) {
  const { idToken } = useAuth();
  const [uploadingKeys, setUploadingKeys] = useState<Set<string>>(new Set());
  const [slotErrors, setSlotErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [reuploadDoneMessage, setReuploadDoneMessage] = useState<string | null>(null);

  const countriesQuery = useQuery({
    queryKey: ["countries"],
    queryFn: portalApi.listCountries,
  });

  const countryProduct = useMemo(
    () =>
      (countriesQuery.data ?? []).find(
        (product) => product.countryCode === application.countryCode,
      ),
    [countriesQuery.data, application.countryCode],
  );

  const requiredDocTypes = countryProduct?.docsRequired ?? [];

  const allSlotsFilled = application.travellers.every((_, travellerIndex) =>
    requiredDocTypes.every((docType) => {
      const existingDocument = documentForSlot(documents, travellerIndex, docType);
      return existingDocument !== undefined && existingDocument.reviewStatus !== "REJECTED";
    }),
  );

  function slotKey(travellerIndex: number, docType: DocType): string {
    return `${travellerIndex}:${docType}`;
  }

  async function handleFileSelected(
    travellerIndex: number,
    docType: DocType,
    fileList: FileList | null,
  ): Promise<void> {
    const file = fileList?.[0];
    if (!file) return;

    const key = slotKey(travellerIndex, docType);
    setSlotErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setReuploadDoneMessage(null);

    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      setSlotErrors((previous) => ({
        ...previous,
        [key]: "Only JPEG, PNG, or PDF files are allowed.",
      }));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSlotErrors((previous) => ({
        ...previous,
        [key]: "File must be 10 MB or smaller.",
      }));
      return;
    }

    setUploadingKeys((previous) => new Set(previous).add(key));
    try {
      const { uploadUrl, objectKey } = await portalApi.presignDocumentUpload(
        idToken!,
        application.applicationId,
        docType,
        travellerIndex,
        file.type,
      );
      await uploadFileToPresignedUrl(uploadUrl, file);
      await portalApi.recordDocumentUpload(
        idToken!,
        application.applicationId,
        docType,
        travellerIndex,
        objectKey,
      );
      onDocumentsChanged();
      if (reuploadOnly) {
        setReuploadDoneMessage("Done — our team will re-check");
      }
    } catch (error) {
      setSlotErrors((previous) => ({
        ...previous,
        [key]: error instanceof Error ? error.message : "Upload failed",
      }));
    } finally {
      setUploadingKeys((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleContinue(): Promise<void> {
    if (reuploadOnly) return;
    setFormError(null);
    if (!allSlotsFilled) {
      setFormError("Upload every required document before continuing.");
      return;
    }
    setIsSaving(true);
    try {
      await portalApi.patchDraft(idToken!, application.applicationId, {
        stepReached: "essentials",
      });
      await onAdvance();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save progress");
    } finally {
      setIsSaving(false);
    }
  }

  if (countriesQuery.isLoading) {
    return <p className="text-ink-soft">Loading document requirements…</p>;
  }

  if (!countryProduct) {
    return (
      <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red">
        Could not load document requirements for {application.countryCode}.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Documents</h2>
        <p className="mt-1 text-ink-soft">
          {reuploadOnly
            ? "Re-upload the documents our team flagged. Other files stay as they are."
            : `Upload the required documents for each traveller (${countryProduct.countryName}).`}
        </p>
      </div>

      {reuploadDoneMessage && (
        <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {reuploadDoneMessage}
        </p>
      )}

      <div className="space-y-8">
        {application.travellers.map((traveller, travellerIndex) => (
          <section key={travellerIndex} className="space-y-3">
            <h3 className="font-semibold">
              Traveller {travellerIndex + 1}
              {traveller.fullName ? ` — ${traveller.fullName}` : ""}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {requiredDocTypes.map((docType) => {
                const key = slotKey(travellerIndex, docType);
                const existingDocument = documentForSlot(documents, travellerIndex, docType);
                const isUploading = uploadingKeys.has(key);
                const state: UploadSlotState = isUploading
                  ? "uploading"
                  : slotState(existingDocument);
                const isRejectedSlot = existingDocument?.reviewStatus === "REJECTED";
                const canUpload = reuploadOnly ? isRejectedSlot : true;
                const inputId = `doc-${travellerIndex}-${docType}`;

                return (
                  <div
                    key={key}
                    className={`rounded-2xl border bg-paper p-4 ${
                      state === "rejected"
                        ? "border-rgs-red"
                        : state === "uploaded"
                          ? "border-emerald-300"
                          : "border-line"
                    }`}
                  >
                    <p className="text-sm font-medium">{DOC_TYPE_LABELS[docType]}</p>

                    {state === "uploading" && (
                      <p className="mt-3 text-sm text-ink-soft animate-pulse">Uploading…</p>
                    )}

                    {state === "uploaded" && (
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <p className="text-sm text-emerald-700 font-medium">✓ Uploaded</p>
                        {canUpload && (
                          <label
                            htmlFor={inputId}
                            className="cursor-pointer text-sm font-medium text-rgs-red hover:underline"
                          >
                            Re-upload
                          </label>
                        )}
                      </div>
                    )}

                    {state === "rejected" && (
                      <div className="mt-3 space-y-2">
                        <p className="text-sm text-rgs-red">
                          Rejected
                          {existingDocument?.rejectReason
                            ? `: ${existingDocument.rejectReason}`
                            : ""}
                        </p>
                        {canUpload && (
                          <label
                            htmlFor={inputId}
                            className="inline-block cursor-pointer rounded-full border border-rgs-red px-4 py-1.5 text-sm font-semibold text-rgs-red hover:bg-rgs-red hover:text-white transition-colors"
                          >
                            Re-upload
                          </label>
                        )}
                      </div>
                    )}

                    {state === "empty" && canUpload && (
                      <label
                        htmlFor={inputId}
                        className="mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-ink-soft hover:border-rgs-red transition-colors"
                      >
                        <span className="font-medium text-ink">Choose file</span>
                        <span className="mt-1 text-xs">JPEG, PNG, or PDF · max 10 MB</span>
                      </label>
                    )}

                    {state === "empty" && !canUpload && (
                      <p className="mt-3 text-sm text-ink-soft">No action needed</p>
                    )}

                    {canUpload && (
                      <input
                        id={inputId}
                        type="file"
                        accept="image/*,application/pdf"
                        capture="environment"
                        className="sr-only"
                        onChange={(changeEvent) => {
                          void handleFileSelected(
                            travellerIndex,
                            docType,
                            changeEvent.target.files,
                          );
                          changeEvent.target.value = "";
                        }}
                      />
                    )}

                    {slotErrors[key] && (
                      <p className="mt-2 text-xs text-rgs-red">{slotErrors[key]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {formError && (
        <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-4 py-3 text-sm text-rgs-red">
          {formError}
        </p>
      )}

      {!reuploadOnly && (
        <button
          type="button"
          disabled={isSaving || !allSlotsFilled}
          onClick={() => void handleContinue()}
          className="rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60"
        >
          {isSaving ? "Saving…" : "Continue"}
        </button>
      )}
    </div>
  );
}
