import Image from "next/image";
import Link from "next/link";
import {
  CONTACT_EMAIL,
  CONTACT_PHONE,
  CONTACT_PHONE_HREF,
  applyUrl,
} from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-paper/95 backdrop-blur border-b border-line">
      <div className="bg-ink text-white text-xs">
        <div className="mx-auto max-w-6xl px-4 py-1.5 flex items-center justify-between gap-4">
          <p className="mrz truncate">Bhikaji Cama Place · New Delhi</p>
          <p className="flex gap-4 shrink-0">
            <a href={CONTACT_PHONE_HREF} className="hover:text-rgs-red">
              {CONTACT_PHONE}
            </a>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hidden sm:inline hover:text-rgs-red">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-6">
        <Link href="/" aria-label="Rays Global Services home" className="shrink-0">
          <Image
            src="/brand/rgs-logo.png"
            alt="Rays Global Services"
            width={190}
            height={28}
            priority
          />
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-ink-soft">
          <Link href="/#destinations" className="hover:text-ink">
            Destinations
          </Link>
          <Link href="/services/" className="hover:text-ink">
            Services
          </Link>
          <Link href="/about/" className="hover:text-ink">
            About
          </Link>
          <Link href="/notices/" className="hover:text-ink">
            Notices
          </Link>
          <Link href="/contact/" className="hover:text-ink">
            Contact
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <a
            href={applyUrl()}
            className="hidden sm:inline-block text-sm font-medium text-ink hover:text-rgs-red"
          >
            Sign in
          </a>
          <a
            href={applyUrl()}
            className="rounded-full bg-rgs-red px-5 py-2.5 text-sm font-semibold text-white hover:bg-rgs-red-deep transition-colors"
          >
            Start application
          </a>
        </div>
      </div>
    </header>
  );
}
