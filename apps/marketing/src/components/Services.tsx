import Link from "next/link";
import { SERVICES_CONTENT } from "@/lib/servicesContent";

export function Services() {
  return (
    <section id="services" className="mx-auto max-w-6xl px-4 py-16 md:py-20">
      <p className="mrz text-xs text-rgs-red mb-2">Beyond visas</p>
      <h2 className="text-3xl md:text-4xl font-bold mb-3">
        One office for the whole journey
      </h2>
      <p className="text-ink-soft max-w-2xl mb-10">
        The visa portal is new — the agency behind it isn&apos;t. Everything we&apos;ve
        done for walk-in clients for 15 years is still here.
      </p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {SERVICES_CONTENT.map((service) => (
          <Link
            key={service.slug}
            href={`/services/${service.slug}/`}
            className="group rounded-2xl border border-line p-5 hover:border-rgs-red transition-colors"
          >
            <h3 className="font-bold mb-1.5 group-hover:text-rgs-red transition-colors">
              {service.shortName}
            </h3>
            <p className="text-sm text-ink-soft leading-relaxed">{service.tagline}</p>
          </Link>
        ))}
      </div>
      <p className="mt-8">
        <Link href="/services/" className="font-semibold text-rgs-red hover:underline">
          Explore all services →
        </Link>
      </p>
    </section>
  );
}
