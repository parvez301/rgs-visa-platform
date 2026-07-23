"use client";

import { useEffect, useState } from "react";
import type { CountryProduct } from "@rgs/shared";

const SESSION_STORAGE_KEY = "rgs.liveCountryCatalog";

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "";
}

function readCachedCatalog(): CountryProduct[] | null {
  if (typeof window === "undefined") return null;
  try {
    const rawJson = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawJson) return null;
    return JSON.parse(rawJson) as CountryProduct[];
  } catch {
    return null;
  }
}

function writeCachedCatalog(products: CountryProduct[]): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(products));
  } catch {
    // ignore quota / private mode
  }
}

let inFlightFetch: Promise<CountryProduct[]> | null = null;

async function fetchLiveCatalog(): Promise<CountryProduct[]> {
  const cached = readCachedCatalog();
  if (cached) return cached;

  if (inFlightFetch) return inFlightFetch;

  const baseUrl = apiBaseUrl();
  if (!baseUrl) return [];

  inFlightFetch = fetch(`${baseUrl}/api/v1/config/countries`)
    .then(async (response) => {
      if (!response.ok) return [];
      const products = (await response.json()) as CountryProduct[];
      writeCachedCatalog(products);
      return products;
    })
    .catch(() => [] as CountryProduct[])
    .finally(() => {
      inFlightFetch = null;
    });

  return inFlightFetch;
}

/** Fetches public country config once (sessionStorage-cached). SSG values stay as fallback. */
export function useLiveCatalog(): CountryProduct[] | null {
  const [liveCatalog, setLiveCatalog] = useState<CountryProduct[] | null>(() =>
    readCachedCatalog(),
  );

  useEffect(() => {
    let isMounted = true;
    void fetchLiveCatalog().then((products) => {
      if (isMounted && products.length > 0) setLiveCatalog(products);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  return liveCatalog;
}

export function findLiveProduct(
  liveCatalog: CountryProduct[] | null,
  countryCode: string,
): CountryProduct | undefined {
  return liveCatalog?.find((product) => product.countryCode === countryCode);
}
