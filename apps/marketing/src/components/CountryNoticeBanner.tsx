"use client";

import { NoticeCard } from "./NoticeCard";
import { useNotices } from "@/lib/useNotices";

export function CountryNoticeBanner({ countryCode }: { countryCode: string }) {
  const notices = useNotices(countryCode);
  if (notices === null || notices.length === 0) return null;

  return (
    <section className="space-y-3">
      <p className="mrz text-[10px] text-ink-soft">Visa updates for this destination</p>
      {notices.map((notice) => (
        <NoticeCard key={notice.noticeId} notice={notice} />
      ))}
    </section>
  );
}
