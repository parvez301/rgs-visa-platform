import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CtaBand } from "@/components/CtaBand";
import { Testimonials } from "@/components/Testimonials";
import { YEARS_IN_BUSINESS } from "@/lib/site";

export const metadata: Metadata = {
  title: "About Us | Rays Global Services",
  description:
    "For over 15 years, Rays Global Services has been a trusted Delhi name in visas, study abroad and travel — now with a fully online visa portal.",
};

const VALUES = [
  {
    title: "Knowledgeable team",
    detail: "Always updated on the latest regulations and best practices.",
  },
  {
    title: "Transparent pricing",
    detail: "No hidden fees — honest and upfront costs, always.",
  },
  {
    title: "Customer-focused",
    detail: "Friendly service tailored to your specific needs, not a script.",
  },
  {
    title: "24/7 support",
    detail: "Assistance whenever and wherever you need it.",
  },
];

export default function AboutPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="speedlines border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 md:py-20">
            <p className="mrz text-xs text-rgs-red mb-3">About us</p>
            <h1 className="text-4xl md:text-5xl font-bold max-w-3xl">
              {YEARS_IN_BUSINESS} years of visas from Bhikaji Cama Place
            </h1>
            <p className="mt-5 max-w-2xl text-lg text-ink-soft leading-relaxed">
              Rays Global Services started as a walk-in visa consultancy in New
              Delhi. Since then we&apos;ve helped thousands of travellers,
              students and families with visas, admissions, tickets and
              everything in between — earning repeat clients who&apos;ve been
              with us for a decade.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14 grid md:grid-cols-2 gap-10">
          <div className="rounded-2xl border border-line p-8">
            <p className="mrz text-xs text-rgs-red mb-3">Our mission</p>
            <p className="font-display text-2xl font-bold leading-snug">
              Simplify travel and empower people to achieve their study and
              travel goals.
            </p>
          </div>
          <div className="rounded-2xl border border-line p-8">
            <p className="mrz text-xs text-rgs-red mb-3">Our vision</p>
            <p className="font-display text-2xl font-bold leading-snug">
              Become a trusted global leader in visa, study abroad and travel
              services — building lasting relationships with our clients.
            </p>
          </div>
        </section>

        <section className="bg-mist border-y border-line">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="text-3xl font-bold mb-8">What we stand for</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {VALUES.map((value) => (
                <div key={value.title} className="rounded-2xl bg-paper border border-line p-6">
                  <h3 className="font-bold mb-2">{value.title}</h3>
                  <p className="text-sm text-ink-soft leading-relaxed">{value.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-14">
          <div className="grid md:grid-cols-2 gap-10 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4">Old-school service, new-school portal</h2>
              <p className="text-ink-soft leading-relaxed mb-4">
                The industry moved online, and so did we — our new visa portal
                lets you apply, upload documents and track progress from your
                phone. What hasn&apos;t changed: a real team in Delhi checks
                every file before it goes anywhere, and a real person answers
                when you call.
              </p>
              <p className="text-ink-soft leading-relaxed">
                Visit us at Ansal Chamber-II, Bhikaji Cama Place — or never
                visit at all. Both work.
              </p>
            </div>
            <div className="rounded-2xl bg-ink p-8 text-white">
              <p className="mrz text-xs text-rgs-red mb-4">RGS by the numbers</p>
              <dl className="grid grid-cols-2 gap-6">
                {[
                  [`${YEARS_IN_BUSINESS}+`, "years in business"],
                  ["60+", "countries covered"],
                  ["8", "countries online today"],
                  ["24/7", "support"],
                ].map(([statValue, statLabel]) => (
                  <div key={statLabel}>
                    <dt className="font-display text-3xl font-bold text-white">{statValue}</dt>
                    <dd className="text-sm text-white/70">{statLabel}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <Testimonials />
      </main>
      <CtaBand />
      <SiteFooter />
    </>
  );
}
