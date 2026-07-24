"use client";

import { NoticeBadge } from "./NoticeBadge";
import { renderNoticeBody } from "@/lib/renderNoticeBody";
import type { PublicNotice } from "@/lib/useNotices";
import { useLiveCatalog } from "@/lib/useLiveCatalog";

function relativeDate(isoTimestamp: string): string {
  const deltaMs = Date.now() - new Date(isoTimestamp).getTime();
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 24) return hours <= 1 ? "1h ago" : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(isoTimestamp).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function NoticeCard({ notice }: { notice: PublicNotice }) {
  const liveCatalog = useLiveCatalog();
  const countryName =
    notice.countryCode === undefined
      ? "All countries"
      : (liveCatalog?.find(
          (countryProduct) => countryProduct.countryCode === notice.countryCode,
        )?.countryName ?? notice.countryCode);
  const displayDate = notice.publishedAt ?? notice.createdAt;
  const bodyHtml = renderNoticeBody(notice.body);

  return (
    <article className="rounded-2xl border border-line bg-paper p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <NoticeBadge category={notice.category} severity={notice.severity} />
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          {notice.pinned && (
            <span className="font-semibold text-rgs-red">Pinned</span>
          )}
          <time dateTime={displayDate}>{relativeDate(displayDate)}</time>
        </div>
      </div>
      <h3 className="text-lg font-bold">{notice.title}</h3>
      <p className="text-xs font-medium text-ink-soft">{countryName}</p>
      <div
        className="prose-notice text-sm text-ink-soft leading-relaxed space-y-2 [&_a]:text-rgs-red [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </article>
  );
}
