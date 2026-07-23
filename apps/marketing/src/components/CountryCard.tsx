"use client";

import Image from "next/image";
import Link from "next/link";
import type { CountryProduct } from "@rgs/shared";
import {
  PHOTO_COUNTRY_CODES,
  resolveContent,
  visaTypeLabel,
} from "@/lib/countryContent";
import { formatInr } from "@/lib/site";
import { findLiveProduct, useLiveCatalog } from "@/lib/useLiveCatalog";
import { GetByDate } from "./GetByDate";

function mrzPad(text: string, width: number): string {
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, "<");
  return (clean + "<".repeat(width)).slice(0, width);
}

export function CountryCard({ countryProduct }: { countryProduct: CountryProduct }) {
  const liveCatalog = useLiveCatalog();
  const liveProduct = findLiveProduct(liveCatalog, countryProduct.countryCode);
  const displayProduct = liveProduct ?? countryProduct;

  const content = resolveContent(countryProduct);
  const hasPhoto = PHOTO_COUNTRY_CODES.has(countryProduct.countryCode);

  const totalFee = displayProduct.governmentFeeInr + displayProduct.serviceFeeInr;
  const typeLabel = visaTypeLabel(displayProduct.visaType);

  return (
    <Link
      href={`/visa/${content.slug}/`}
      className="group relative overflow-hidden rounded-2xl border border-line bg-paper hover:shadow-[0_16px_48px_rgb(23_25_31/0.14)] hover:-translate-y-0.5 transition-all"
    >
      <div className="relative aspect-[4/3] overflow-hidden">
        {hasPhoto ? (
          <Image
            src={`/countries/${countryProduct.countryCode.toLowerCase()}.jpg`}
            alt={countryProduct.countryName}
            fill
            sizes="(max-width: 768px) 100vw, 25vw"
            className="object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div
            className="absolute inset-0 bg-gradient-to-br from-ink via-ink/90 to-rgs-red-deep"
            aria-hidden="true"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/10 to-transparent" />
        <div className="absolute bottom-3 left-4 right-4 text-white">
          <p className="text-xl leading-none mb-1">{content.flagEmoji}</p>
          <h3 className="font-display text-lg font-bold leading-tight">
            {countryProduct.countryName}
          </h3>
        </div>
        <p className="absolute top-3 right-3 rounded-full bg-paper/95 px-3 py-1 text-xs font-semibold text-ink">
          <GetByDate processingDays={displayProduct.processingDays} />
        </p>
      </div>
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm text-ink-soft">
            {typeLabel} · {displayProduct.stayDays} days stay
          </p>
          <p className="font-semibold">{formatInr(totalFee)}</p>
        </div>
        <p className="mrz mt-3 border-t border-dashed border-line pt-2 text-[10px] leading-relaxed text-ink-soft/70">
          {mrzPad(`${typeLabel}<${displayProduct.entry}<ENTRY`, 34)}
          <br />
          {mrzPad(
            `${displayProduct.countryCode}<VALID<${displayProduct.validityDays}D<STAY<${displayProduct.stayDays}D`,
            34,
          )}
        </p>
      </div>
    </Link>
  );
}
