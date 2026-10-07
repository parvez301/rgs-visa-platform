import { fetchBuildCatalog } from "@/lib/buildCatalog";
import { DestinationsGrid } from "./DestinationsGrid";

export async function CountryGrid() {
  const initialProducts = await fetchBuildCatalog();

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
      <DestinationsGrid initialProducts={initialProducts} />
    </section>
  );
}
