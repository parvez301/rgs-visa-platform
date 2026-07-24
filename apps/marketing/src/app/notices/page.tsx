import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { NoticesBoard } from "./NoticesBoard";

export const metadata: Metadata = {
  title: "Visa updates & notices | Rays Global Services",
  description:
    "Official rule changes, fee updates, and travel notices from Rays Global Services.",
};

export default function NoticesPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <p className="mrz text-[10px] text-ink-soft mb-2">Notice board</p>
        <h1 className="text-3xl md:text-4xl font-bold">Visa updates</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          Rule changes, fee updates, and destination alerts — managed by our team and
          published as soon as they are verified.
        </p>
        <div className="mt-8">
          <NoticesBoard />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
