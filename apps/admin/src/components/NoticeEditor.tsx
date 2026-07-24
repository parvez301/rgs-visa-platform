import {
  NOTICE_CATEGORIES,
  NOTICE_SEVERITIES,
  NOTICE_STATUSES,
  type CountryProduct,
  type Notice,
  type NoticeCategory,
  type NoticeInput,
  type NoticeSeverity,
  type NoticeStatus,
} from "@rgs/shared";
import { useState } from "react";

const inputClasses =
  "w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm focus:border-ink/30";

export interface NoticeEditorProps {
  notice: Notice | null;
  countries: CountryProduct[];
  isSaving: boolean;
  isDeleting: boolean;
  formError: string | null;
  onClose: () => void;
  onSave: (noticeInput: NoticeInput) => void;
  onDelete: (noticeId: string) => void;
}

function basicMarkdownPreview(markdownBody: string): string {
  return markdownBody
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<p><strong>$1</strong></p>")
    .replace(/^- (.+)$/gm, "<p>• $1</p>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

export function NoticeEditor({
  notice,
  countries,
  isSaving,
  isDeleting,
  formError,
  onClose,
  onSave,
  onDelete,
}: NoticeEditorProps) {
  const [title, setTitle] = useState(notice?.title ?? "");
  const [body, setBody] = useState(notice?.body ?? "");
  const [category, setCategory] = useState<NoticeCategory>(
    notice?.category ?? "GENERAL",
  );
  const [severity, setSeverity] = useState<NoticeSeverity>(
    notice?.severity ?? "INFO",
  );
  const [countryCode, setCountryCode] = useState<string>(notice?.countryCode ?? "");
  const [pinned, setPinned] = useState(notice?.pinned ?? false);
  const [status, setStatus] = useState<NoticeStatus>(notice?.status ?? "DRAFT");
  const [expiresAt, setExpiresAt] = useState(notice?.expiresAt ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sortedCountries = [...countries].sort((leftCountry, rightCountry) =>
    leftCountry.countryName.localeCompare(rightCountry.countryName),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40">
      <div className="flex h-full w-full max-w-xl flex-col bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="font-bold">{notice ? "Edit notice" : "New notice"}</h2>
          <button type="button" onClick={onClose} className="text-sm text-ink-soft">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Title</span>
            <input
              className={inputClasses}
              value={title}
              onChange={(changeEvent) => setTitle(changeEvent.target.value)}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Category</span>
              <select
                className={inputClasses}
                value={category}
                onChange={(changeEvent) =>
                  setCategory(changeEvent.target.value as NoticeCategory)
                }
              >
                {NOTICE_CATEGORIES.map((categoryOption) => (
                  <option key={categoryOption} value={categoryOption}>
                    {categoryOption}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Severity</span>
              <select
                className={inputClasses}
                value={severity}
                onChange={(changeEvent) =>
                  setSeverity(changeEvent.target.value as NoticeSeverity)
                }
              >
                {NOTICE_SEVERITIES.map((severityOption) => (
                  <option key={severityOption} value={severityOption}>
                    {severityOption}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Country</span>
            <select
              className={inputClasses}
              value={countryCode}
              onChange={(changeEvent) => setCountryCode(changeEvent.target.value)}
            >
              <option value="">All countries</option>
              {sortedCountries.map((countryProduct) => (
                <option
                  key={countryProduct.countryCode}
                  value={countryProduct.countryCode}
                >
                  {countryProduct.countryName}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Status</span>
              <select
                className={inputClasses}
                value={status}
                onChange={(changeEvent) =>
                  setStatus(changeEvent.target.value as NoticeStatus)
                }
              >
                {NOTICE_STATUSES.map((statusOption) => (
                  <option key={statusOption} value={statusOption}>
                    {statusOption}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Expires</span>
              <input
                type="date"
                className={inputClasses}
                value={expiresAt}
                onChange={(changeEvent) => setExpiresAt(changeEvent.target.value)}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(changeEvent) => setPinned(changeEvent.target.checked)}
            />
            Pin to top
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Body (Markdown)</span>
            <textarea
              className={`${inputClasses} min-h-40 font-mono text-xs`}
              value={body}
              onChange={(changeEvent) => setBody(changeEvent.target.value)}
            />
          </label>

          <div>
            <p className="mb-1 text-sm font-medium">Preview</p>
            <div
              className="rounded-xl border border-line bg-mist/40 px-3 py-2 text-sm text-ink-soft"
              dangerouslySetInnerHTML={{ __html: basicMarkdownPreview(body) }}
            />
          </div>

          {formError && (
            <p className="rounded-xl border border-rgs-red/30 bg-rgs-red/5 px-3 py-2 text-sm text-rgs-red">
              {formError}
            </p>
          )}

          {notice && (
            <div className="rounded-xl border border-line px-3 py-3">
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="text-sm font-semibold text-rgs-red hover:underline"
                >
                  Delete notice
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span>Delete this notice permanently?</span>
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => onDelete(notice.noticeId)}
                    className="rounded-full bg-rgs-red px-3 py-1.5 font-semibold text-white disabled:opacity-60"
                  >
                    {isDeleting ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="text-ink-soft hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-line px-5 py-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={() =>
              onSave({
                ...(notice?.noticeId ? { noticeId: notice.noticeId } : {}),
                title,
                body,
                category,
                severity,
                ...(countryCode ? { countryCode } : {}),
                pinned,
                status,
                ...(expiresAt ? { expiresAt } : {}),
              })
            }
            className="w-full rounded-full bg-ink px-4 py-3 text-sm font-semibold text-paper hover:bg-ink/90 disabled:opacity-60"
          >
            {isSaving ? "Saving…" : "Save notice"}
          </button>
        </div>
      </div>
    </div>
  );
}
