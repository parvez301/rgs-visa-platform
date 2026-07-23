import { listActiveProducts } from "@rgs/shared";
import { CONTACT_EMAIL } from "@/lib/site";
import { CountryCard } from "./CountryCard";

export function CountryGrid() {
  const activeProducts = listActiveProducts();

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {activeProducts.map((countryProduct) => (
          <CountryCard key={countryProduct.productCode} countryProduct={countryProduct} />
        ))}
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
      </div>
    </section>
  );
}
