import { SiteHeader } from "@/components/SiteHeader";
import { Hero } from "@/components/Hero";
import { CountryGrid } from "@/components/CountryGrid";
import { HowItWorks } from "@/components/HowItWorks";
import { Services } from "@/components/Services";
import { Testimonials } from "@/components/Testimonials";
import { CtaBand } from "@/components/CtaBand";
import { SiteFooter } from "@/components/SiteFooter";

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <CountryGrid />
        <HowItWorks />
        <Services />
        <Testimonials />
        <CtaBand />
      </main>
      <SiteFooter />
    </>
  );
}
