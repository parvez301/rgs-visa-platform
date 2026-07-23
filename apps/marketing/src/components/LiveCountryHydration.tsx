"use client";

import type { CountryProduct, DocType } from "@rgs/shared";
import { DOC_TYPE_LABELS } from "@/lib/countryContent";
import { applyUrl, formatInr } from "@/lib/site";
import { findLiveProduct, useLiveCatalog } from "@/lib/useLiveCatalog";
import { GetByDate } from "./GetByDate";

export function LiveFeeCard({
  countryProduct,
  countryCode,
}: {
  countryProduct: CountryProduct;
  countryCode: string;
}) {
  const liveCatalog = useLiveCatalog();
  const liveProduct = findLiveProduct(liveCatalog, countryCode);
  const displayProduct = liveProduct ?? countryProduct;
  const totalFee = displayProduct.governmentFeeInr + displayProduct.serviceFeeInr;

  return (
    <aside className="lg:sticky lg:top-28 rounded-2xl border border-line bg-paper p-6 shadow-[0_16px_48px_rgb(23_25_31/0.10)]">
      <p className="mrz text-xs text-ink-soft">Total per traveller</p>
      <p className="mt-1 text-4xl font-bold font-display">{formatInr(totalFee)}</p>
      <p className="mt-2 text-sm text-ink-soft">
        <GetByDate processingDays={displayProduct.processingDays} />
      </p>
      <dl className="mt-4 space-y-2 border-t border-dashed border-line pt-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-soft">Government fee</dt>
          <dd className="font-medium">{formatInr(displayProduct.governmentFeeInr)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-soft">RGS service fee</dt>
          <dd className="font-medium">{formatInr(displayProduct.serviceFeeInr)}</dd>
        </div>
      </dl>
      <a
        href={applyUrl(countryCode)}
        className="mt-5 block rounded-full bg-rgs-red px-6 py-3.5 text-center font-semibold text-white hover:bg-rgs-red-deep transition-colors"
      >
        Start application
      </a>
      <p className="mt-3 text-xs text-ink-soft text-center">
        No online payment needed — pay after our team reviews your file.
      </p>
    </aside>
  );
}

export function LiveDocsList({
  countryProduct,
  countryCode,
}: {
  countryProduct: CountryProduct;
  countryCode: string;
}) {
  const liveCatalog = useLiveCatalog();
  const liveProduct = findLiveProduct(liveCatalog, countryCode);
  const docsRequired = (liveProduct?.docsRequired ?? countryProduct.docsRequired) as DocType[];

  return (
    <ul className="space-y-3">
      {docsRequired.map((docType) => (
        <li
          key={docType}
          className="flex items-center gap-3 rounded-xl border border-line p-4"
        >
          <span className="h-2 w-2 rounded-full bg-rgs-red shrink-0" aria-hidden="true" />
          <span className="font-medium">{DOC_TYPE_LABELS[docType]}</span>
        </li>
      ))}
    </ul>
  );
}

export function LiveProcessingBadge({
  countryProduct,
  countryCode,
}: {
  countryProduct: CountryProduct;
  countryCode: string;
}) {
  const liveCatalog = useLiveCatalog();
  const liveProduct = findLiveProduct(liveCatalog, countryCode);
  const processingDays = liveProduct?.processingDays ?? countryProduct.processingDays;
  return <GetByDate processingDays={processingDays} />;
}
