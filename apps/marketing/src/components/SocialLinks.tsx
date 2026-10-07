import { SOCIAL_LINKS } from "@/lib/site";

type SocialTone = "light" | "dark";

export function SocialLinks({ tone }: { tone: SocialTone }) {
  const linkClass =
    tone === "dark"
      ? "text-white/70 hover:text-white"
      : "text-ink-soft hover:text-rgs-red";

  return (
    <ul className="flex items-center gap-3">
      {SOCIAL_LINKS.map((social) => (
        <li key={social.name}>
          <a
            href={social.href}
            className={linkClass}
            target="_blank"
            rel="noreferrer"
            aria-label={social.name}
          >
            <SocialIcon name={social.name} />
          </a>
        </li>
      ))}
    </ul>
  );
}

function SocialIcon({ name }: { name: (typeof SOCIAL_LINKS)[number]["name"] }) {
  const common = {
    viewBox: "0 0 24 24",
    className: "h-4 w-4",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  if (name === "Facebook") {
    return (
      <svg {...common}>
        <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
      </svg>
    );
  }
  if (name === "Instagram") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "X") {
    return (
      <svg {...common}>
        <path d="M4 4l16 16M20 4L4 20" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M22.5 8.2a3 3 0 0 0-2.1-2.1C18.6 5.6 12 5.6 12 5.6s-6.6 0-8.4.5A3 3 0 0 0 1.5 8.2 28 28 0 0 0 1 12a28 28 0 0 0 .5 3.8 3 3 0 0 0 2.1 2.1c1.8.5 8.4.5 8.4.5s6.6 0 8.4-.5a3 3 0 0 0 2.1-2.1A28 28 0 0 0 23 12a28 28 0 0 0-.5-3.8z" />
      <path d="M10 15.2V8.8L16 12l-6 3.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}
