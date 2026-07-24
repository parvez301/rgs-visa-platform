import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Notice, NoticeInput } from "@rgs/shared";
import { AdminShell } from "../components/AdminShell";
import { NoticeEditor } from "../components/NoticeEditor";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "../lib/auth";

export function NoticesPage() {
  const { idToken } = useAuth();
  const queryClient = useQueryClient();
  const [editingNotice, setEditingNotice] = useState<Notice | null | undefined>(
    undefined,
  );
  const [formError, setFormError] = useState<string | null>(null);

  const noticesQuery = useQuery({
    queryKey: ["admin-notices"],
    queryFn: () => adminApi.listNotices(idToken!),
    enabled: idToken !== null,
  });

  const countriesQuery = useQuery({
    queryKey: ["admin-countries"],
    queryFn: () => adminApi.listCountries(idToken!),
    enabled: idToken !== null,
  });

  const countryNameByCode = useMemo(() => {
    const nameByCode = new Map<string, string>();
    for (const countryProduct of countriesQuery.data ?? []) {
      nameByCode.set(countryProduct.countryCode, countryProduct.countryName);
    }
    return nameByCode;
  }, [countriesQuery.data]);

  const notices = [...(noticesQuery.data ?? [])].sort((leftNotice, rightNotice) =>
    rightNotice.updatedAt.localeCompare(leftNotice.updatedAt),
  );

  const saveMutation = useMutation({
    mutationFn: (noticeInput: NoticeInput) =>
      adminApi.upsertNotice(idToken!, noticeInput),
    onSuccess: () => {
      setEditingNotice(undefined);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-notices"] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (noticeId: string) => adminApi.deleteNotice(idToken!, noticeId),
    onSuccess: () => {
      setEditingNotice(undefined);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-notices"] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : "Delete failed"),
  });

  return (
    <AdminShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Notices</h1>
          <p className="mt-1 text-ink-soft">
            Publish visa rule changes and announcements to the marketing site.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError(null);
            setEditingNotice(null);
          }}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink/90"
        >
          New notice
        </button>
      </div>

      {noticesQuery.isLoading ? (
        <p className="text-ink-soft">Loading notices…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-paper">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-mist text-ink-soft">
              <tr>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Country</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {notices.map((notice) => (
                <tr
                  key={notice.noticeId}
                  onClick={() => {
                    setFormError(null);
                    setEditingNotice(notice);
                  }}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-mist/70 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">
                    {notice.title}
                    {notice.pinned && (
                      <span className="ml-2 text-[10px] font-semibold uppercase text-rgs-red">
                        Pinned
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">
                    {notice.countryCode
                      ? (countryNameByCode.get(notice.countryCode) ?? notice.countryCode)
                      : "All"}
                  </td>
                  <td className="px-4 py-3 text-xs">{notice.category}</td>
                  <td className="px-4 py-3 text-xs">{notice.severity}</td>
                  <td className="px-4 py-3 text-xs font-medium">{notice.status}</td>
                  <td className="px-4 py-3 text-ink-soft text-xs">
                    {new Date(notice.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
              {notices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-ink-soft">
                    No notices yet — create one to publish updates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editingNotice !== undefined && (
        <NoticeEditor
          notice={editingNotice}
          countries={countriesQuery.data ?? []}
          isSaving={saveMutation.isPending}
          isDeleting={deleteMutation.isPending}
          formError={formError}
          onClose={() => setEditingNotice(undefined)}
          onSave={(noticeInput) => saveMutation.mutate(noticeInput)}
          onDelete={(noticeId) => deleteMutation.mutate(noticeId)}
        />
      )}
    </AdminShell>
  );
}
