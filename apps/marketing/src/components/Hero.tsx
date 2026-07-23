import Link from "next/link";
import { listActiveProducts } from "@rgs/shared";
import { COUNTRY_CONTENT } from "@/lib/countryContent";
import { YEARS_IN_BUSINESS, applyUrl } from "@/lib/site";

export function Hero() {
  const popularProducts = listActiveProducts().slice(0, 4);

  return (
    <section className="speedlines border-b border-line">
      <div className="mx-auto max-w-6xl px-4 py-16 md:py-24 grid md:grid-cols-[1.2fr_1fr] gap-12 items-center">
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

        {/* Passport-page composition with rubber stamp */}
        <div className="relative hidden md:block" aria-hidden="true">
          <div className="rounded-2xl border border-line bg-paper p-6 shadow-[0_20px_60px_rgb(23_25_31/0.08)] rotate-1">
            <p className="mrz text-[10px] text-ink-soft mb-3">
              Republic of India · Passport
            </p>
            <div className="space-y-2.5">
              <div className="h-3 w-3/4 rounded bg-mist" />
              <div className="h-3 w-1/2 rounded bg-mist" />
              <div className="h-3 w-2/3 rounded bg-mist" />
            </div>
            <div className="mt-6 border-t border-dashed border-line pt-3">
              <p className="mrz text-[11px] leading-relaxed text-ink-soft break-all">
                P&lt;IND&lt;&lt;RAYS&lt;GLOBAL&lt;SERVICES&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
                <br />
                VISAS&lt;ON&lt;TIME&lt;&lt;DELHI&lt;&lt;{YEARS_IN_BUSINESS}&lt;YEARS&lt;&lt;&lt;&lt;&lt;&lt;&lt;
              </p>
            </div>
          </div>
          <div className="stamp absolute -top-6 right-2 rounded-lg border-[3px] border-rgs-red px-5 py-3 text-center">
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
