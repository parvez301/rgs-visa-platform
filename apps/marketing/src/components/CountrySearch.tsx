"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { findLiveProduct, useLiveCatalog } from "@/lib/useLiveCatalog";

export interface SearchableCountry {
  countryCode: string;
  countryName: string;
  slug: string;
  flagEmoji: string;
  totalFeeInr: number;
  processingDays: number;
}

export function CountrySearch({ countries }: { countries: SearchableCountry[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const liveCatalog = useLiveCatalog();

  const hydratedCountries = useMemo(() => {
    return countries.map((country) => {
      const liveProduct = findLiveProduct(liveCatalog, country.countryCode);
      if (!liveProduct) return country;
      return {
        ...country,
        totalFeeInr: liveProduct.governmentFeeInr + liveProduct.serviceFeeInr,
        processingDays: liveProduct.processingDays,
      };
    });
  }, [countries, liveCatalog]);

  const matches = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) return hydratedCountries;
    return hydratedCountries.filter(
      (country) =>
        country.countryName.toLowerCase().includes(trimmedQuery) ||
        country.countryCode.toLowerCase() === trimmedQuery,
    );
  }, [hydratedCountries, query]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(pointerEvent: MouseEvent) {
      if (!containerRef.current?.contains(pointerEvent.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function goToCountry(country: SearchableCountry) {
    setIsOpen(false);
    router.push(`/visa/${country.slug}/`);
  }

  function formatInr(amount: number): string {
    return `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
  }

  return (
    <div ref={containerRef} className="relative max-w-xl">
      <div className="flex items-center gap-2 rounded-full border border-line bg-paper py-2 pl-6 pr-2 shadow-[0_12px_40px_rgb(23_25_31/0.10)] focus-within:border-ink/30 transition-colors">
        <svg
          className="h-5 w-5 shrink-0 text-ink-soft"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
        </svg>
        <input
          type="search"
          role="combobox"
          aria-expanded={isOpen}
          aria-label="Search destination country"
          placeholder="Where do you want to go?"
          className="w-full bg-transparent py-2 text-base outline-none placeholder:text-ink-soft/70"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(changeEvent) => {
            setQuery(changeEvent.target.value);
            setIsOpen(true);
          }}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === "ArrowDown") {
              keyEvent.preventDefault();
              setHighlightedIndex((current) => Math.min(current + 1, matches.length - 1));
            } else if (keyEvent.key === "ArrowUp") {
              keyEvent.preventDefault();
              setHighlightedIndex((current) => Math.max(current - 1, 0));
            } else if (keyEvent.key === "Enter") {
              keyEvent.preventDefault();
              const highlighted = matches[highlightedIndex];
              if (highlighted) goToCountry(highlighted);
            } else if (keyEvent.key === "Escape") {
              setIsOpen(false);
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            const highlighted = matches[highlightedIndex] ?? matches[0];
            if (highlighted) goToCountry(highlighted);
          }}
          className="rounded-full bg-rgs-red px-6 py-2.5 text-sm font-semibold text-white hover:bg-rgs-red-deep transition-colors shrink-0"
        >
          Search
        </button>
      </div>

      {isOpen && (
        <ul
          role="listbox"
          className="absolute z-30 mt-2 w-full overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_24px_60px_rgb(23_25_31/0.18)]"
        >
          {matches.map((country, matchIndex) => (
            <li key={country.countryCode} role="option" aria-selected={matchIndex === highlightedIndex}>
              <button
                type="button"
                onMouseEnter={() => setHighlightedIndex(matchIndex)}
                onClick={() => goToCountry(country)}
                className={`flex w-full items-center justify-between gap-3 px-5 py-3 text-left ${
                  matchIndex === highlightedIndex ? "bg-mist" : ""
                }`}
              >
                <span className="flex items-center gap-3">
                  <span className="text-lg" aria-hidden="true">
                    {country.flagEmoji}
                  </span>
                  <span className="font-medium">{country.countryName}</span>
                </span>
                <span className="mrz text-[10px] text-ink-soft">
                  {formatInr(country.totalFeeInr)} · {country.processingDays}D
                </span>
              </button>
            </li>
          ))}
          <li>
            <a
              href="/contact/"
              className="block border-t border-line px-5 py-3 text-sm text-ink-soft hover:bg-mist"
            >
              {matches.length === 0 ? (
                <>
                  Can&apos;t find &ldquo;{query.trim()}&rdquo;? We cover 60+ countries —{" "}
                  <span className="font-semibold text-rgs-red">ask us</span>
                </>
              ) : (
                <>
                  Going somewhere else? We cover 60+ countries —{" "}
                  <span className="font-semibold text-rgs-red">ask us</span>
                </>
              )}
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}
