import { CONTACT_EMAIL } from "@/lib/site";

const SERVICES = [
  { name: "Visa assistance", detail: "Tourist, business, work and immigration visas for 60+ countries." },
  { name: "Study abroad", detail: "University admissions, student visas and pre-departure support." },
  { name: "Passport assistance", detail: "New passports, renewals and corrections, handled end to end." },
  { name: "Attestation & legalization", detail: "Document attestation, apostille and embassy legalization." },
  { name: "Travel insurance", detail: "Comprehensive plans that satisfy embassy requirements." },
  { name: "FRRO & Indian e-visa", detail: "Registration and visa services for foreign nationals in India." },
  { name: "Air ticketing", detail: "Fares and itineraries that work with your visa timeline." },
  { name: "Customized tours", detail: "Personalised packages for business and leisure travel." },
];

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
        {SERVICES.map((service) => (
          <a
            key={service.name}
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(service.name + " enquiry")}`}
            className="rounded-2xl border border-line p-5 hover:border-rgs-red transition-colors"
          >
            <h3 className="font-bold mb-1.5">{service.name}</h3>
            <p className="text-sm text-ink-soft leading-relaxed">{service.detail}</p>
          </a>
        ))}
      </div>
    </section>
  );
}
