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

function cacheKeyForScope(countryCode?: string): string {
  return countryCode ? `rgs.notices.${countryCode}` : "rgs.notices.all";
}

function readCachedNotices(countryCode?: string): PublicNotice[] | null {
  if (typeof window === "undefined") return null;
  try {
    const rawJson = sessionStorage.getItem(cacheKeyForScope(countryCode));
    if (!rawJson) return null;
    return JSON.parse(rawJson) as PublicNotice[];
  } catch {
    return null;
  }
}

function writeCachedNotices(notices: PublicNotice[], countryCode?: string): void {
  try {
    sessionStorage.setItem(cacheKeyForScope(countryCode), JSON.stringify(notices));
  } catch {
    // ignore quota / private mode
  }
}

const inFlightFetches = new Map<string, Promise<PublicNotice[]>>();

async function fetchNotices(countryCode?: string): Promise<PublicNotice[]> {
  const scopeKey = cacheKeyForScope(countryCode);
  const cached = readCachedNotices(countryCode);
  if (cached) return cached;

  const existingInFlight = inFlightFetches.get(scopeKey);
  if (existingInFlight) return existingInFlight;

  const baseUrl = apiBaseUrl();
  if (!baseUrl) return [];

  const querySuffix =
    countryCode !== undefined
      ? `?countryCode=${encodeURIComponent(countryCode)}`
      : "";

  const fetchPromise = fetch(`${baseUrl}/api/v1/notices${querySuffix}`)
    .then(async (response) => {
      if (!response.ok) return [] as PublicNotice[];
      const notices = (await response.json()) as PublicNotice[];
      writeCachedNotices(notices, countryCode);
      return notices;
    })
    .catch(() => [] as PublicNotice[])
    .finally(() => {
      inFlightFetches.delete(scopeKey);
    });

  inFlightFetches.set(scopeKey, fetchPromise);
  return fetchPromise;
}

/** Fetches published notices (sessionStorage-cached per country scope). */
export function useNotices(countryCode?: string): PublicNotice[] | null {
  const [liveNotices, setLiveNotices] = useState<PublicNotice[] | null>(() =>
    readCachedNotices(countryCode),
  );

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
