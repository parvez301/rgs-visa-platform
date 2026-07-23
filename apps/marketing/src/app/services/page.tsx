import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CtaBand } from "@/components/CtaBand";
import { SERVICES_CONTENT } from "@/lib/servicesContent";

export const metadata: Metadata = {
  title: "Our Services | Rays Global Services",
  description:
    "Visa assistance, study abroad consultancy, passport services, attestation, travel insurance, FRRO, air ticketing and customized tours — one office in Delhi for the whole journey.",
};

export default function ServicesIndexPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="speedlines border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 md:py-20">
            <p className="mrz text-xs text-rgs-red mb-3">Our services</p>
            <h1 className="text-4xl md:text-5xl font-bold max-w-2xl">
              One office for the whole journey
            </h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              The visa portal is the newest part of RGS — everything below is
              what we&apos;ve done for walk-in clients in Delhi for 15 years, and
              still do every day.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14">
          <div className="grid sm:grid-cols-2 gap-6">
            {SERVICES_CONTENT.map((service) => (
              <Link
                key={service.slug}
                href={`/services/${service.slug}/`}
                className="group rounded-2xl border border-line p-7 hover:border-rgs-red hover:shadow-[0_16px_48px_rgb(23_25_31/0.10)] transition-all"
              >
                <h2 className="font-display text-xl font-bold mb-2 group-hover:text-rgs-red transition-colors">
                  {service.name}
                </h2>
                <p className="text-ink-soft leading-relaxed">{service.tagline}</p>
                <p className="mrz mt-5 text-xs text-rgs-red">
                  Explore service →
                </p>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <CtaBand />
      <SiteFooter />
    </>
  );
}
