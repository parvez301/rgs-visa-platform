import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { getCountryProduct, listActiveProducts } from "@rgs/shared";
import {
  COUNTRY_CONTENT,
  DOC_TYPE_LABELS,
  countryCodeFromSlug,
} from "@/lib/countryContent";
import { applyUrl, formatInr } from "@/lib/site";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { GetByDate } from "@/components/GetByDate";
import { CountryCard } from "@/components/CountryCard";

export function generateStaticParams() {
  return Object.values(COUNTRY_CONTENT).map((content) => ({ slug: content.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const countryProduct = getCountryProduct(countryCodeFromSlug(slug));
  const content = COUNTRY_CONTENT[countryProduct.countryCode]!;
  return {
    title: `${content.heroTagline} — price, documents & apply online | Rays Global Services`,
    description: `${countryProduct.countryName} visa for Indian passport holders: ${formatInr(countryProduct.governmentFeeInr + countryProduct.serviceFeeInr)} all-in, ${countryProduct.processingDays} working days. Apply online with RGS.`,
  };
}

export default async function CountryVisaPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const countryCode = countryCodeFromSlug(slug);
  const countryProduct = getCountryProduct(countryCode);
  const content = COUNTRY_CONTENT[countryCode]!;
  const totalFee = countryProduct.governmentFeeInr + countryProduct.serviceFeeInr;
  const otherProducts = listActiveProducts()
    .filter((product) => product.countryCode !== countryCode)
    .slice(0, 4);

  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="relative">
          <div className="relative h-[340px] md:h-[420px] overflow-hidden">
            <Image
              src={`/countries/${countryCode.toLowerCase()}.jpg`}
              alt={countryProduct.countryName}
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/40 to-ink/20" />
            <div className="absolute inset-0 flex items-end">
              <div className="mx-auto max-w-6xl px-4 pb-10 w-full">
                <p className="mrz text-xs text-white/70 mb-2">
                  {content.flagEmoji} {countryProduct.countryCode} ·{" "}
                  {countryProduct.visaType === "E_VISA" ? "E-visa" : "Assisted visa"}
                </p>
                <h1 className="text-3xl md:text-5xl font-bold text-white max-w-2xl">
                  {content.heroTagline}
                </h1>
                <p className="mt-3 inline-block rounded-full bg-paper/95 px-4 py-1.5 text-sm font-semibold">
                  <GetByDate processingDays={countryProduct.processingDays} />
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 py-12 grid lg:grid-cols-[1fr_360px] gap-10 items-start">
          <div className="space-y-12">
            <section>
              <p className="text-lg text-ink-soft leading-relaxed">{content.intro}</p>
              <dl className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  ["Visa type", countryProduct.visaType === "E_VISA" ? "E-Visa" : "Sticker"],
                  ["Stay", `${countryProduct.stayDays} days`],
                  ["Validity", `${countryProduct.validityDays} days`],
                  ["Entry", countryProduct.entry === "SINGLE" ? "Single" : "Multiple"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line p-4">
                    <dt className="mrz text-[10px] text-ink-soft">{label}</dt>
                    <dd className="mt-1 font-bold">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4">Documents you&apos;ll need</h2>
              <ul className="space-y-3">
                {countryProduct.docsRequired.map((docType) => (
                  <li
                    key={docType}
                    className="flex items-center gap-3 rounded-xl border border-line p-4"
                  >
                    <span
                      className="h-2 w-2 rounded-full bg-rgs-red shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-medium">{DOC_TYPE_LABELS[docType]}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-soft">
                Upload photos or scans from your phone — our team checks
                everything against government guidelines before submission.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4">
                Why {countryProduct.countryName} applications get rejected
              </h2>
              <div className="space-y-4">
                {content.rejectionReasons.map((rejectionReason) => (
                  <div key={rejectionReason.title} className="rounded-xl bg-mist p-5">
                    <h3 className="font-bold mb-1">{rejectionReason.title}</h3>
                    <p className="text-sm text-ink-soft leading-relaxed">
                      {rejectionReason.detail}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4">Frequently asked questions</h2>
              <div className="space-y-3">
                {content.faqs.map((faq) => (
                  <details
                    key={faq.question}
                    className="group rounded-xl border border-line p-5"
                  >
                    <summary className="cursor-pointer font-semibold list-none flex justify-between items-center gap-4">
                      {faq.question}
                      <span
                        className="text-rgs-red group-open:rotate-45 transition-transform text-xl leading-none"
                        aria-hidden="true"
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-3 text-sm text-ink-soft leading-relaxed">{faq.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          </div>

          {/* Sticky price card */}
          <aside className="lg:sticky lg:top-28 rounded-2xl border border-line bg-paper p-6 shadow-[0_16px_48px_rgb(23_25_31/0.10)]">
            <p className="mrz text-xs text-ink-soft">Total per traveller</p>
            <p className="mt-1 text-4xl font-bold font-display">{formatInr(totalFee)}</p>
            <dl className="mt-4 space-y-2 border-t border-dashed border-line pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-soft">Government fee</dt>
                <dd className="font-medium">{formatInr(countryProduct.governmentFeeInr)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-soft">RGS service fee</dt>
                <dd className="font-medium">{formatInr(countryProduct.serviceFeeInr)}</dd>
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
        </div>

        <section className="mx-auto max-w-6xl px-4 pb-16">
          <h2 className="text-2xl font-bold mb-6">Other destinations</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {otherProducts.map((otherProduct) => (
              <CountryCard key={otherProduct.productCode} countryProduct={otherProduct} />
            ))}
          </div>
          <p className="mt-8 text-center">
            <Link href="/#destinations" className="font-semibold text-rgs-red hover:underline">
              See all destinations →
            </Link>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
