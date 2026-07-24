import { SiteHeader } from "@/components/SiteHeader";
import { Hero } from "@/components/Hero";
import { HomeLeadForm } from "@/components/HomeLeadForm";
import { CountryGrid } from "@/components/CountryGrid";
import { HowItWorks } from "@/components/HowItWorks";
import { Services } from "@/components/Services";
import { Testimonials } from "@/components/Testimonials";
import { HomeNoticesStrip } from "@/components/HomeNoticesStrip";
import { CtaBand } from "@/components/CtaBand";
import { SiteFooter } from "@/components/SiteFooter";

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <HomeLeadForm />
        <CountryGrid />
        <HowItWorks />
        <Services />
        <Testimonials />
        <HomeNoticesStrip />
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}
