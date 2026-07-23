import { REGIONS, type Region } from "@rgs/shared";
import { fetchBuildCatalog } from "@/lib/buildCatalog";
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

/** Flat grid while the catalog is small; region-grouped once it grows. */
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

export async function CountryGrid() {
  const activeProducts = await fetchBuildCatalog();

  return (
    <section id="destinations" className="mx-auto max-w-6xl px-4 py-16 md:py-20">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <p className="mrz text-xs text-rgs-red mb-2">Destinations</p>
          <h2 className="text-3xl md:text-4xl font-bold">Where are you headed?</h2>
        </div>
        <p className="hidden md:block text-sm text-ink-soft max-w-xs">
          Transparent fees, live tracking, and a team that has processed these
          visas for {new Date().getFullYear() - 2011} years.
        </p>
      </div>
      {activeProducts.length <= REGION_GROUPING_THRESHOLD ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {activeProducts.map((countryProduct) => (
            <CountryCard key={countryProduct.productCode} countryProduct={countryProduct} />
          ))}
          <EnquiryCard />
        </div>
      ) : (
        <div className="space-y-10">
          {REGIONS.map((region) => {
            const regionProducts = activeProducts.filter(
              (countryProduct) => countryProduct.region === region,
            );
            if (regionProducts.length === 0) return null;
            return (
              <div key={region}>
                <h3 className="mrz mb-4 text-xs text-ink-soft">{REGION_LABELS[region]}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                  {regionProducts.map((countryProduct) => (
                    <CountryCard
                      key={countryProduct.productCode}
                      countryProduct={countryProduct}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            <EnquiryCard />
          </div>
        </div>
      )}
    </section>
  );
}
