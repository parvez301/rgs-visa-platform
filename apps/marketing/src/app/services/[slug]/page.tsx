import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { SERVICES_CONTENT, getService } from "@/lib/servicesContent";
import {
  CONTACT_EMAIL,
  CONTACT_PHONE,
  CONTACT_PHONE_HREF,
} from "@/lib/site";

export function generateStaticParams() {
  return SERVICES_CONTENT.map((service) => ({ slug: service.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const service = getService(slug);
  return {
    title: `${service.name} in Delhi | Rays Global Services`,
    description: service.tagline,
  };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const service = getService(slug);
  const otherServices = SERVICES_CONTENT.filter(
    (candidate) => candidate.slug !== slug,
  );

  return (
    <>
      <SiteHeader />
      <main>
        <section className="bg-ink text-white">
          <div className="mx-auto max-w-6xl px-4 py-14 md:py-20">
            <p className="mrz text-xs text-rgs-red mb-3">
              <Link href="/services/" className="hover:underline">
                Services
              </Link>{" "}
              / {service.shortName}
            </p>
            <h1 className="text-4xl md:text-5xl font-bold max-w-3xl text-white">
              {service.name}
            </h1>
            <p className="mt-4 max-w-2xl text-lg text-white/80">{service.tagline}</p>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 py-12 grid lg:grid-cols-[1fr_340px] gap-10 items-start">
          <div className="space-y-12">
            <p className="text-lg text-ink-soft leading-relaxed">{service.description}</p>

            <section>
              <h2 className="text-2xl font-bold mb-5">What&apos;s included</h2>
              <div className="grid sm:grid-cols-2 gap-4">
                {service.offerings.map((offering) => (
                  <div key={offering.title} className="rounded-xl border border-line p-5">
                    <h3 className="font-bold mb-1.5">{offering.title}</h3>
                    <p className="text-sm text-ink-soft leading-relaxed">{offering.detail}</p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-bold mb-4">Why RGS</h2>
              <ul className="space-y-2.5">
                {service.whyRgs.map((reason) => (
                  <li key={reason} className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-rgs-red shrink-0" aria-hidden="true" />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <aside className="lg:sticky lg:top-28 rounded-2xl border border-line p-6 shadow-[0_16px_48px_rgb(23_25_31/0.10)]">
            <p className="mrz text-xs text-ink-soft mb-1">Talk to a consultant</p>
            <p className="font-display text-2xl font-bold">{CONTACT_PHONE}</p>
            <div className="mt-5 space-y-3">
              <a
                href={CONTACT_PHONE_HREF}
                className="block rounded-full bg-rgs-red px-6 py-3 text-center font-semibold text-white hover:bg-rgs-red-deep transition-colors"
              >
                Call now
              </a>
              <a
                href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(service.name + " enquiry")}`}
                className="block rounded-full border border-line px-6 py-3 text-center font-semibold hover:border-ink transition-colors"
              >
                Email us
              </a>
            </div>
            <p className="mt-4 text-xs text-ink-soft text-center">
              Mon–Sat, 10am–7pm · Bhikaji Cama Place, New Delhi
            </p>
          </aside>
        </div>

        <section className="mx-auto max-w-6xl px-4 pb-16">
          <h2 className="text-2xl font-bold mb-6">Other services</h2>
          <div className="flex flex-wrap gap-3">
            {otherServices.map((otherService) => (
              <Link
                key={otherService.slug}
                href={`/services/${otherService.slug}/`}
                className="rounded-full border border-line px-5 py-2.5 text-sm font-medium hover:border-rgs-red hover:text-rgs-red transition-colors"
              >
                {otherService.shortName}
              </Link>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
