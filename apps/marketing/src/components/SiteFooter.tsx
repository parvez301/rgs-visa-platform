import Image from "next/image";
import Link from "next/link";
import {
  CONTACT_EMAIL,
  CONTACT_PHONE,
  CONTACT_PHONE_HREF,
  OFFICE_ADDRESS,
  applyUrl,
} from "@/lib/site";

export function SiteFooter() {
  return (
    <footer id="contact" className="bg-ink text-white/80">
      <div className="mx-auto max-w-6xl px-4 py-14 grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Image
            src="/brand/rgs-logo.png"
            alt="Rays Global Services"
            width={180}
            height={27}
            className="brightness-0 invert opacity-90"
          />
          <p className="mt-4 max-w-sm text-sm leading-relaxed">
            For over 15 years, RGS has been a trusted name in visas, study
            abroad and travel — now with a fully online application portal.
          </p>
          <p className="mrz mt-6 text-[10px] text-white/40 break-all">
            RAYS&lt;GLOBAL&lt;SERVICES&lt;&lt;NEW&lt;DELHI&lt;&lt;IND&lt;&lt;&lt;&lt;&lt;&lt;
          </p>
        </div>
        <div className="text-sm space-y-2.5">
          <p className="mrz text-xs text-rgs-red mb-3">Visit us</p>
          <p className="leading-relaxed">{OFFICE_ADDRESS}</p>
          <p>
            <a href={CONTACT_PHONE_HREF} className="hover:text-white">
              {CONTACT_PHONE}
            </a>
          </p>
          <p>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        <div className="text-sm space-y-2.5">
          <p className="mrz text-xs text-rgs-red mb-3">Quick links</p>
          <p>
            <Link href="/#destinations" className="hover:text-white">
              Destinations
            </Link>
          </p>
          <p>
            <Link href="/services/" className="hover:text-white">
              Services
            </Link>
          </p>
          <p>
            <Link href="/about/" className="hover:text-white">
              About us
            </Link>
          </p>
          <p>
            <Link href="/contact/" className="hover:text-white">
              Contact
            </Link>
          </p>
          <p>
            <a href={applyUrl()} className="hover:text-white">
              Track your application
            </a>
          </p>
        </div>
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-white/50">
          © {new Date().getFullYear()} Rays Global Services. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
