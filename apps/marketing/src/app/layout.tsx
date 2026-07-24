import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree, Spline_Sans_Mono } from "next/font/google";
import { AnnouncementRibbon } from "@/components/AnnouncementRibbon";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  weight: ["500", "600", "700", "800"],
});

const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
  weight: ["400", "500", "600", "700"],
});

const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Visas for Indians, done properly | Rays Global Services",
  description:
    "Apply online for UAE, Australia, Canada, New Zealand, Tanzania, Uganda, Nigeria and Zambia visas. 15 years of visa expertise in Delhi — now fully online.",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32" },
      { url: "/brand/icon-192.png", sizes: "192x192" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} ${figtree.variable} ${splineMono.variable}`}>
        <AnnouncementRibbon />
        {children}
      </body>
    </html>
  );
}
