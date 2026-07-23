import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ContactForm } from "@/components/ContactForm";
import {
  CONTACT_EMAIL,
  CONTACT_PHONE,
  CONTACT_PHONE_HREF,
  OFFICE_ADDRESS,
} from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact Us | Rays Global Services",
  description:
    "Visit us at Bhikaji Cama Place, New Delhi, call +91-9818067432 or send an enquiry — visa, study abroad, passport, attestation and travel services.",
};

export default function ContactPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="speedlines border-b border-line">
          <div className="mx-auto max-w-6xl px-4 py-14 md:py-20">
            <p className="mrz text-xs text-rgs-red mb-3">Contact</p>
            <h1 className="text-4xl md:text-5xl font-bold">Talk to a human</h1>
            <p className="mt-4 max-w-xl text-lg text-ink-soft">
              Call, email, walk in, or send an enquiry — a consultant, not a
              bot, gets back to you.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-4 py-14 grid lg:grid-cols-[380px_1fr] gap-12 items-start">
          <div className="space-y-6">
            <div className="rounded-2xl border border-line p-6">
              <p className="mrz text-xs text-rgs-red mb-2">Office</p>
              <p className="leading-relaxed">{OFFICE_ADDRESS}</p>
              <a
                className="mt-3 inline-block text-sm font-semibold text-rgs-red hover:underline"
                href="https://maps.google.com/?q=Ansal+Chamber+II+Bhikaji+Cama+Place+New+Delhi"
                target="_blank"
                rel="noreferrer"
              >
                Open in Google Maps →
              </a>
            </div>
            <div className="rounded-2xl border border-line p-6">
              <p className="mrz text-xs text-rgs-red mb-2">Phone</p>
              <a href={CONTACT_PHONE_HREF} className="font-display text-2xl font-bold hover:text-rgs-red">
                {CONTACT_PHONE}
              </a>
              <p className="mt-1 text-sm text-ink-soft">Mon–Sat, 10am–7pm IST</p>
            </div>
            <div className="rounded-2xl border border-line p-6">
              <p className="mrz text-xs text-rgs-red mb-2">Email</p>
              <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold hover:text-rgs-red">
                {CONTACT_EMAIL}
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-line p-7 md:p-9">
            <h2 className="text-2xl font-bold mb-6">Send an enquiry</h2>
            <ContactForm />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
