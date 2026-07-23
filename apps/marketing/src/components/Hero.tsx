import Image from "next/image";
import Link from "next/link";
import { listActiveProducts } from "@rgs/shared";
import { COUNTRY_CONTENT } from "@/lib/countryContent";
import { YEARS_IN_BUSINESS, applyUrl } from "@/lib/site";
import { CountrySearch, type SearchableCountry } from "./CountrySearch";

const HERO_CARDS = [
  {
    countryCode: "AE",
    label: "Dubai in 4 days",
    className: "top-8 left-0 -rotate-6 z-10",
  },
  {
    countryCode: "NZ",
    label: "New Zealand",
    className: "top-0 left-44 rotate-2 z-20",
  },
  {
    countryCode: "ZM",
    label: "Victoria Falls",
    className: "top-32 left-[19rem] rotate-[8deg] z-10",
  },
];

export function Hero() {
  const activeProducts = listActiveProducts();
  const searchableCountries: SearchableCountry[] = activeProducts.map((countryProduct) => {
    const content = COUNTRY_CONTENT[countryProduct.countryCode]!;
    return {
      countryCode: countryProduct.countryCode,
      countryName: countryProduct.countryName,
      slug: content.slug,
      flagEmoji: content.flagEmoji,
      totalFeeInr: countryProduct.governmentFeeInr + countryProduct.serviceFeeInr,
      processingDays: countryProduct.processingDays,
    };
  });
  const popularCountries = searchableCountries.slice(0, 4);

  return (
    <section className="speedlines relative border-b border-line overflow-hidden">
      <div
        className="pointer-events-none absolute -right-40 -top-40 h-[560px] w-[560px] rounded-full bg-[radial-gradient(closest-side,rgb(239_50_80/0.07),transparent)]"
        aria-hidden="true"
      />
      <div className="mx-auto max-w-6xl px-4 py-16 md:py-24 grid md:grid-cols-[1.15fr_1fr] gap-14 items-center">
        <div>
          <p className="mrz text-xs text-rgs-red mb-4">
            Visa specialists · New Delhi · Since {new Date().getFullYear() - YEARS_IN_BUSINESS}
          </p>
          <h1 className="text-4xl md:text-6xl font-bold leading-[1.05]">
            Visas for Indians,
            <br />
            done <span className="text-rgs-red">properly</span>.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-soft">
            Search your destination, apply in about 10 minutes, and track every
            step until the visa is in your inbox — backed by{" "}
            {YEARS_IN_BUSINESS} years of visa expertise in Delhi.
          </p>

          <div className="mt-8">
            <CountrySearch countries={searchableCountries} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-soft">Popular:</span>
            {popularCountries.map((searchableCountry) => (
              <Link
                key={searchableCountry.countryCode}
                href={`/visa/${searchableCountry.slug}/`}
                className="rounded-full border border-line bg-paper px-4 py-1.5 text-ink-soft hover:border-rgs-red hover:text-rgs-red transition-colors"
              >
                {searchableCountry.flagEmoji} {searchableCountry.countryName}
              </Link>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-soft">
            <a href={applyUrl()} className="font-semibold text-rgs-red hover:underline">
              Already applied? Track it →
            </a>
            <span className="mrz text-[10px]">15 YRS · DELHI</span>
            <span className="mrz text-[10px]">DOCS CHECKED BY HUMANS</span>
            <span className="mrz text-[10px]">PAY AFTER REVIEW</span>
          </div>
        </div>

        {/* Tilted travel-photo collage with approval stamp */}
        <div className="relative hidden md:block h-[460px]" aria-hidden="true">
          {HERO_CARDS.map((heroCard) => {
            const content = COUNTRY_CONTENT[heroCard.countryCode];
            if (!content) return null;
            return (
              <div
                key={heroCard.countryCode}
                className={`absolute ${heroCard.className} w-56 overflow-hidden rounded-2xl border-4 border-paper bg-paper shadow-[0_24px_60px_rgb(23_25_31/0.22)]`}
              >
                <div className="relative aspect-[3/4]">
                  <Image
                    src={`/countries/${heroCard.countryCode.toLowerCase()}.jpg`}
                    alt=""
                    fill
                    sizes="240px"
                    priority
                    className="object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-ink/70 via-transparent to-transparent" />
                  <p className="absolute bottom-2.5 left-3 right-3 text-white text-sm font-semibold drop-shadow">
                    {content.flagEmoji} {heroCard.label}
                  </p>
                </div>
              </div>
            );
          })}
          <div className="stamp absolute bottom-6 right-0 z-30 rounded-lg border-[3px] border-rgs-red bg-paper/90 backdrop-blur-sm px-5 py-3 text-center shadow-[0_12px_32px_rgb(196_23_58/0.25)]">
            <p className="mrz text-sm font-semibold text-rgs-red leading-tight">
              Visas on time
              <br />
              <span className="text-[10px]">RGS · {YEARS_IN_BUSINESS} years · Delhi</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
