"use client";

import Link from "next/link";
import { NoticeBadge } from "./NoticeBadge";
import { useNotices } from "@/lib/useNotices";

export function HomeNoticesStrip() {
  const notices = useNotices();
  if (notices === null || notices.length === 0) return null;

  const previewNotices = [...notices]
    .sort((leftNotice, rightNotice) => {
      if (leftNotice.pinned !== rightNotice.pinned) {
        return leftNotice.pinned ? -1 : 1;
      }
      const leftDate = leftNotice.publishedAt ?? leftNotice.createdAt;
      const rightDate = rightNotice.publishedAt ?? rightNotice.createdAt;
      return rightDate.localeCompare(leftDate);
    })
    .slice(0, 4);

  return (
    <section className="border-y border-line bg-mist/40">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <p className="mrz text-[10px] text-ink-soft mb-1">Updates</p>
            <h2 className="text-2xl font-bold">Latest visa updates</h2>
          </div>
          <Link
            href="/notices/"
            className="text-sm font-semibold text-rgs-red hover:underline"
          >
            See all updates →
          </Link>
        </div>
        <ul className="grid gap-3 md:grid-cols-2">
          {previewNotices.map((notice) => (
            <li
              key={notice.noticeId}
              className="rounded-2xl border border-line bg-paper px-4 py-3"
            >
              <div className="mb-2">
                <NoticeBadge category={notice.category} severity={notice.severity} />
              </div>
              <p className="font-semibold">{notice.title}</p>
              {notice.pinned && (
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-rgs-red">
                  Pinned
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
