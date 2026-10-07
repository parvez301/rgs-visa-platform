"use client";

import { REGIONS, type CountryProduct, type Region } from "@rgs/shared";
import { useLiveCatalog } from "@/lib/useLiveCatalog";
import { CONTACT_EMAIL } from "@/lib/site";
import { CountryCard } from "./CountryCard";

const REGION_LABELS: Record<Region, string> = {
  ASIA: "Asia",
  MIDDLE_EAST: "Middle East",
  EUROPE: "Europe",
  AFRICA: "Africa",
  AMERICAS: "Americas",
  OCEANIA: "Australia & Oceania",
};

const REGION_GROUPING_THRESHOLD = 12;

function EnquiryCard() {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}?subject=Visa enquiry`}
      className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line p-8 text-center hover:border-rgs-red transition-colors"
    >
      <span className="text-3xl" aria-hidden="true">
        🌍
      </span>
      <span className="font-display font-bold">Somewhere else?</span>
      <span className="text-sm text-ink-soft">
        We process visas for 60+ countries. Ask us.
      </span>
    </a>
  );
}

function DestinationCards({ products }: { products: CountryProduct[] }) {
  if (products.length <= REGION_GROUPING_THRESHOLD) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {products.map((countryProduct) => (
          <CountryCard key={countryProduct.productCode} countryProduct={countryProduct} />
        ))}
        <EnquiryCard />
      </div>
    );
  }
  return (
    <div className="space-y-10">
      {REGIONS.map((region) => {
        const regionProducts = products.filter((countryProduct) => countryProduct.region === region);
        if (regionProducts.length === 0) return null;
        return (
          <div key={region}>
            <h3 className="mrz mb-4 text-xs text-ink-soft">{REGION_LABELS[region]}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {regionProducts.map((countryProduct) => (
                <CountryCard key={countryProduct.productCode} countryProduct={countryProduct} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <EnquiryCard />
      </div>
    </div>
  );
}

/** SSG list first; once the public catalog loads, newly enabled countries appear without a rebuild. */
export function DestinationsGrid({ initialProducts }: { initialProducts: CountryProduct[] }) {
  const liveCatalog = useLiveCatalog();
  const products =
    liveCatalog !== null && liveCatalog.length > 0
      ? liveCatalog.filter((countryProduct) => countryProduct.active)
      : initialProducts;

  return <DestinationCards products={products} />;
}
