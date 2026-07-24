"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useNotices, type PublicNotice } from "@/lib/useNotices";

const DISMISSED_STORAGE_KEY = "rgs.dismissedNotices";

/** A notice earns the top ribbon only if it is pinned or high-severity. */
function isRibbonWorthy(notice: PublicNotice): boolean {
  return notice.pinned || notice.severity === "URGENT" || notice.severity === "IMPORTANT";
}

function severityOrder(notice: PublicNotice): number {
  if (notice.severity === "URGENT") return 0;
  if (notice.severity === "IMPORTANT") return 1;
  return 2;
}

function readDismissed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function AnnouncementRibbon() {
  const notices = useNotices();
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);

  // Read dismissals after mount to avoid a hydration mismatch.
  useEffect(() => setDismissedIds(readDismissed()), []);

  if (notices === null) return null;

  const topNotice = [...notices]
    .filter(isRibbonWorthy)
    .filter((notice) => !dismissedIds.includes(notice.noticeId))
    .sort((leftNotice, rightNotice) => {
      if (leftNotice.pinned !== rightNotice.pinned) return leftNotice.pinned ? -1 : 1;
      const bySeverity = severityOrder(leftNotice) - severityOrder(rightNotice);
      if (bySeverity !== 0) return bySeverity;
      const leftDate = leftNotice.publishedAt ?? leftNotice.createdAt;
      const rightDate = rightNotice.publishedAt ?? rightNotice.createdAt;
      return rightDate.localeCompare(leftDate);
    })[0];

  if (!topNotice) return null;
  const activeNotice = topNotice;

  const isUrgent = activeNotice.severity === "URGENT";
  const barClasses = isUrgent
    ? "bg-rgs-red text-white"
    : "bg-ink text-paper";

  const dismiss = () => {
    const nextDismissed = [...dismissedIds, activeNotice.noticeId];
    setDismissedIds(nextDismissed);
    try {
      window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(nextDismissed));
    } catch {
      // ignore private-mode / quota
    }
  };

  return (
    <div className={barClasses}>
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm">
        <span aria-hidden="true">📢</span>
        <Link
          href="/notices/"
          className="min-w-0 flex-1 truncate font-medium hover:underline"
        >
          {activeNotice.title}
        </Link>
        <Link href="/notices/" className="hidden shrink-0 font-semibold underline sm:inline">
          See all
        </Link>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="shrink-0 rounded-full px-1.5 leading-none opacity-80 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
