import Image from "next/image";
import Link from "next/link";
import { listActiveProducts } from "@rgs/shared";
import { COUNTRY_CONTENT } from "@/lib/countryContent";
import { YEARS_IN_BUSINESS, applyUrl } from "@/lib/site";

const HERO_CARD_COUNTRIES = [
  { countryCode: "AE", label: "Dubai in 4 days", rotation: "-rotate-6", offset: "top-10 left-0" },
  { countryCode: "NZ", label: "New Zealand", rotation: "rotate-3", offset: "top-0 left-36" },
  { countryCode: "TZ", label: "Tanzania", rotation: "rotate-[9deg]", offset: "top-24 left-64" },
];

export function Hero() {
  const popularProducts = listActiveProducts().slice(0, 4);

  return (
    <section className="speedlines border-b border-line overflow-hidden">
      <div className="mx-auto max-w-6xl px-4 py-16 md:py-24 grid md:grid-cols-[1.15fr_1fr] gap-12 items-center">
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
            Apply online in minutes, upload documents from your phone, and track
            every step until the visa is in your inbox. Backed by{" "}
            {YEARS_IN_BUSINESS} years of visa expertise in Delhi.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={applyUrl()}
              className="rounded-full bg-rgs-red px-7 py-3.5 font-semibold text-white hover:bg-rgs-red-deep transition-colors"
            >
              Start your application
            </a>
            <Link
              href="/#destinations"
              className="rounded-full border border-line bg-paper px-7 py-3.5 font-semibold hover:border-ink transition-colors"
            >
              Browse destinations
            </Link>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {popularProducts.map((countryProduct) => {
              const content = COUNTRY_CONTENT[countryProduct.countryCode];
              if (!content) return null;
              return (
                <Link
                  key={countryProduct.countryCode}
                  href={`/visa/${content.slug}/`}
                  className="rounded-full border border-line bg-paper px-4 py-1.5 text-sm text-ink-soft hover:border-rgs-red hover:text-rgs-red transition-colors"
                >
                  {content.flagEmoji} {countryProduct.countryName}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Tilted travel-photo collage with approval stamp */}
        <div className="relative hidden md:block h-[420px]" aria-hidden="true">
          {HERO_CARD_COUNTRIES.map((heroCard) => {
            const content = COUNTRY_CONTENT[heroCard.countryCode];
            if (!content) return null;
            return (
              <div
                key={heroCard.countryCode}
                className={`absolute ${heroCard.offset} ${heroCard.rotation} w-52 overflow-hidden rounded-2xl border-4 border-paper bg-paper shadow-[0_24px_60px_rgb(23_25_31/0.22)]`}
              >
                <div className="relative aspect-[3/4]">
                  <Image
                    src={`/countries/${heroCard.countryCode.toLowerCase()}.jpg`}
                    alt=""
                    fill
                    sizes="220px"
                    priority
                    className="object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-ink/70 via-transparent to-transparent" />
                  <p className="absolute bottom-2.5 left-3 right-3 text-white text-sm font-semibold">
                    {content.flagEmoji} {heroCard.label}
                  </p>
                </div>
                <p className="mrz px-3 py-2 text-[9px] text-ink-soft/70 truncate">
                  {heroCard.countryCode}&lt;&lt;VISA&lt;APPROVED&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
                </p>
              </div>
            );
          })}
          <div className="stamp absolute bottom-8 right-2 z-10 rounded-lg border-[3px] border-rgs-red bg-paper/85 backdrop-blur-sm px-5 py-3 text-center">
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
