"use client";

import { useEffect, useState } from "react";
import type { NoticeCategory, NoticeSeverity } from "@rgs/shared";

/** Public projection returned by GET /api/v1/notices (internal fields omitted). */
export interface PublicNotice {
  noticeId: string;
  title: string;
  body: string;
  category: NoticeCategory;
  severity: NoticeSeverity;
  countryCode?: string;
  pinned: boolean;
  publishedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "";
}

function scopeKey(countryCode?: string): string {
  return countryCode ?? "all";
}

// Notices are small and change whenever an admin publishes — we deliberately do
// NOT cache them in sessionStorage (unlike the country catalog), so a freshly
// published or edited notice appears on the next page view. The in-flight map
// only dedupes concurrent fetches for the same scope within one page render
// (e.g. the top ribbon and the home strip both requesting the "all" feed).
const inFlightFetches = new Map<string, Promise<PublicNotice[]>>();

async function fetchNotices(countryCode?: string): Promise<PublicNotice[]> {
  const key = scopeKey(countryCode);
  const existingInFlight = inFlightFetches.get(key);
  if (existingInFlight) return existingInFlight;

  const baseUrl = apiBaseUrl();
  if (!baseUrl) return [];

  const querySuffix =
    countryCode !== undefined ? `?countryCode=${encodeURIComponent(countryCode)}` : "";

  const fetchPromise = fetch(`${baseUrl}/api/v1/notices${querySuffix}`)
    .then(async (response) => {
      if (!response.ok) return [] as PublicNotice[];
      return (await response.json()) as PublicNotice[];
    })
    .catch(() => [] as PublicNotice[])
    .finally(() => {
      inFlightFetches.delete(key);
    });

  inFlightFetches.set(key, fetchPromise);
  return fetchPromise;
}

/** Fetches published notices fresh on every mount (no cross-session cache). */
export function useNotices(countryCode?: string): PublicNotice[] | null {
  const [liveNotices, setLiveNotices] = useState<PublicNotice[] | null>(null);

  useEffect(() => {
    let isMounted = true;
    void fetchNotices(countryCode).then((notices) => {
      if (isMounted) setLiveNotices(notices);
    });
    return () => {
      isMounted = false;
    };
  }, [countryCode]);

  return liveNotices;
}
