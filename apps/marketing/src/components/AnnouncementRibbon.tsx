"use client";

import Link from "next/link";
import { useNotices, type PublicNotice } from "@/lib/useNotices";

const SEVERITY_DOT: Record<PublicNotice["severity"], string> = {
  URGENT: "bg-white",
  IMPORTANT: "bg-amber-300",
  INFO: "bg-white/70",
};

function sortForTicker(notices: PublicNotice[]): PublicNotice[] {
  const severityRank = (notice: PublicNotice) =>
    notice.severity === "URGENT" ? 0 : notice.severity === "IMPORTANT" ? 1 : 2;
  return [...notices].sort((leftNotice, rightNotice) => {
    if (leftNotice.pinned !== rightNotice.pinned) return leftNotice.pinned ? -1 : 1;
    const bySeverity = severityRank(leftNotice) - severityRank(rightNotice);
    if (bySeverity !== 0) return bySeverity;
    const leftDate = leftNotice.publishedAt ?? leftNotice.createdAt;
    const rightDate = rightNotice.publishedAt ?? rightNotice.createdAt;
    return rightDate.localeCompare(leftDate);
  });
}

function TickerItem({ notice }: { notice: PublicNotice }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[notice.severity]}`}
      />
      {notice.title}
    </span>
  );
}

/**
 * Sticky top ticker (rendered inside the sticky SiteHeader) that marquees every
 * published notice. The track holds the list twice and translates -50% so the
 * loop is seamless; speed scales with the number of notices so per-item pace is
 * steady. The "See all" link sits outside the marquee so it stays clickable.
 */
export function AnnouncementRibbon() {
  const notices = useNotices();
  if (notices === null || notices.length === 0) return null;

  const tickerNotices = sortForTicker(notices);
  const animationDuration = `${Math.max(24, tickerNotices.length * 9)}s`;

  return (
    <div className="bg-rgs-red text-white">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4">
        <span aria-hidden="true" className="shrink-0 py-2 text-sm">
          📢
        </span>
        <div className="relative flex-1 overflow-hidden py-2">
          <div
            className="rgs-marquee flex w-max gap-10 whitespace-nowrap text-sm font-medium"
            style={{ animationDuration }}
          >
            {tickerNotices.map((notice) => (
              <TickerItem key={notice.noticeId} notice={notice} />
            ))}
            {/* duplicate for a seamless loop */}
            {tickerNotices.map((notice) => (
              <TickerItem key={`${notice.noticeId}-loop`} notice={notice} />
            ))}
          </div>
        </div>
        <Link
          href="/notices/"
          className="shrink-0 border-l border-white/30 py-2 pl-4 text-xs font-semibold underline decoration-white/60 underline-offset-2 hover:decoration-white"
        >
          See all →
        </Link>
      </div>
    </div>
  );
}
