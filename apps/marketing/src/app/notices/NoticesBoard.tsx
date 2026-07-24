"use client";

import { useMemo, useState } from "react";
import { NOTICE_CATEGORIES, type NoticeCategory } from "@rgs/shared";
import { NoticeCard } from "@/components/NoticeCard";
import { useLiveCatalog } from "@/lib/useLiveCatalog";
import { useNotices } from "@/lib/useNotices";

export function NoticesBoard() {
  const notices = useNotices();
  const liveCatalog = useLiveCatalog();
  const [selectedCountryCode, setSelectedCountryCode] = useState<string>("ALL");
  const [selectedCategory, setSelectedCategory] = useState<NoticeCategory | "ALL">(
    "ALL",
  );

  const countryOptions = useMemo(() => {
    const options =
      liveCatalog?.map((countryProduct) => ({
        countryCode: countryProduct.countryCode,
        countryName: countryProduct.countryName,
      })) ?? [];
    return options.sort((leftOption, rightOption) =>
      leftOption.countryName.localeCompare(rightOption.countryName),
    );
  }, [liveCatalog]);

  const filteredNotices = useMemo(() => {
    if (!notices) return [];
    return notices.filter((notice) => {
      if (selectedCategory !== "ALL" && notice.category !== selectedCategory) {
        return false;
      }
      if (selectedCountryCode === "ALL") return true;
      return (
        notice.countryCode === undefined ||
        notice.countryCode === selectedCountryCode
      );
    });
  }, [notices, selectedCategory, selectedCountryCode]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-soft">Country</span>
          <select
            className="rounded-xl border border-line bg-paper px-3 py-2 text-sm focus:border-ink/30"
            value={selectedCountryCode}
            onChange={(changeEvent) => setSelectedCountryCode(changeEvent.target.value)}
          >
            <option value="ALL">All countries</option>
            {countryOptions.map((countryOption) => (
              <option key={countryOption.countryCode} value={countryOption.countryCode}>
                {countryOption.countryName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-soft">Category</span>
          <select
            className="rounded-xl border border-line bg-paper px-3 py-2 text-sm focus:border-ink/30"
            value={selectedCategory}
            onChange={(changeEvent) =>
              setSelectedCategory(changeEvent.target.value as NoticeCategory | "ALL")
            }
          >
            <option value="ALL">All categories</option>
            {NOTICE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      </div>

      {notices === null ? (
        <p className="text-ink-soft">Loading updates…</p>
      ) : filteredNotices.length === 0 ? (
        <p className="text-ink-soft">No published updates match these filters.</p>
      ) : (
        <div className="space-y-4">
          {filteredNotices.map((notice) => (
            <NoticeCard key={notice.noticeId} notice={notice} />
          ))}
        </div>
      )}
    </div>
  );
}
