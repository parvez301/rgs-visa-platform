import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { fetchBuildCatalog, productFromSlug } from "@/lib/buildCatalog";
import { PHOTO_COUNTRY_CODES, resolveContent } from "@/lib/countryContent";
import { formatInr } from "@/lib/site";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CountryCard } from "@/components/CountryCard";
import {
  LiveDocsList,
  LiveFeeCard,
  LiveProcessingBadge,
} from "@/components/LiveCountryHydration";

export async function generateStaticParams() {
  const buildCatalog = await fetchBuildCatalog();
  return buildCatalog.map((countryProduct) => ({
    slug: resolveContent(countryProduct).slug,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const buildCatalog = await fetchBuildCatalog();
  const countryProduct = productFromSlug(buildCatalog, slug);
  const content = resolveContent(countryProduct);
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
  const buildCatalog = await fetchBuildCatalog();
  const countryProduct = productFromSlug(buildCatalog, slug);
  const countryCode = countryProduct.countryCode;
  const content = resolveContent(countryProduct);
  const otherProducts = buildCatalog
    .filter((product) => product.countryCode !== countryCode)
    .slice(0, 4);

  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="relative">
          <div className="relative h-[340px] md:h-[420px] overflow-hidden">
            {!PHOTO_COUNTRY_CODES.has(countryCode) && (
              <div
                className="absolute inset-0 bg-gradient-to-br from-ink via-ink/90 to-rgs-red-deep"
                aria-hidden="true"
              />
            )}
            {PHOTO_COUNTRY_CODES.has(countryCode) && (
            <Image
              src={`/countries/${countryCode.toLowerCase()}.jpg`}
              alt={countryProduct.countryName}
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
            )}
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
                  <LiveProcessingBadge
                    countryProduct={countryProduct}
                    countryCode={countryCode}
                  />
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
              <LiveDocsList countryProduct={countryProduct} countryCode={countryCode} />
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

          <LiveFeeCard countryProduct={countryProduct} countryCode={countryCode} />
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
